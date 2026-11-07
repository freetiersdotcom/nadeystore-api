// =============================================================================
// Costs and profit: private costs, frozen on order lines, CSV, report maths, access.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct, seedEmailConfig, mockFetch } from './setup';
import { roleCanRequest } from '../auth/permissions';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let publicKey = ''; let ip = 0; let restore = () => {};
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.110.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const setCost = (sku: string, cost: number | null) => call(`/v1/costs/${sku}`, { method: 'PUT', json: { cost_cents: cost } });
const today = () => new Date().toISOString().slice(0, 10);
const report = async (q = '') => j(await call(`/v1/profit?from=${today()}&to=${today()}${q}`));
const xof = (d: any) => d.currencies.find((c: any) => c.currency === 'XOF');
let a = ''; let b = '';

/** A counter sale, paid in full. */
async function sale(items: { sku: string; qty: number }[], method = 'cash') {
  const total = (await Promise.all(items.map(async (i) => (await db().query<any>(`SELECT price_cents FROM variants WHERE sku = ?`, [i.sku]))[0].price_cents * i.qty))).reduce((x, y) => x + y, 0);
  const r = await call('/v1/orders/manual', { json: { items, payment: { amount_cents: total, method } } });
  return (await j(r)) as any;
}

beforeEach(async () => {
  const d = db();
  for (const t of ['refunds', 'order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'customer_addresses', 'customers', 'inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) { try { await d.run(`DELETE FROM ${t}`); } catch { /* absent */ } }
  await d.run(`DELETE FROM config WHERE key IN ('profit_fees', 'email', 'shipping')`);
  await d.run(`DELETE FROM audit_log WHERE action LIKE 'costs.%'`);
  const k = await seedApiKeys(d); adminKey = k.adminKey; publicKey = (k as any).publicKey ?? '';
  a = (await seedProduct(d, { price_cents: 10000, on_hand: 50 })).sku; b = (await seedProduct(d, { price_cents: 5000, on_hand: 50 })).sku;
  await d.run(`UPDATE variants SET currency = 'XOF'`);
  restore = mockFetch(() => new Response('{}', { status: 200 }));
});
afterEach(() => restore());

describe('costs: setting and privacy', () => {
  it('sets, lists, clears and validates costs', async () => {
    expect((await setCost(a, 6000)).status).toBe(200);
    let l = await j(await call('/v1/costs')); expect(l.items.find((x: any) => x.sku === a)).toMatchObject({ cost_cents: 6000, price_cents: 10000, currency: 'XOF' });
    expect(l.items.find((x: any) => x.sku === b).cost_cents).toBeNull();
    expect((await setCost(a, null)).status).toBe(200); l = await j(await call('/v1/costs')); expect(l.items.find((x: any) => x.sku === a).cost_cents).toBeNull();
    expect((await setCost(a, -1)).status).toBe(400); expect((await call(`/v1/costs/${a}`, { method: 'PUT', json: { cost_cents: 1.5 } })).status).toBe(400);
    expect((await setCost('NOPE', 1)).status).toBe(404);
  });
  it('costs never appear in the public catalog, nor in an order response', async () => {
    await setCost(a, 6000);
    const cat = await (await call('/v1/catalog/products', { key: publicKey || adminKey })).text(); expect(cat).not.toMatch(/cost/i);
    const o = await call('/v1/orders/manual', { json: { items: [{ sku: a, qty: 1 }], payment: { amount_cents: 10000, method: 'cash' } } });
    expect(await o.text()).not.toMatch(/cost_cents/);
    const list = await (await call('/v1/orders')).text(); expect(list).not.toMatch(/cost_cents/);
  });
  it('is for owner and manager: staff, no key and public keys are refused', async () => {
    expect(roleCanRequest('manager', 'GET', '/v1/profit').ok).toBe(true); expect(roleCanRequest('owner', 'PUT', '/v1/costs/X').ok).toBe(true);
    for (const p of ['/v1/profit', '/v1/costs', '/v1/costs/export.csv', '/v1/profit/fees']) expect(roleCanRequest('staff', 'GET', p).ok).toBe(false);
    expect((await call('/v1/profit', { key: null })).status).toBe(401);
    if (publicKey) expect([401, 403]).toContain((await call('/v1/costs', { key: publicKey })).status);
  });
});

describe('costs: frozen on the order line', () => {
  it('a later cost change does not rewrite an earlier sale; an unknown cost stays unknown', async () => {
    await setCost(a, 6000);
    await call('/v1/orders/manual', { json: { items: [{ sku: a, qty: 2 }, { sku: b, qty: 1 }], payment: { amount_cents: 25000, method: 'cash' } } });
    await setCost(a, 9999); await setCost(b, 1);
    const lines = await db().query<any>(`SELECT sku, cost_cents FROM order_items`);
    expect(lines.find((l) => l.sku === a).cost_cents).toBe(6000); expect(lines.find((l) => l.sku === b).cost_cents).toBeNull();
  });
  it('the test-order route freezes costs too', async () => {
    await setCost(a, 4000);
    expect((await call('/v1/orders/test', { json: { customer_email: 't@x.test', items: [{ sku: a, qty: 1 }] } })).status).toBe(200);
    expect((await db().query<any>(`SELECT cost_cents FROM order_items`))[0].cost_cents).toBe(4000);
  });
});

describe('costs: CSV', () => {
  it('exports in major units and imports all or nothing', async () => {
    await setCost(a, 6000);
    const csv = await (await call('/v1/costs/export.csv')).text(); expect(csv).toContain('sku,product,variant,currency,price,cost'); expect(csv).toContain(',XOF,10000,6000');
    const bad = await call('/v1/costs/import', { json: { text: `sku,cost\n${a},7000\nNOPE,1\n${b},abc\n${a},5` } }); expect(bad.status).toBe(422);
    const bj = await j(bad); expect(bj.problems.map((p: any) => p.line)).toEqual([3, 4, 5]);
    expect((await db().query<any>(`SELECT cost_cents FROM variants WHERE sku = ?`, [a]))[0].cost_cents).toBe(6000);
    expect((await j(await call('/v1/costs/import', { json: { text: `sku;cost\n${a};6 500\n${b};`, dry_run: true } }))).to_update).toBe(2);
    expect((await db().query<any>(`SELECT cost_cents FROM variants WHERE sku = ?`, [a]))[0].cost_cents).toBe(6000);
    const ok = await j(await call('/v1/costs/import', { json: { text: `sku,cost\n${a},6500\n${b},` } })); expect(ok.updated).toBe(2);
    expect((await db().query<any>(`SELECT cost_cents FROM variants WHERE sku = ?`, [a]))[0].cost_cents).toBe(6500);
    expect((await call('/v1/costs/import', { json: { text: `sku,price\n${a},1` } })).status).toBe(422);
  });
  it('EUR costs are in decimals, XOF refuses decimals', async () => {
    await db().run(`UPDATE variants SET currency = 'EUR' WHERE sku = ?`, [b]);
    await call('/v1/costs/import', { json: { text: `sku,cost\n${b},12.50` } }); expect((await db().query<any>(`SELECT cost_cents FROM variants WHERE sku = ?`, [b]))[0].cost_cents).toBe(1250);
    expect((await call('/v1/costs/import', { json: { text: `sku,cost\n${a},12.5` } })).status).toBe(422);
  });
});

describe('profit report', () => {
  it('revenue, cost, margin, coverage', async () => {
    await setCost(a, 6000); await setCost(b, 3000);
    await sale([{ sku: a, qty: 2 }, { sku: b, qty: 1 }]);                 // 25 000 sold, cost 15 000
    const d = await report(); const s = xof(d);
    expect(s).toMatchObject({ orders: 1, revenue_cents: 25000, cost_cents: 15000, margin_cents: 10000, coverage_pct: 100, margin_pct: 40, unknown_orders: 0 });
    expect(d.by_product.find((p: any) => p.sku === a)).toMatchObject({ units: 2, revenue_cents: 20000, cost_cents: 12000, margin_cents: 8000 });
    expect(d.by_day[0]).toMatchObject({ revenue_cents: 25000, margin_cents: 10000 });
  });
  it('orders with an unknown cost are counted in sales but kept out of the margin', async () => {
    await setCost(a, 6000);                                                // b has no cost
    await sale([{ sku: a, qty: 1 }]); await sale([{ sku: a, qty: 1 }, { sku: b, qty: 1 }]);
    const s = xof(await report());
    expect(s).toMatchObject({ orders: 2, revenue_cents: 25000, unknown_orders: 1, known_orders: 1, known_revenue_cents: 10000, cost_cents: 6000, margin_cents: 4000, coverage_pct: 40 });
  });
  it('discounts reduce revenue, refunds reduce it further (cost is not recovered)', async () => {
    await setCost(a, 6000);
    const o = await sale([{ sku: a, qty: 1 }]);
    await db().run(`UPDATE orders SET discount_amount_cents = 1000 WHERE id = ?`, [o.id ?? o.order?.id ?? (await db().query<any>(`SELECT id FROM orders`))[0].id]);
    expect(xof(await report())).toMatchObject({ revenue_cents: 9000, margin_cents: 3000 });
    const id = (await db().query<any>(`SELECT id FROM orders`))[0].id;
    await db().run(`INSERT INTO refunds (id, order_id, stripe_refund_id, amount_cents, status, source, created_at) VALUES ('r1', ?, 'm1', 4000, 'succeeded', 'manual', ?)`, [id, new Date().toISOString()]);
    expect(xof(await report())).toMatchObject({ revenue_cents: 5000, refunded_cents: 4000, margin_cents: -1000 });
    await db().run(`UPDATE refunds SET status = 'failed'`); expect(xof(await report()).revenue_cents).toBe(9000);
  });
  it('payment fees by method come off the margin', async () => {
    await setCost(a, 6000);
    await sale([{ sku: a, qty: 1 }], 'mobile_money'); await sale([{ sku: a, qty: 1 }], 'cash');
    expect((await call('/v1/profit/fees', { method: 'PUT', json: { fees: { mobile_money: 3 } } })).status).toBe(200);
    const s = xof(await report()); expect(s.fees_cents).toBe(300); expect(s.margin_cents).toBe(8000 - 300);
    expect((await j(await call('/v1/profit/fees'))).methods).toContain('mobile_money');
    expect((await call('/v1/profit/fees', { method: 'PUT', json: { fees: { cash: 101 } } })).status).toBe(400);
  });
  it('period filter, canceled and unpaid orders, validation', async () => {
    await setCost(a, 6000);
    await sale([{ sku: a, qty: 1 }]); await sale([{ sku: a, qty: 1 }]);
    const ids = await db().query<any>(`SELECT id FROM orders ORDER BY created_at`);
    await db().run(`UPDATE orders SET status = 'canceled' WHERE id = ?`, [ids[0].id]);
    expect(xof(await report()).orders).toBe(1);
    await db().run(`UPDATE orders SET paid_at = '2020-01-15T10:00:00.000Z' WHERE id = ?`, [ids[1].id]);
    expect((await report()).currencies).toEqual([]);
    expect(xof(await j(await call('/v1/profit?from=2020-01-01&to=2020-01-31'))).orders).toBe(1);
    await db().run(`UPDATE orders SET paid_at = '2020-01-16 09:00:00' WHERE id = ?`, [ids[1].id]);   // SQL-default format
    expect(xof(await j(await call('/v1/profit?from=2020-01-16&to=2020-01-16'))).orders).toBe(1);
    expect((await call('/v1/profit?from=2020-02-01&to=2020-01-01')).status).toBe(400);
    expect((await call('/v1/profit?from=2018-01-01&to=2020-01-01')).status).toBe(400);
  });
  it('currencies are never mixed', async () => {
    await setCost(a, 6000); await setCost(b, 100);
    await db().run(`UPDATE variants SET currency = 'EUR' WHERE sku = ?`, [b]);
    await sale([{ sku: a, qty: 1 }]); await call('/v1/orders/manual', { json: { items: [{ sku: b, qty: 1 }], currency: 'EUR', payment: { amount_cents: 5000, method: 'cash' } } });
    const d = await report(); expect(d.currencies.map((c: any) => c.currency).sort()).toEqual(['EUR', 'XOF']);
  });
});

describe('profit on one order', () => {
  const oid = async () => (await db().query<any>(`SELECT id FROM orders ORDER BY created_at DESC`))[0].id as string;
  it('shows revenue, cost, fees and margin for a single order, and agrees with the report', async () => {
    await setCost(a, 6000); await setCost(b, 3000);
    await sale([{ sku: a, qty: 2 }, { sku: b, qty: 1 }], 'mobile_money');
    await call('/v1/profit/fees', { method: 'PUT', json: { fees: { mobile_money: 2 } } });
    const o = await j(await call(`/v1/profit/order/${await oid()}`));
    expect(o).toMatchObject({ currency: 'XOF', revenue_cents: 25000, cost_cents: 15000, fees_cents: 500, margin_cents: 9500, margin_pct: 38, complete: true });
    expect(o.lines).toHaveLength(2);
    expect(xof(await report()).margin_cents).toBe(o.margin_cents);
  });
  it('an order with a line without a cost has no margin, but its lines are listed', async () => {
    await setCost(a, 6000);
    await sale([{ sku: a, qty: 1 }, { sku: b, qty: 1 }]);
    const o = await j(await call(`/v1/profit/order/${await oid()}`));
    expect(o).toMatchObject({ complete: false, margin_cents: null, cost_cents: null, revenue_cents: 15000 });
    expect(o.lines.find((l: any) => l.sku === b).cost_cents).toBeNull();
  });
  it('discounts and refunds are applied, an unknown id is 404, and staff are refused', async () => {
    await setCost(a, 6000); await sale([{ sku: a, qty: 1 }]); const id = await oid();
    await db().run(`UPDATE orders SET discount_amount_cents = 1000 WHERE id = ?`, [id]);
    await db().run(`INSERT INTO refunds (id, order_id, stripe_refund_id, amount_cents, status, source, created_at) VALUES ('r2', ?, 'm2', 2000, 'succeeded', 'manual', ?)`, [id, new Date().toISOString()]);
    expect(await j(await call(`/v1/profit/order/${id}`))).toMatchObject({ revenue_cents: 7000, refunded_cents: 2000, discount_cents: 1000, margin_cents: 1000 });
    expect((await call('/v1/profit/order/nope')).status).toBe(404);
    expect((await call(`/v1/profit/order/${id}`, { key: null })).status).toBe(401);
    expect(roleCanRequest('staff', 'GET', `/v1/profit/order/${id}`).ok).toBe(false);
    expect(roleCanRequest('manager', 'GET', `/v1/profit/order/${id}`).ok).toBe(true);
  });
});
