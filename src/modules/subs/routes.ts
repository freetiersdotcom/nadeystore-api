// Admin API of the subscriptions module, mounted at /v1/m/subs.
//   GET    /plans                       every plan with its number of subscribers
//   POST   /plans                       { sku, name, unit: week|month, every_n, price_cents, max_cycles|null }
//   PUT    /plans/:id                   same fields + active   (a price change applies to new subscribers only)
//   DELETE /plans/:id                   only a plan nobody ever subscribed to
//   GET    /subs?status=&q=             subscribers (latest first) and totals
//   GET    /subs/:id                    one subscriber with their renewal orders
//   POST   /subs                        add a subscriber by hand (phone / WhatsApp sale)
//   PATCH  /subs/:id                    { qty?, unit_price_cents?, name?, phone?, note?, locale?, address?, shipping_cents? }
//   POST   /subs/:id/action             { action: pause|resume|skip|cancel }
//   POST   /subs/:id/renew-now          create the next order now (does not wait for the lead time)
//   GET|PUT /settings                   { lead_days, remind_days, grace_days }
//   POST   /run                         do the periodic work now
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db';
import { ApiError, now, uuid, type HonoEnv, type DOStub } from '../../types';
import { audit } from '../../auth/service';
import { resolveContact } from '../../lib/geo';
import { storeBase } from '../../lib/plans';
import { act, addPeriods, closeOpenOrders, createRenewal, createSubscription, getSettings, manageUrl, rememberOrigin, tick, type Plan, type Sub } from './lib';

const app = new Hono<HonoEnv>();
const actor = (c: any) => { const a = c.get('auth'); return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null }; };
async function body<T extends z.ZodTypeAny>(c: any, schema: T): Promise<z.infer<T>> {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
const ctxOf = (c: any) => ({ storeBaseUrl: storeBase(c.env as any), storeName: (c.env as any).STORE_NAME ?? 'Your Store', stub: c.var.db as DOStub, exec: c.executionCtx as ExecutionContext });

const PlanBody = z.object({
  sku: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(80), unit: z.enum(['week', 'month']), every_n: z.number().int().min(1).max(12),
  price_cents: z.number().int().min(0).max(1_000_000_000), max_cycles: z.number().int().min(1).max(120).nullable().optional(), active: z.boolean().optional(),
});

app.get('/plans', async (c) => {
  const db = getDb(c.var.db); await rememberOrigin(db, new URL(c.req.url).origin);
  const items = await db.query(
    `SELECT p.*, v.currency, v.title AS variant_title, pr.title AS product_title,
            (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id) AS subscribers,
            (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id AND s.status = 'active') AS active_subscribers
       FROM sub_plans p LEFT JOIN variants v ON v.sku = p.sku LEFT JOIN products pr ON pr.id = v.product_id ORDER BY p.created_at DESC`);
  return c.json({ items });
});

async function checkSku(db: any, sku: string) {
  const [v] = await db.query(`SELECT v.sku, v.price_cents, v.currency FROM variants v WHERE v.sku = ?`, [sku]);
  if (!v) throw ApiError.invalidRequest(`Unknown SKU: ${sku}`);
  return v;
}

app.post('/plans', async (c) => {
  const b = await body(c, PlanBody); const db = getDb(c.var.db); await checkSku(db, b.sku);
  const id = uuid();
  await db.run(`INSERT INTO sub_plans (id, sku, name, unit, every_n, price_cents, max_cycles, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, b.sku, b.name, b.unit, b.every_n, b.price_cents, b.max_cycles ?? null, b.active === false ? 0 : 1, now()]);
  await audit(db, { action: 'subs.plan.create', target: id, ...actor(c) });
  return c.json({ id }, 201);
});
app.put('/plans/:id', async (c) => {
  const b = await body(c, PlanBody); const db = getDb(c.var.db); await checkSku(db, b.sku);
  const [p] = await db.query(`SELECT id FROM sub_plans WHERE id = ?`, [c.req.param('id')]); if (!p) throw ApiError.notFound('Plan not found');
  await db.run(`UPDATE sub_plans SET sku = ?, name = ?, unit = ?, every_n = ?, price_cents = ?, max_cycles = ?, active = ? WHERE id = ?`, [b.sku, b.name, b.unit, b.every_n, b.price_cents, b.max_cycles ?? null, b.active === false ? 0 : 1, c.req.param('id')]);
  await audit(db, { action: 'subs.plan.update', target: c.req.param('id'), ...actor(c) });
  return c.json({ ok: true });
});
app.delete('/plans/:id', async (c) => {
  const db = getDb(c.var.db); const id = c.req.param('id');
  const [s] = await db.query(`SELECT 1 FROM subscriptions WHERE plan_id = ? LIMIT 1`, [id]);
  if (s) throw ApiError.conflict('This plan has subscribers. Switch it off instead: existing subscribers keep going and nobody new can join.');
  await db.run(`DELETE FROM sub_plans WHERE id = ?`, [id]); await audit(db, { action: 'subs.plan.delete', target: id, ...actor(c) });
  return c.json({ ok: true });
});

const view = (s: any, origin: string | null) => ({ ...s, ship_to: s.ship_to ? JSON.parse(s.ship_to) : null, token: undefined, manage_url: manageUrl(origin, s.token, s.locale === 'en' ? 'en' : 'fr') });

app.get('/subs', async (c) => {
  const db = getDb(c.var.db); const st = await getSettings(db);
  const status = c.req.query('status'); const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const where: string[] = []; const p: unknown[] = [];
  if (status && ['active', 'paused', 'canceled', 'ended'].includes(status)) { where.push('s.status = ?'); p.push(status); }
  if (q) { where.push(`(lower(s.email) LIKE ? OR lower(COALESCE(s.name, '')) LIKE ? OR lower(s.title) LIKE ?)`); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = await db.query<any>(
    `SELECT s.*, (SELECT o.number FROM sub_orders so JOIN orders o ON o.id = so.order_id WHERE so.sub_id = s.id ORDER BY so.created_at DESC LIMIT 1) AS last_order_number,
            (SELECT o.id FROM sub_orders so JOIN orders o ON o.id = so.order_id WHERE so.sub_id = s.id AND so.closed IS NULL LIMIT 1) AS open_order_id
       FROM subscriptions s ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.created_at DESC LIMIT 300`, p);
  const totals = await db.query<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status`);
  return c.json({ items: rows.map((r) => view(r, st.origin)), totals: Object.fromEntries(totals.map((t) => [t.status, t.n])) });
});

app.get('/subs/:id', async (c) => {
  const db = getDb(c.var.db); const st = await getSettings(db);
  const [s] = await db.query<any>(`SELECT * FROM subscriptions WHERE id = ?`, [c.req.param('id')]); if (!s) throw ApiError.notFound('Subscription not found');
  const orders = await db.query(`SELECT so.order_id, so.cycle, so.due_at, so.counted, so.closed, o.number, o.status, o.total_cents, o.amount_paid_cents, o.currency FROM sub_orders so LEFT JOIN orders o ON o.id = so.order_id WHERE so.sub_id = ? ORDER BY so.cycle DESC`, [s.id]);
  return c.json({ ...view(s, st.origin), orders });
});

const Address = z.object({ line1: z.string().trim().min(1).max(200), line2: z.string().trim().max(200).nullable().optional(), city: z.string().trim().min(1).max(100), state: z.string().trim().max(100).nullable().optional(), postal_code: z.string().trim().max(20).nullable().optional(), country: z.string().trim().length(2), phone: z.string().trim().max(30).nullable().optional() });
const shipTo = (a: z.infer<typeof Address>) => { const k = resolveContact(a, { phoneRequired: false }); return { line1: a.line1, line2: a.line2 ?? null, city: a.city, state: a.state ?? null, postal_code: k.postal_code, phone: k.phone, country: k.country }; };

app.post('/subs', async (c) => {
  const b = await body(c, z.object({
    plan_id: z.string().min(1), email: z.string().trim().email().max(200), name: z.string().trim().max(120).nullable().optional(), phone: z.string().trim().max(30).nullable().optional(),
    qty: z.number().int().min(1).max(999).default(1), locale: z.enum(['fr', 'en']).default('fr'), address: Address.optional(), shipping_cents: z.number().int().min(0).optional(), shipping_label: z.string().trim().max(80).nullable().optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), unit_price_cents: z.number().int().min(0).optional(), note: z.string().trim().max(300).nullable().optional(),
  }));
  const db = getDb(c.var.db);
  const [plan] = await db.query<Plan>(`SELECT * FROM sub_plans WHERE id = ?`, [b.plan_id]); if (!plan) throw ApiError.invalidRequest('Unknown plan.');
  const [v] = await db.query<any>(`SELECT v.title, v.currency, p.title AS product_title FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ?`, [plan.sku]); if (!v) throw ApiError.invalidRequest('The product of this plan no longer exists.');
  const title = v.product_title && v.product_title !== v.title ? `${v.product_title} — ${v.title}` : v.title;
  const startMs = b.start_date ? Date.parse(b.start_date + 'T09:00:00Z') : Date.now();
  const { id } = await createSubscription(db, { plan, email: b.email, name: b.name, phone: b.phone, locale: b.locale, qty: b.qty, unit_price_cents: b.unit_price_cents, currency: v.currency ?? 'XOF', title,
    ship_to: b.address ? shipTo(b.address) : null, shipping_cents: b.shipping_cents, shipping_label: b.shipping_label, startMs, note: b.note });
  await audit(db, { action: 'subs.create', target: id, ...actor(c) });
  return c.json({ id }, 201);
});

app.patch('/subs/:id', async (c) => {
  const b = await body(c, z.object({ qty: z.number().int().min(1).max(999).optional(), unit_price_cents: z.number().int().min(0).optional(), name: z.string().trim().max(120).nullable().optional(), phone: z.string().trim().max(30).nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(), locale: z.enum(['fr', 'en']).optional(), address: Address.nullable().optional(), shipping_cents: z.number().int().min(0).optional(), shipping_label: z.string().trim().max(80).nullable().optional() }));
  const db = getDb(c.var.db); const id = c.req.param('id');
  const [s] = await db.query(`SELECT id FROM subscriptions WHERE id = ?`, [id]); if (!s) throw ApiError.notFound('Subscription not found');
  const set: string[] = []; const p: unknown[] = [];
  const put = (col: string, v: unknown) => { set.push(`${col} = ?`); p.push(v); };
  for (const k of ['qty', 'unit_price_cents', 'name', 'phone', 'note', 'locale', 'shipping_cents', 'shipping_label'] as const) if ((b as any)[k] !== undefined) put(k, (b as any)[k]);
  if (b.address !== undefined) put('ship_to', b.address ? JSON.stringify(shipTo(b.address)) : null);
  if (set.length) { put('updated_at', now()); await db.run(`UPDATE subscriptions SET ${set.join(', ')} WHERE id = ?`, [...p, id]); }
  await audit(db, { action: 'subs.update', target: id, ...actor(c) });
  return c.json({ ok: true });
});

async function load(c: any): Promise<Sub> { const [s] = await getDb(c.var.db).query<Sub>(`SELECT * FROM subscriptions WHERE id = ?`, [c.req.param('id')]); if (!s) throw ApiError.notFound('Subscription not found'); return s; }

app.post('/subs/:id/action', async (c) => {
  const b = await body(c, z.object({ action: z.enum(['pause', 'resume', 'skip', 'cancel']) })); const db = getDb(c.var.db); const s = await load(c);
  const r = await act(db, s, b.action); if (!r.ok) throw ApiError.invalidRequest(r.error);
  await audit(db, { action: `subs.${b.action}`, target: s.id, ...actor(c) });
  return c.json({ ok: true });
});

app.post('/subs/:id/renew-now', async (c) => {
  const db = getDb(c.var.db); const s = await load(c);
  if (s.status !== 'active') throw ApiError.invalidRequest('Only an active subscription can be renewed.');
  const r = await createRenewal(db, ctxOf(c), s);
  if ('skipped' in r) throw ApiError.invalidRequest({ stock: 'Not enough stock for this order.', busy: 'An order for this cycle is already waiting for payment.', ended: 'The plan’s cycles are all billed.', unavailable: 'The product is no longer on sale.', no_context: 'Cannot create orders here.' }[r.skipped]);
  await audit(db, { action: 'subs.renew', target: s.id, ...actor(c) });
  return c.json({ order_id: r.order_id });
});

app.get('/settings', async (c) => { const { origin: _o, ...s } = await getSettings(getDb(c.var.db)); return c.json(s); });
app.put('/settings', async (c) => {
  const b = await body(c, z.object({ lead_days: z.number().int().min(0).max(30), remind_days: z.number().int().min(0).max(30), grace_days: z.number().int().min(0).max(60) }));
  await getDb(c.var.db).run(`UPDATE sub_settings SET lead_days = ?, remind_days = ?, grace_days = ? WHERE id = 1`, [b.lead_days, b.remind_days, b.grace_days]);
  return c.json(b);
});
app.post('/run', async (c) => c.json(await tick(getDb(c.var.db), ctxOf(c))));

export const subsAdmin = app;
