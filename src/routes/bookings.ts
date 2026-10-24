import { OpenAPIHono, z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { storeBase } from '../lib/plans';
import {
  bookableSku, listSlots, holdSlot, releaseHold, adminSchedule, adminCancel, sweepAppointments, sendApptEmail,
  cleanRules, isValidTz, DEFAULT_TZ, MAX_RANGE_DAYS, getBookingConfig, type ApptNoticeCtx,
} from '../lib/appointments';

// =============================================================================
// Appointments — HTTP surface
//
//  storefront key
//   GET  /v1/bookings/slots?sku=&from=YYYY-MM-DD&days=14   candidate slots with their availability
//   POST /v1/bookings/hold      { cart_id, sku, start, customer_tz? }   hold a slot for a cart
//   POST /v1/bookings/release   { cart_id, sku? }
//  admin
//   GET  /v1/bookings/services                  service products with their booking setup + variants
//   PUT  /v1/bookings/services/:productId       save the booking setup (weekly hours, durations…)
//   GET  /v1/bookings/agenda?from=&to=&status=  appointments (+ blocked periods)
//   POST /v1/bookings/blocks · DELETE /v1/bookings/blocks/:id
//   POST /v1/bookings/appointments              { order_id, sku?, start, notify? }  book for an existing order
//   PATCH /v1/bookings/appointments/:id         { start, notify? }                  reschedule
//   POST /v1/bookings/appointments/:id/cancel   { notify? }
//   POST /v1/bookings/sweep                     run reminders now
// =============================================================================

export const bookings = new OpenAPIHono<HonoEnv>();
bookings.use('*', authMiddleware);

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
const body = async (c: any) => { try { return await c.req.json(); } catch { return {}; } };
const ctxOf = (c: any): ApptNoticeCtx => ({ storeName: (c.env as any).STORE_NAME ?? 'Your Store', storeBaseUrl: storeBase(c.env as any) });
const iso = (ms: number) => new Date(ms).toISOString();

// ───────────────────────────── storefront ─────────────────────────────

bookings.get('/slots', async (c) => {
  const q = parse(z.object({
    sku: z.string().min(1).max(100),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    days: z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).default(14),
  }), c.req.query());
  const db = getDb(c.var.db);
  const b = await bookableSku(db, q.sku);
  if (!b) return c.json({ bookable: false, slots: [] });
  const fromMs = q.from ? Date.parse(q.from + 'T00:00:00Z') - 86400_000 : Date.now();   // a day of slack: the shop day may start before UTC midnight
  const slots = await listSlots(db, b, Math.max(fromMs, Date.now()), q.days);
  return c.json({
    bookable: true, sku: q.sku, duration_min: b.duration_min, tz: b.cfg.tz,
    lead_hours: b.cfg.lead_hours, horizon_days: b.cfg.horizon_days, slots,
  });
});

bookings.post('/hold', async (c) => {
  const b = parse(z.object({
    cart_id: z.string().min(1), sku: z.string().min(1),
    start: z.string().min(10), customer_tz: z.string().max(64).optional(),
  }), await body(c));
  const db = getDb(c.var.db);
  const tz = b.customer_tz && isValidTz(b.customer_tz) ? b.customer_tz : null;
  return c.json(await holdSlot(db, b.cart_id, b.sku, b.start, tz), 201);
});

bookings.post('/release', async (c) => {
  const b = parse(z.object({ cart_id: z.string().min(1), sku: z.string().optional() }), await body(c));
  await releaseHold(getDb(c.var.db), b.cart_id, b.sku);
  return c.json({ released: true });
});

// ───────────────────────────── admin: services ─────────────────────────────

bookings.get('/services', adminOnly, async (c) => {
  const db = getDb(c.var.db);
  const products = await db.query<any>(
    `SELECT DISTINCT p.id, p.title FROM products p JOIN variants v ON v.product_id = p.id WHERE v.product_type = 'service' ORDER BY p.title`);
  const out = [];
  for (const p of products) {
    const variants = await db.query<any>(`SELECT sku, title FROM variants WHERE product_id = ? AND product_type = 'service' ORDER BY title`, [p.id]);
    out.push({ product_id: p.id, title: p.title, variants, booking: await getBookingConfig(db, p.id) });
  }
  return c.json({ items: out, default_tz: DEFAULT_TZ });
});

const ConfigBody = z.object({
  enabled: z.boolean().default(true),
  tz: z.string().max(64).optional(),
  rules: z.array(z.object({ dow: z.number().int().min(0).max(6), start: z.string(), end: z.string() })).max(60),
  lead_hours: z.number().int().min(0).max(24 * 60).default(24),
  horizon_days: z.number().int().min(1).max(365).default(60),
  buffer_min: z.number().int().min(0).max(480).default(0),
  step_min: z.number().int().min(5).max(480).default(30),
  default_duration_min: z.number().int().min(5).max(24 * 60).default(60),
  durations: z.record(z.number().int().min(5).max(24 * 60)).default({}),
});

bookings.put('/services/:productId', adminOnly, async (c) => {
  const productId = c.req.param('productId');
  const b = parse(ConfigBody, await body(c));
  const db = getDb(c.var.db);
  const [p] = await db.query<any>(`SELECT id FROM products WHERE id = ?`, [productId]);
  if (!p) throw ApiError.notFound('Product not found');
  const tz = b.tz || DEFAULT_TZ;
  if (!isValidTz(tz)) throw ApiError.invalidRequest('Unknown time zone.');
  const rules = cleanRules(b.rules);
  if (b.enabled && rules.length === 0) throw ApiError.invalidRequest('Add at least one weekly opening period (or switch booking off).');
  const skus = new Set((await db.query<any>(`SELECT sku FROM variants WHERE product_id = ?`, [productId])).map((v: any) => v.sku));
  const durations = Object.fromEntries(Object.entries(b.durations).filter(([k]) => skus.has(k)));
  await db.run(
    `INSERT INTO booking_services (product_id, enabled, tz, rules, lead_hours, horizon_days, buffer_min, step_min, default_duration_min, durations, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id) DO UPDATE SET enabled = excluded.enabled, tz = excluded.tz, rules = excluded.rules,
       lead_hours = excluded.lead_hours, horizon_days = excluded.horizon_days, buffer_min = excluded.buffer_min,
       step_min = excluded.step_min, default_duration_min = excluded.default_duration_min, durations = excluded.durations,
       updated_at = excluded.updated_at`,
    [productId, b.enabled ? 1 : 0, tz, JSON.stringify(rules), b.lead_hours, b.horizon_days, b.buffer_min, b.step_min,
     b.default_duration_min, JSON.stringify(durations), now()]);
  return c.json(await getBookingConfig(db, productId));
});

// ───────────────────────────── admin: agenda ─────────────────────────────

bookings.get('/agenda', adminOnly, async (c) => {
  const q = parse(z.object({
    from: z.string().optional(), to: z.string().optional(),
    status: z.enum(['booked', 'canceled', 'all']).default('booked'),
  }), c.req.query());
  const db = getDb(c.var.db);
  const from = q.from ? new Date(q.from).toISOString() : iso(Date.now() - 86400_000);
  const to = q.to ? new Date(q.to).toISOString() : iso(Date.now() + 60 * 86400_000);
  const items = await db.query<any>(
    `SELECT a.id, a.sku, a.title, a.status, a.starts_at, a.ends_at, a.customer_tz, a.order_id, a.reminder_sent_at,
            o.number AS order_number, o.customer_email, o.shipping_name AS customer_name, o.status AS order_status
     FROM appointments a LEFT JOIN orders o ON o.id = a.order_id
     WHERE a.starts_at >= ? AND a.starts_at <= ? AND ${q.status === 'all' ? "a.status IN ('booked','canceled')" : 'a.status = ?'}
     ORDER BY a.starts_at`,
    q.status === 'all' ? [from, to] : [from, to, q.status]);
  const blocks = await db.query<any>(`SELECT * FROM booking_blocks WHERE ends_at >= ? AND starts_at <= ? ORDER BY starts_at`, [from, to]);
  const unscheduled = await db.query<any>(
    `SELECT o.id AS order_id, o.number AS order_number, o.customer_email, o.created_at, o.needs_review, o.review_reason
     FROM orders o WHERE o.service_status = 'to_schedule' AND o.status <> 'canceled' ORDER BY o.created_at DESC LIMIT 50`);
  return c.json({ items, blocks, unscheduled });
});

bookings.post('/blocks', adminOnly, async (c) => {
  const b = parse(z.object({
    starts_at: z.string(), ends_at: z.string(), product_id: z.string().nullable().optional(), note: z.string().max(200).nullable().optional(),
  }), await body(c));
  const s = Date.parse(b.starts_at), e = Date.parse(b.ends_at);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw ApiError.invalidRequest('Invalid period.');
  const id = uuid();
  await getDb(c.var.db).run(
    `INSERT INTO booking_blocks (id, product_id, starts_at, ends_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, b.product_id ?? null, iso(s), iso(e), b.note ?? null, now()]);
  return c.json({ id, starts_at: iso(s), ends_at: iso(e), product_id: b.product_id ?? null, note: b.note ?? null }, 201);
});

bookings.delete('/blocks/:id', adminOnly, async (c) => {
  const r = await getDb(c.var.db).run(`DELETE FROM booking_blocks WHERE id = ?`, [c.req.param('id')]);
  if (r.changes === 0) throw ApiError.notFound('Block not found');
  return c.json({ deleted: true });
});

// ───────────────────────────── admin: appointments ─────────────────────────────

bookings.post('/appointments', adminOnly, async (c) => {
  const b = parse(z.object({ order_id: z.string(), sku: z.string().optional(), start: z.string(), notify: z.boolean().default(true) }), await body(c));
  const db = getDb(c.var.db);
  const { appt } = await adminSchedule(db, { orderId: b.order_id, sku: b.sku, startIso: b.start });
  if (b.notify) c.executionCtx.waitUntil(sendApptEmail(db, appt, 'rescheduled', ctxOf(c)));
  return c.json(appt, 201);
});

bookings.patch('/appointments/:id', adminOnly, async (c) => {
  const b = parse(z.object({ start: z.string(), notify: z.boolean().default(true) }), await body(c));
  const db = getDb(c.var.db);
  const { appt, previousStart } = await adminSchedule(db, { appointmentId: c.req.param('id'), startIso: b.start });
  if (b.notify) c.executionCtx.waitUntil(sendApptEmail(db, appt, 'rescheduled', ctxOf(c), previousStart));
  return c.json(appt);
});

bookings.post('/appointments/:id/cancel', adminOnly, async (c) => {
  const b = parse(z.object({ notify: z.boolean().default(true) }), await body(c));
  const db = getDb(c.var.db);
  const a = await adminCancel(db, c.req.param('id'));
  if (b.notify) c.executionCtx.waitUntil(sendApptEmail(db, a, 'canceled', ctxOf(c)));
  return c.json({ canceled: true });
});

bookings.post('/sweep', adminOnly, async (c) => c.json(await sweepAppointments(getDb(c.var.db), ctxOf(c))));
