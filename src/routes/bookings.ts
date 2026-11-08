import { OpenAPIHono, z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { storeBase } from '../lib/plans';
import {
  bookableSku, listSlots, holdSlot, releaseHold, adminSchedule, adminCancel, sweepAppointments, sendApptEmail,
  cleanRules, isValidTz, DEFAULT_TZ, MAX_RANGE_DAYS, getBookingConfig, listProviders, providersFor, type ApptNoticeCtx,
} from '../lib/appointments';

// =============================================================================
// Appointments — HTTP surface
//
//  storefront key
//   GET  /v1/bookings/slots?sku=&from=YYYY-MM-DD&days=14   candidate slots with their availability
//   POST /v1/bookings/hold      { cart_id, sku, start, customer_tz?, provider? }   hold a slot for a cart (provider id or 'any')
//   POST /v1/bookings/release   { cart_id, sku? }
//  admin
//   GET/POST /v1/bookings/providers · PUT/DELETE /v1/bookings/providers/:id   people who perform services
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
    provider: z.string().max(64).optional(),
  }), c.req.query());
  const db = getDb(c.var.db);
  const b = await bookableSku(db, q.sku);
  if (!b) return c.json({ bookable: false, slots: [] });
  const fromMs = q.from ? Date.parse(q.from + 'T00:00:00Z') - 86400_000 : Date.now();   // a day of slack: the shop day may start before UTC midnight
  const slots = await listSlots(db, b, Math.max(fromMs, Date.now()), q.days, Date.now(), q.provider);
  const providers = (await providersFor(db, b.product_id)).map((p) => ({ id: p.id, name: p.name }));
  return c.json({
    bookable: true, sku: q.sku, duration_min: b.duration_min, tz: b.cfg.tz,
    lead_hours: b.cfg.lead_hours, horizon_days: b.cfg.horizon_days, providers, slots,
  });
});

bookings.post('/hold', async (c) => {
  const b = parse(z.object({
    cart_id: z.string().min(1), sku: z.string().min(1),
    start: z.string().min(10), customer_tz: z.string().max(64).optional(), provider: z.string().max(64).optional(),
  }), await body(c));
  const db = getDb(c.var.db);
  const tz = b.customer_tz && isValidTz(b.customer_tz) ? b.customer_tz : null;
  return c.json(await holdSlot(db, b.cart_id, b.sku, b.start, tz, b.provider), 201);
});

bookings.post('/release', async (c) => {
  const b = parse(z.object({ cart_id: z.string().min(1), sku: z.string().optional() }), await body(c));
  await releaseHold(getDb(c.var.db), b.cart_id, b.sku);
  return c.json({ released: true });
});

// ───────────────────────────── admin: providers ─────────────────────────────

const RuleBody = z.array(z.object({ dow: z.number().int().min(0).max(6), start: z.string(), end: z.string() })).max(60);

bookings.get('/providers', adminOnly, async (c) => {
  const db = getDb(c.var.db);
  const items = [];
  for (const p of await listProviders(db)) {
    const assigned = await db.query<any>(`SELECT product_id FROM booking_service_resources WHERE resource_id = ?`, [p.id]);
    const [n] = await db.query<any>(`SELECT COUNT(*) AS n FROM appointments WHERE resource_id = ? AND status = 'booked' AND starts_at >= ?`, [p.id, now()]);
    items.push({ ...p, product_ids: assigned.map((a: any) => a.product_id), upcoming: Number(n?.n ?? 0) });
  }
  return c.json({ items, default_tz: DEFAULT_TZ });
});

bookings.post('/providers', adminOnly, async (c) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(60), tz: z.string().max(64).nullable().optional(), rules: RuleBody.optional() }), await body(c));
  if (b.tz && !isValidTz(b.tz)) throw ApiError.invalidRequest('Unknown time zone.');
  const db = getDb(c.var.db);
  const [m] = await db.query<any>(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM booking_resources`);
  const id = uuid();
  await db.run(`INSERT INTO booking_resources (id, name, active, position, tz, rules, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)`,
    [id, b.name, Number(m?.n ?? 0), b.tz || null, JSON.stringify(cleanRules(b.rules ?? [])), now()]);
  return c.json((await listProviders(db)).find((p) => p.id === id), 201);
});

bookings.put('/providers/:id', adminOnly, async (c) => {
  const id = c.req.param('id');
  const b = parse(z.object({
    name: z.string().trim().min(1).max(60).optional(), active: z.boolean().optional(),
    tz: z.string().max(64).nullable().optional(), rules: RuleBody.optional(), position: z.number().int().min(0).max(1000).optional(),
  }), await body(c));
  const db = getDb(c.var.db);
  const all = await listProviders(db);
  const cur = all.find((p) => p.id === id);
  if (!cur) throw ApiError.notFound('Provider not found');
  if (b.tz && !isValidTz(b.tz)) throw ApiError.invalidRequest('Unknown time zone.');
  if (b.active === false && cur.active && all.filter((p) => p.active).length <= 1) {
    throw ApiError.conflict('At least one provider must stay active. Add or activate another one first.');
  }
  await db.run(
    `UPDATE booking_resources SET name = ?, active = ?, tz = ?, rules = ?, position = ? WHERE id = ?`,
    [b.name ?? cur.name, (b.active ?? cur.active) ? 1 : 0, b.tz === undefined ? cur.tz : (b.tz || null),
     JSON.stringify(b.rules === undefined ? cur.rules : cleanRules(b.rules)), b.position ?? cur.position, id]);
  return c.json((await listProviders(db)).find((p) => p.id === id));
});

bookings.delete('/providers/:id', adminOnly, async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.var.db);
  const all = await listProviders(db);
  if (!all.some((p) => p.id === id)) throw ApiError.notFound('Provider not found');
  if (all.length <= 1) throw ApiError.conflict('The only provider cannot be deleted.');
  const [used] = await db.query<any>(`SELECT 1 FROM appointments WHERE resource_id = ? LIMIT 1`, [id]);
  if (used) throw ApiError.conflict('This provider has appointments on record. Deactivate them instead.');
  const left = all.filter((p) => p.id !== id && p.active);
  if (left.length === 0) throw ApiError.conflict('At least one provider must stay active.');
  await db.run(`DELETE FROM booking_service_resources WHERE resource_id = ?`, [id]);
  await db.run(`DELETE FROM booking_blocks WHERE resource_id = ?`, [id]);
  await db.run(`DELETE FROM booking_resources WHERE id = ?`, [id]);
  return c.json({ deleted: true });
});

// ───────────────────────────── admin: services ─────────────────────────────

bookings.get('/services', adminOnly, async (c) => {
  const db = getDb(c.var.db);
  const products = await db.query<any>(
    `SELECT DISTINCT p.id, p.title FROM products p JOIN variants v ON v.product_id = p.id WHERE v.product_type = 'service' ORDER BY p.title`);
  const out = [];
  for (const p of products) {
    const variants = await db.query<any>(`SELECT sku, title FROM variants WHERE product_id = ? AND product_type = 'service' ORDER BY title`, [p.id]);
    const assigned = await db.query<any>(`SELECT resource_id FROM booking_service_resources WHERE product_id = ?`, [p.id]);
    out.push({ product_id: p.id, title: p.title, variants, booking: await getBookingConfig(db, p.id), resource_ids: assigned.map((a: any) => a.resource_id) });
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
  resource_ids: z.array(z.string()).max(100).optional(),   // providers for this service; empty = all active ones
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
  if (b.resource_ids) {
    const known = new Set((await listProviders(db)).map((p) => p.id));
    const ids = [...new Set(b.resource_ids)].filter((i) => known.has(i));
    await db.run(`DELETE FROM booking_service_resources WHERE product_id = ?`, [productId]);
    for (const i of ids) await db.run(`INSERT INTO booking_service_resources (product_id, resource_id) VALUES (?, ?)`, [productId, i]);
  }
  return c.json(await getBookingConfig(db, productId));
});

// ───────────────────────────── admin: agenda ─────────────────────────────

bookings.get('/agenda', adminOnly, async (c) => {
  const q = parse(z.object({
    from: z.string().optional(), to: z.string().optional(),
    status: z.enum(['booked', 'canceled', 'all']).default('booked'),
    resource_id: z.string().max(64).optional(),
  }), c.req.query());
  const db = getDb(c.var.db);
  const from = q.from ? new Date(q.from).toISOString() : iso(Date.now() - 86400_000);
  const to = q.to ? new Date(q.to).toISOString() : iso(Date.now() + 60 * 86400_000);
  const items = await db.query<any>(
    `SELECT a.id, a.sku, a.title, a.status, a.starts_at, a.ends_at, a.customer_tz, a.order_id, a.reminder_sent_at,
            a.resource_id, r.name AS resource_name,
            o.number AS order_number, o.customer_email, o.shipping_name AS customer_name, o.shipping_phone AS customer_phone, o.status AS order_status
     FROM appointments a LEFT JOIN orders o ON o.id = a.order_id LEFT JOIN booking_resources r ON r.id = a.resource_id
     WHERE a.starts_at >= ? AND a.starts_at <= ? AND ${q.status === 'all' ? "a.status IN ('booked','canceled')" : 'a.status = ?'}${q.resource_id ? ' AND a.resource_id = ?' : ''}
     ORDER BY a.starts_at`,
    [from, to, ...(q.status === 'all' ? [] : [q.status]), ...(q.resource_id ? [q.resource_id] : [])]);
  const blocks = await db.query<any>(
    `SELECT * FROM booking_blocks WHERE ends_at >= ? AND starts_at <= ?${q.resource_id ? ' AND (resource_id IS NULL OR resource_id = ?)' : ''} ORDER BY starts_at`,
    [from, to, ...(q.resource_id ? [q.resource_id] : [])]);
  const unscheduled = await db.query<any>(
    `SELECT o.id AS order_id, o.number AS order_number, o.customer_email, o.shipping_phone AS customer_phone, o.created_at, o.needs_review, o.review_reason
     FROM orders o WHERE o.service_status = 'to_schedule' AND o.status <> 'canceled' ORDER BY o.created_at DESC LIMIT 50`);
  return c.json({ items, blocks, unscheduled });
});

bookings.post('/blocks', adminOnly, async (c) => {
  const b = parse(z.object({
    starts_at: z.string(), ends_at: z.string(), product_id: z.string().nullable().optional(), resource_id: z.string().max(64).nullable().optional(),
    note: z.string().max(200).nullable().optional(),
  }), await body(c));
  const s = Date.parse(b.starts_at), e = Date.parse(b.ends_at);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw ApiError.invalidRequest('Invalid period.');
  const id = uuid();
  await getDb(c.var.db).run(
    `INSERT INTO booking_blocks (id, product_id, resource_id, starts_at, ends_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, b.product_id ?? null, b.resource_id ?? null, iso(s), iso(e), b.note ?? null, now()]);
  return c.json({ id, starts_at: iso(s), ends_at: iso(e), product_id: b.product_id ?? null, resource_id: b.resource_id ?? null, note: b.note ?? null }, 201);
});

bookings.delete('/blocks/:id', adminOnly, async (c) => {
  const r = await getDb(c.var.db).run(`DELETE FROM booking_blocks WHERE id = ?`, [c.req.param('id')]);
  if (r.changes === 0) throw ApiError.notFound('Block not found');
  return c.json({ deleted: true });
});

// ───────────────────────────── admin: appointments ─────────────────────────────

bookings.post('/appointments', adminOnly, async (c) => {
  const b = parse(z.object({ order_id: z.string(), sku: z.string().optional(), start: z.string(), resource_id: z.string().optional(), notify: z.boolean().default(true) }), await body(c));
  const db = getDb(c.var.db);
  const { appt } = await adminSchedule(db, { orderId: b.order_id, sku: b.sku, startIso: b.start, resourceId: b.resource_id });
  if (b.notify) c.executionCtx.waitUntil(sendApptEmail(db, appt, 'rescheduled', ctxOf(c)));
  return c.json(appt, 201);
});

bookings.patch('/appointments/:id', adminOnly, async (c) => {
  const b = parse(z.object({ start: z.string(), resource_id: z.string().optional(), notify: z.boolean().default(true) }), await body(c));
  const db = getDb(c.var.db);
  const { appt, previousStart } = await adminSchedule(db, { appointmentId: c.req.param('id'), startIso: b.start, resourceId: b.resource_id });
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
