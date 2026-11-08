// → src/routes/profit.ts   (costs.manage: owner, agency and manager; never staff, never a public key)
//   GET  /v1/costs                  every variant with its cost price (cost_cents is in the same minor unit as price_cents)
//   PUT  /v1/costs/:sku             { cost_cents: number | null }
//   GET  /v1/costs/export.csv       sku,product,variant,currency,price,cost  (major units)
//   POST /v1/costs/import           { text, dry_run? }  CSV with a sku and a cost column; checked in full, all or nothing
//   GET  /v1/profit?from=&to=       profit report for orders PAID in that period (UTC dates, default: last 30 days)
//   GET/PUT /v1/profit/fees         payment fee percentage per payment method (optional, default 0)
// Costs are frozen on each order line when the order is created (order_items.cost_cents), so changing a cost
// price never rewrites past profit. Costs are never part of the public catalog responses.
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, type Database } from '../db';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { audit } from '../auth/service';
import { CUSTOM_SKU } from '../lib/custom';
import { ApiError, now, type HonoEnv } from '../types';
import { minorFactor } from '../lib/currency';
import { parseCsvObjects, safeText, toCsv } from '../lib/csv';

const who = (c: any) => { const a = c.get('auth'); return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null }; };
const noStore = (c: any) => c.header('Cache-Control', 'no-store');

// ── Costs ────────────────────────────────────────────────────────────────────
export const costRoutes = new Hono<HonoEnv>();
costRoutes.use('*', authMiddleware, requirePermission('costs.manage'));

costRoutes.get('/', async (c) => {
  noStore(c);
  const db = getDb(c.var.db);
  const items = await db.query(
    `SELECT v.sku, p.title AS product_title, v.title AS variant_title, v.currency, v.price_cents, v.cost_cents, v.product_type, p.status AS product_status
       FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku <> ? ORDER BY p.title, v.title`, [CUSTOM_SKU]);
  return c.json({ items });
});

costRoutes.put('/:sku', async (c) => {
  const sku = c.req.param('sku');
  const b = z.object({ cost_cents: z.number().int().min(0).max(1_000_000_000).nullable() }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) throw ApiError.invalidRequest('cost_cents must be a whole number (or null to clear it)');
  const db = getDb(c.var.db);
  const [v] = await db.query(`SELECT 1 FROM variants WHERE sku = ? AND sku <> ?`, [sku, CUSTOM_SKU]);   // free-hand lines have no catalog cost: set it on the order line
  if (!v) throw ApiError.notFound('No product variant has this SKU.');
  await db.run(`UPDATE variants SET cost_cents = ? WHERE sku = ?`, [b.data.cost_cents, sku]);
  await audit(db, { action: 'costs.set', ...who(c), target: sku });
  return c.json({ sku, cost_cents: b.data.cost_cents });
});

const major = (cents: number | null, cur: string) => (cents == null ? '' : minorFactor(cur) === 1 ? String(cents) : (cents / 100).toFixed(2));

costRoutes.get('/export.csv', async (c) => {
  const db = getDb(c.var.db);
  const rows = await db.query<any>(`SELECT v.sku, p.title AS product, v.title AS variant, v.currency, v.price_cents, v.cost_cents FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku <> ? ORDER BY p.title, v.title`, [CUSTOM_SKU]);
  const csv = toCsv(['sku', 'product', 'variant', 'currency', 'price', 'cost'], rows.map((r) => [safeText(r.sku), safeText(r.product), safeText(r.variant), r.currency, major(r.price_cents, r.currency), major(r.cost_cents, r.currency)]));
  return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="costs.csv"', 'Cache-Control': 'no-store' });
});

function parseCost(raw: string, currency: string): { cents?: number | null; error?: string } {
  if (!raw.trim()) return { cents: null };                          // empty cell = "no cost known"
  const s = raw.replace(/[\s ]/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return { error: `cost "${raw}" is not a number` };
  const n = Number(s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return { error: `cost "${raw}" must be a positive number` };
  const f = minorFactor(currency);
  if (f === 1 && !Number.isInteger(n)) return { error: `${currency} has no decimals, but the cost is "${raw}"` };
  return { cents: Math.round(n * f) };
}

costRoutes.post('/import', async (c) => {
  const b = z.object({ text: z.string().max(2_000_000), dry_run: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) throw ApiError.invalidRequest('Send { "text": "<csv>" }');
  const db = getDb(c.var.db);
  const problems: { line: number; message: string }[] = [];
  let parsed;
  try { parsed = parseCsvObjects(b.data.text, { variant_sku: 'sku', cost_price: 'cost', purchase_price: 'cost', cout: 'cost', coût: 'cost' }); }
  catch (e) { return c.json({ ok: false, problems: [{ line: 1, message: e instanceof Error ? e.message : 'The file could not be read.' }], updated: 0 }, 422); }
  if (!parsed.headers.includes('sku') || !parsed.headers.includes('cost')) return c.json({ ok: false, problems: [{ line: 1, message: 'The file needs a "sku" column and a "cost" column.' }], updated: 0 }, 422);
  if (parsed.rows.length > 5000) return c.json({ ok: false, problems: [{ line: 1, message: 'Too many rows (max 5000).' }], updated: 0 }, 422);
  const variants = await db.query<{ sku: string; currency: string }>(`SELECT sku, currency FROM variants WHERE sku <> ?`, [CUSTOM_SKU]);
  const cur = new Map(variants.map((v) => [v.sku, v.currency])); const seen = new Set<string>();
  const ops: { sku: string; cents: number | null }[] = [];
  for (const r of parsed.rows) {
    const sku = (r.data.sku ?? '').trim();
    if (!sku) { problems.push({ line: r.line, message: 'Missing sku.' }); continue; }
    if (!cur.has(sku)) { problems.push({ line: r.line, message: `Unknown sku "${sku}".` }); continue; }
    if (seen.has(sku)) { problems.push({ line: r.line, message: `sku "${sku}" appears twice.` }); continue; }
    seen.add(sku);
    const p = parseCost(r.data.cost ?? '', cur.get(sku)!);
    if (p.error) problems.push({ line: r.line, message: p.error }); else ops.push({ sku, cents: p.cents ?? null });
  }
  if (problems.length) return c.json({ ok: false, problems: problems.slice(0, 100), updated: 0 }, 422);
  if (b.data.dry_run) return c.json({ ok: true, problems: [], updated: 0, to_update: ops.length });
  for (const o of ops) await db.run(`UPDATE variants SET cost_cents = ? WHERE sku = ?`, [o.cents, o.sku]);
  await audit(db, { action: 'costs.import', ...who(c), meta: { rows: ops.length } });
  return c.json({ ok: true, problems: [], updated: ops.length });
});

// ── Profit ───────────────────────────────────────────────────────────────────
export const profitRoutes = new Hono<HonoEnv>();
profitRoutes.use('*', authMiddleware, requirePermission('costs.manage'));

type Fees = Record<string, number>;
async function getFees(db: Database): Promise<Fees> {
  const [r] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'profit_fees'`);
  try { const j = r?.value ? JSON.parse(r.value) : {}; const out: Fees = {}; for (const [k, v] of Object.entries(j)) if (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100) out[k] = Number(v); return out; } catch { return {}; }
}

profitRoutes.get('/fees', async (c) => {
  noStore(c);
  const db = getDb(c.var.db);
  const methods = (await db.query<{ method: string }>(`SELECT DISTINCT method FROM order_payments`)).map((m) => m.method);
  return c.json({ fees: await getFees(db), methods: [...new Set(['online', 'cash', ...methods])] });
});
profitRoutes.put('/fees', async (c) => {
  const b = z.object({ fees: z.record(z.string().min(1).max(40), z.number().min(0).max(100)) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) throw ApiError.invalidRequest('fees must map a payment method to a percentage between 0 and 100');
  const db = getDb(c.var.db);
  await db.run(`INSERT INTO config (key, value) VALUES ('profit_fees', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(b.data.fees)]);
  await audit(db, { action: 'costs.fees', ...who(c) });
  return c.json({ fees: b.data.fees });
});


type Line = { id?: string; sku: string; title: string; qty: number; unit_price_cents: number; cost_cents: number | null };
/** One order's money, used by the report and by the single-order view so they can never disagree. */
function figures(lines: Line[], discount: number, refund: number, payments: Record<string, number>, fees: Fees) {
  const gross = lines.reduce((n, l) => n + l.qty * l.unit_price_cents, 0);
  const net = Math.max(0, gross - discount - refund);          // what the shop kept of the goods
  const k = gross > 0 ? net / gross : 0;                       // discount and refunds spread over the lines pro rata
  const complete = lines.every((l) => l.cost_cents != null);
  const cost = complete ? lines.reduce((n, l) => n + l.qty * (l.cost_cents as number), 0) : 0;
  let fee = 0; for (const [m, amt] of Object.entries(payments)) fee += Math.round(amt * (fees[m] ?? 0) / 100);
  return { gross, net, k, complete, cost, fee, margin: complete ? net - cost - fee : null };
}

const dateOk = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const MAX_ORDERS = 5000;

// Set (or clear) what one order line cost. This is how a free-hand line gets its cost, and how an order placed before
// costs were entered can be completed. The cost is frozen on that line only: catalog costs are not touched.
profitRoutes.put('/order-line/:id', async (c) => {
  noStore(c);
  const b = z.object({ cost_cents: z.number().int().min(0).max(1_000_000_000).nullable() }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) throw ApiError.invalidRequest('cost_cents must be a whole number (or null to clear it)');
  const db = getDb(c.var.db); const id = c.req.param('id');
  const [l] = await db.query<{ order_id: string }>(`SELECT order_id FROM order_items WHERE id = ?`, [id]);
  if (!l) throw ApiError.notFound('Order line not found.');
  await db.run(`UPDATE order_items SET cost_cents = ? WHERE id = ?`, [b.data.cost_cents, id]);
  await audit(db, { action: 'costs.line', ...who(c), target: id, meta: { order_id: l.order_id } });
  return c.json({ id, cost_cents: b.data.cost_cents });
});

profitRoutes.get('/order/:id', async (c) => {
  noStore(c);
  const db = getDb(c.var.db); const id = c.req.param('id');
  const [o] = await db.query<{ id: string; currency: string; status: string; discount: number; shipping_cents: number }>(
    `SELECT id, currency, status, COALESCE(discount_amount_cents, 0) AS discount, shipping_cents FROM orders WHERE id = ?`, [id]);
  if (!o) throw ApiError.notFound('Order not found.');
  const lines = await db.query<Line>(`SELECT id, sku, title, qty, unit_price_cents, cost_cents FROM order_items WHERE order_id = ?`, [id]);
  const [r] = await db.query<{ n: number | null }>(`SELECT SUM(amount_cents) AS n FROM refunds WHERE order_id = ? AND status NOT IN ('failed', 'canceled')`, [id]);
  const paidBy: Record<string, number> = {};
  for (const p of await db.query<{ method: string; n: number }>(`SELECT method, SUM(amount_cents) AS n FROM order_payments WHERE order_id = ? GROUP BY method`, [id])) paidBy[p.method] = p.n;
  const refund = r?.n ?? 0; const f = figures(lines, o.discount, refund, paidBy, await getFees(db));
  return c.json({ currency: o.currency, revenue_cents: f.net, refunded_cents: refund, discount_cents: o.discount, cost_cents: f.complete ? f.cost : null, fees_cents: f.complete ? f.fee : null,
    margin_cents: f.margin, margin_pct: f.margin != null && f.net > 0 ? Math.round((f.margin / f.net) * 1000) / 10 : null, complete: f.complete,
    lines: lines.map((l) => ({ id: l.id, sku: l.sku, title: l.title, qty: l.qty, unit_price_cents: l.unit_price_cents, cost_cents: l.cost_cents })) });
});

profitRoutes.get('/', async (c) => {
  noStore(c);
  const db = getDb(c.var.db);
  const today = new Date().toISOString().slice(0, 10);
  const to = dateOk(c.req.query('to')) ? c.req.query('to')! : today;
  const from = dateOk(c.req.query('from')) ? c.req.query('from')! : new Date(Date.parse(to + 'T00:00:00Z') - 29 * 86_400_000).toISOString().slice(0, 10);
  if (from > to) throw ApiError.invalidRequest('"from" must not be after "to".');
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw ApiError.invalidRequest('Choose a period of at most one year.');
  const startIso = from + 'T00:00:00.000Z', endIso = new Date(Date.parse(to + 'T00:00:00Z') + 86_400_000).toISOString();
  const startSql = from + ' 00:00:00', endSql = endIso.slice(0, 10) + ' 00:00:00';

  // paid_at is ISO when written by the API and "YYYY-MM-DD HH:MM:SS" when written by a SQL default: accept both.
  const orders = await db.query<{ id: string; currency: string; discount: number; shipping_cents: number; paid_at: string }>(
    `SELECT id, currency, COALESCE(discount_amount_cents, 0) AS discount, shipping_cents, paid_at FROM orders
      WHERE paid_at IS NOT NULL AND status != 'canceled' AND ((paid_at >= ? AND paid_at < ?) OR (paid_at >= ? AND paid_at < ?))
      ORDER BY paid_at LIMIT ${MAX_ORDERS + 1}`, [startIso, endIso, startSql, endSql]);
  const truncated = orders.length > MAX_ORDERS; if (truncated) orders.length = MAX_ORDERS;
  const ids = orders.map((o) => o.id);
  const items = new Map<string, { sku: string; title: string; qty: number; unit_price_cents: number; cost_cents: number | null }[]>();
  const refunded = new Map<string, number>(); const paidBy = new Map<string, Record<string, number>>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400); const q = chunk.map(() => '?').join(',');
    for (const r of await db.query<any>(`SELECT order_id, sku, title, qty, unit_price_cents, cost_cents FROM order_items WHERE order_id IN (${q})`, chunk)) (items.get(r.order_id) ?? items.set(r.order_id, []).get(r.order_id)!).push(r);
    for (const r of await db.query<any>(`SELECT order_id, SUM(amount_cents) AS n FROM refunds WHERE order_id IN (${q}) AND status NOT IN ('failed', 'canceled') GROUP BY order_id`, chunk)) refunded.set(r.order_id, r.n);
    for (const r of await db.query<any>(`SELECT order_id, method, SUM(amount_cents) AS n FROM order_payments WHERE order_id IN (${q}) GROUP BY order_id, method`, chunk)) { const m = paidBy.get(r.order_id) ?? {}; m[r.method] = r.n; paidBy.set(r.order_id, m); }
  }
  const fees = await getFees(db);

  type Cur = { currency: string; orders: number; revenue_cents: number; shipping_cents: number; refunded_cents: number; known_orders: number; unknown_orders: number; known_revenue_cents: number; cost_cents: number; fees_cents: number; margin_cents: number };
  const cur = new Map<string, Cur>(); const prod = new Map<string, { currency: string; sku: string; title: string; units: number; revenue_cents: number; cost_cents: number }>(); const day = new Map<string, { day: string; currency: string; revenue_cents: number; margin_cents: number }>();
  const slot = (cc: string): Cur => cur.get(cc) ?? (cur.set(cc, { currency: cc, orders: 0, revenue_cents: 0, shipping_cents: 0, refunded_cents: 0, known_orders: 0, unknown_orders: 0, known_revenue_cents: 0, cost_cents: 0, fees_cents: 0, margin_cents: 0 }), cur.get(cc)!);

  for (const o of orders) {
    const lines = items.get(o.id) ?? []; if (!lines.length) continue;
    const refund = refunded.get(o.id) ?? 0;
    const f = figures(lines, o.discount, refund, paidBy.get(o.id) ?? {}, fees);
    const { net, k, complete } = f;
    const s = slot(o.currency); s.orders++; s.revenue_cents += net; s.shipping_cents += o.shipping_cents; s.refunded_cents += refund;
    if (!complete) { s.unknown_orders++; }
    for (const l of lines) {
      if (l.cost_cents == null) continue;
      const psku = l.sku === CUSTOM_SKU ? `${CUSTOM_SKU}: ${l.title}` : l.sku;   // free-hand lines are told apart by their description
      const key = `${o.currency}|${psku}`; const p = prod.get(key) ?? { currency: o.currency, sku: psku, title: l.title, units: 0, revenue_cents: 0, cost_cents: 0 };
      p.units += l.qty; p.revenue_cents += Math.round(l.qty * l.unit_price_cents * k); p.cost_cents += l.qty * l.cost_cents; prod.set(key, p);
    }
    if (!complete) continue;                                     // margin only on orders whose every line has a cost
    const cost = f.cost, fee = f.fee, margin = f.margin as number;
    s.known_orders++; s.known_revenue_cents += net; s.cost_cents += cost; s.fees_cents += fee; s.margin_cents += margin;
    const dk = `${o.paid_at.slice(0, 10)}|${o.currency}`; const d = day.get(dk) ?? { day: o.paid_at.slice(0, 10), currency: o.currency, revenue_cents: 0, margin_cents: 0 };
    d.revenue_cents += net; d.margin_cents += margin; day.set(dk, d);
  }
  const currencies = [...cur.values()].map((s) => ({ ...s,
    coverage_pct: s.revenue_cents > 0 ? Math.round((s.known_revenue_cents / s.revenue_cents) * 100) : 100,
    margin_pct: s.known_revenue_cents > 0 ? Math.round((s.margin_cents / s.known_revenue_cents) * 1000) / 10 : null }));
  const by_product = [...prod.values()].map((p) => ({ ...p, margin_cents: p.revenue_cents - p.cost_cents })).sort((a, b) => b.margin_cents - a.margin_cents).slice(0, 200);
  const by_day = [...day.values()].sort((a, b) => a.day.localeCompare(b.day));
  return c.json({ from, to, truncated, currencies, by_product, by_day, fees });
});
