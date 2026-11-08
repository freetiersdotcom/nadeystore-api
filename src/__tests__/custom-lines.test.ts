// =============================================================================
// Free-hand lines: a line with its own description and price in quotes and manual orders.
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
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.114.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const setCost = (sku: string, cost: number | null) => call(`/v1/costs/${sku}`, { method: 'PUT', json: { cost_cents: cost } });
const today = () => new Date().toISOString().slice(0, 10);
const report = async (q = '') => j(await call(`/v1/profit?from=${today()}&to=${today()}${q}`));
const xof = (d: any) => d.currencies.find((c: any) => c.currency === 'XOF');
let a = ''; let pubKey = '';
const manual = (items: any[], amount: number) => call('/v1/orders/manual', { json: { items, currency: 'XOF', payment: { amount_cents: amount, method: 'cash' } } });
const free = (title: string, price: number, qty = 1) => ({ sku: 'CUSTOM', title, unit_price_cents: price, qty });

beforeEach(async () => {
  const d = db();
  await d.run(`DROP TABLE IF EXISTS quotes`);
  for (const t of ['download_tokens', 'refunds', 'order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'customer_addresses', 'customers', 'inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) { try { await d.run(`DELETE FROM ${t}`); } catch { /* absent */ } }
  await d.run(`DELETE FROM config WHERE key IN ('modules', 'email', 'profit_fees')`); await d.run(`DELETE FROM audit_log WHERE action LIKE 'costs.%'`);
  const k = await seedApiKeys(d); adminKey = k.adminKey; pubKey = (k as any).publicKey ?? '';
  a = (await seedProduct(d, { price_cents: 10000, on_hand: 50 })).sku; await d.run(`UPDATE variants SET currency = 'XOF'`);
  restore = mockFetch(() => new Response('{}', { status: 200 }));
});
afterEach(() => restore());

describe('free-hand lines on manual orders', () => {
  it('sell something that is not in the catalog, with its own description and price, and no stock', async () => {
    const r = await manual([free('Custom soap box, engraved', 4500, 2), { sku: a, qty: 1 }], 19000); expect(r.status).toBe(200);
    const lines = await db().query<any>(`SELECT sku, title, qty, unit_price_cents FROM order_items ORDER BY unit_price_cents`);
    expect(lines).toEqual([{ sku: 'CUSTOM', title: 'Custom soap box, engraved', qty: 2, unit_price_cents: 4500 }, { sku: a, title: expect.any(String), qty: 1, unit_price_cents: 10000 }]);
    expect((await db().query<any>(`SELECT total_cents FROM orders`))[0].total_cents).toBe(19000);
    expect(await db().query(`SELECT 1 FROM download_tokens`)).toHaveLength(0);
    expect((await db().query<any>(`SELECT on_hand, reserved FROM inventory WHERE sku = 'CUSTOM'`))[0]).toEqual({ on_hand: 0, reserved: 0 });
  });
  it('needs a description and a price, and reuses one hidden product', async () => {
    expect((await manual([{ sku: 'CUSTOM', qty: 1, unit_price_cents: 100 }], 100)).status).toBe(400);
    expect((await manual([{ sku: 'CUSTOM', qty: 1, title: 'x' }], 0)).status).toBe(400);
    expect((await manual([{ sku: 'CUSTOM', qty: 1, title: '   ', unit_price_cents: 5 }], 5)).status).toBe(400);
    await manual([free('A', 100)], 100); await manual([free('B', 200)], 200);
    expect(await db().query(`SELECT 1 FROM variants WHERE sku = 'CUSTOM'`)).toHaveLength(1);
    expect(await db().query(`SELECT 1 FROM products WHERE id = 'custom-line-product'`)).toHaveLength(1);
  });
  it('a title can also rename a catalog line', async () => {
    await manual([{ sku: a, qty: 1, title: 'Soap, special batch' }], 10000);
    expect((await db().query<any>(`SELECT title FROM order_items`))[0].title).toBe('Soap, special batch');
  });
  it('the hidden product is not sold online and not listed in the shop', async () => {
    await manual([free('A', 100)], 100);
    const cart = await (await call('/v1/carts', { key: pubKey || adminKey, json: { customer_email: 'b@x.test' } })).json() as any;
    const add = await call(`/v1/carts/${cart.id}/items`, { key: pubKey || adminKey, json: { items: [{ sku: 'CUSTOM', qty: 1 }] } });
    expect(add.status).toBeGreaterThanOrEqual(400);
    const cat = await (await call('/v1/catalog/products', { key: pubKey || adminKey, method: 'GET' })).text();
    expect(cat).not.toContain('CUSTOM'); expect(cat).not.toContain('Free-hand');
  });
});

describe('free-hand lines and delivery quotes', () => {
  it('a free-hand line adds no weight and does not break a delivery quote', async () => {
    const r = await call('/v1/orders/manual/quote', { json: { items: [{ sku: 'CUSTOM', qty: 1, unit_price_cents: 5000, title: 'Work' }], currency: 'XOF', address: { country: 'BJ' } } });
    expect(r.status).toBe(200); expect(JSON.stringify(await r.json())).not.toMatch(/weight_missing|missing_weight/i);
  });
});

describe('free-hand lines on quotes', () => {
  beforeEach(async () => { await call('/v1/modules/quotes', { method: 'PUT', json: { enabled: true } }); });
  const quote = (items: any[]) => call('/v1/m/quotes', { json: { currency: 'XOF', customer_name: 'Ama', items } });
  it('a quote can carry a free-hand line next to catalog lines, and shows it to the customer', async () => {
    const r = await quote([{ sku: a, qty: 1 }, free('Delivery of 40 boxes to Ouidah', 25000)]); expect(r.status).toBe(201);
    const q = await j(r); expect(q.total_cents).toBe(35000); expect(q.items[1]).toMatchObject({ sku: 'CUSTOM', title: 'Delivery of 40 boxes to Ouidah', unit_price_cents: 25000 });
    await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST', json: {} });
    const html = await (await call(`/m/quotes/q/${q.public_url.split('/q/')[1]}`, { key: null, method: 'GET' })).text();
    expect(html).toContain('Delivery of 40 boxes to Ouidah'); expect(html).not.toMatch(/CUSTOM/);
  });
  it('a free-hand line without a description or price is refused, and the quote can become an order', async () => {
    expect((await quote([{ sku: 'CUSTOM', qty: 1, unit_price_cents: 5 }])).status).toBe(400);
    expect((await quote([{ sku: 'CUSTOM', qty: 1, title: 'x' }])).status).toBe(400);
    const q = await j(await quote([free('Consulting hour', 15000, 2)]));
    expect((await manual(q.items.map((i: any) => ({ sku: i.sku, qty: i.qty, unit_price_cents: i.unit_price_cents, title: i.title })), q.total_cents)).status).toBe(200);
    expect((await db().query<any>(`SELECT title, qty FROM order_items`))[0]).toEqual({ title: 'Consulting hour', qty: 2 });
  });
});

describe('free-hand lines and profit', () => {
  const orderOf = async () => (await db().query<any>(`SELECT id FROM orders ORDER BY created_at DESC`))[0].id as string;
  const report = async () => j(await call(`/v1/profit?from=${today()}&to=${today()}`));
  it('have no catalog cost; the cost is set on the order line, by cost access only', async () => {
    await call(`/v1/costs/${a}`, { method: 'PUT', json: { cost_cents: 6000 } });
    await manual([free('Engraved box', 20000), { sku: a, qty: 1 }], 30000);
    expect(await db().query(`SELECT 1 FROM variants WHERE sku = 'CUSTOM'`)).toHaveLength(1);        // it exists, yet:
    expect((await call('/v1/costs/CUSTOM', { method: 'PUT', json: { cost_cents: 5 } })).status).toBe(404);
    expect((await j(await call('/v1/costs'))).items.find((x: any) => x.sku === 'CUSTOM')).toBeUndefined();
    expect(await (await call('/v1/costs/export.csv', { method: 'GET' })).text()).not.toContain('CUSTOM');
    const imp = await call('/v1/costs/import', { json: { text: 'sku,cost\nCUSTOM,5\n' } }); expect(imp.status).toBe(422);          // not importable either
    let o = await j(await call(`/v1/profit/order/${await orderOf()}`)); expect(o.complete).toBe(false);
    const line = o.lines.find((l: any) => l.sku === 'CUSTOM'); expect(line.id).toBeTruthy();
    expect((await call(`/v1/profit/order-line/${line.id}`, { method: 'PUT', json: { cost_cents: 12000 } })).status).toBe(200);
    o = await j(await call(`/v1/profit/order/${await orderOf()}`));
    expect(o).toMatchObject({ complete: true, cost_cents: 18000, margin_cents: 12000 });
    expect((await call(`/v1/profit/order-line/${line.id}`, { method: 'PUT', json: { cost_cents: -1 } })).status).toBe(400);
    expect((await call('/v1/profit/order-line/nope', { method: 'PUT', json: { cost_cents: 1 } })).status).toBe(404);
    expect((await call(`/v1/profit/order-line/${line.id}`, { method: 'PUT', json: { cost_cents: null } })).status).toBe(200);
    expect((await j(await call(`/v1/profit/order/${await orderOf()}`))).complete).toBe(false);
    expect(roleCanRequest('staff', 'PUT', `/v1/profit/order-line/${line.id}`).ok).toBe(false);
    expect(roleCanRequest('manager', 'PUT', `/v1/profit/order-line/${line.id}`).ok).toBe(true);
    expect((await db().query<any>(`SELECT 1 FROM audit_log WHERE action = 'costs.line'`)).length).toBe(2);
  });
  it('are told apart by description in the by-product table', async () => {
    await manual([free('Engraved box', 20000)], 20000); await manual([free('Delivery', 3000)], 3000);
    for (const l of await db().query<any>(`SELECT id FROM order_items`)) await call(`/v1/profit/order-line/${l.id}`, { method: 'PUT', json: { cost_cents: 1000 } });
    const rows = (await report()).by_product; expect(rows.map((r: any) => r.sku).sort()).toEqual(['CUSTOM: Delivery', 'CUSTOM: Engraved box']);
  });
});
