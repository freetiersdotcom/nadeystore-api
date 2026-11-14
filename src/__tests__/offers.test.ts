// =============================================================================
// Offers module: rules, which offers fit a cart, the shop (not the browser) pricing the offered line,
// limits, crediting paid orders, and roles.
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct } from './setup';
import { roleCanRequest } from '../auth/permissions';
import { discounted } from '../modules/offers/lib';

const stub = () => env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any;
const db = () => getDb(stub());
let adminKey = ''; let ip = 0; let n = 0;
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.121.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
    redirect: 'manual',
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const q = <T = any>(s: string, a: unknown[] = []) => db().query<T>(s, a);
const productOf = async (sku: string) => (await q<any>(`SELECT product_id FROM variants WHERE sku = ?`, [sku]))[0].product_id as string;
const pub = async (path: string, json?: unknown) => call(`/m/offers${path}`, { key: null, ...(json !== undefined ? { json } : {}) });

async function cart(lines: Array<{ sku: string; qty?: number; price?: number }>, currency = 'USD') {
  const id = `cart-${Math.random().toString(36).slice(2, 12)}`;
  await db().run(`INSERT INTO carts (id, status, customer_email, currency, expires_at) VALUES (?, 'open', 'a@shop.test', ?, datetime('now', '+1 day'))`, [id, currency]);
  for (const l of lines) {
    const [v] = await q<any>(`SELECT title, price_cents FROM variants WHERE sku = ?`, [l.sku]);
    await db().run(`INSERT INTO cart_items (id, cart_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`, [crypto.randomUUID(), id, l.sku, v.title, l.qty ?? 1, l.price ?? v.price_cents]);
  }
  return id;
}
const priceIn = async (cartId: string, sku: string) => (await q<any>(`SELECT unit_price_cents FROM cart_items WHERE cart_id = ? AND sku = ?`, [cartId, sku]))[0]?.unit_price_cents as number;
const rule = (over: Record<string, unknown> = {}) => ({ name: 'Rule', trigger_kind: 'any', offer_sku: offered.sku, discount_pct: 20, ...over });
const makeRule = async (over: Record<string, unknown> = {}) => { const r = await call('/v1/m/offers', { json: rule(over) }); expect(r.status).toBe(201); return (await j(r)).id as string; };

let main: any; let offered: any; let other: any;
beforeEach(async () => {
  const d = db();
  for (const t of ['offers', 'offer_carts', 'offer_events']) await d.run(`DROP TABLE IF EXISTS ${t}`);
  await d.run(`DELETE FROM config WHERE key = 'modules'`);
  for (const t of ['order_items', 'orders', 'cart_items', 'carts', 'inventory', 'variants', 'products', 'api_keys']) await d.run(`DELETE FROM ${t}`);
  adminKey = (await seedApiKeys(d)).adminKey;
  main = await seedProduct(d, { price_cents: 10000 }); offered = await seedProduct(d, { price_cents: 5000 }); other = await seedProduct(d, { price_cents: 3000 });
  expect((await call('/v1/modules/offers', { json: { enabled: true }, method: 'PUT' })).status).toBe(200);
});

describe('discount arithmetic', () => {
  it('rounds to a whole minor unit', () => { expect(discounted(10000, 20)).toBe(8000); expect(discounted(999, 10)).toBe(899); expect(discounted(5, 50)).toBe(3); expect(discounted(1000, 0)).toBe(1000); });
});

describe('rules (admin)', () => {
  it('creates, lists with numbers, updates and deletes', async () => {
    const id = await makeRule({ name: 'Cream with soap', trigger_kind: 'product', trigger_ref: await productOf(main.sku), headline_fr: 'Ajoutez la crème' });
    let l = (await j(await call('/v1/m/offers'))).items; expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ id, name: 'Cream with soap', trigger_kind: 'product', discount_pct: 20, max_qty: 1, seen: 0, taken: 0, sold: 0, revenue_cents: 0, active: 1 });
    expect(l[0].offer_title).toContain('Test Product'); expect(l[0].trigger_title).toBe('Test Product');
    expect((await call(`/v1/m/offers/${id}`, { method: 'PUT', json: rule({ name: 'Renamed', discount_pct: 0, active: false }) })).status).toBe(200);
    l = (await j(await call('/v1/m/offers'))).items; expect(l[0]).toMatchObject({ name: 'Renamed', discount_pct: 0, active: 0 });
    expect((await call(`/v1/m/offers/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await j(await call('/v1/m/offers'))).items).toHaveLength(0);
  });
  it('rejects bad rules', async () => {
    const bad = async (over: Record<string, unknown>) => (await call('/v1/m/offers', { json: rule(over) })).status;
    expect(await bad({ offer_sku: 'NOPE' })).toBe(400);
    expect(await bad({ discount_pct: 95 })).toBe(400);
    expect(await bad({ discount_pct: -1 })).toBe(400);
    expect(await bad({ max_qty: 0 })).toBe(400);
    expect(await bad({ name: ' ' })).toBe(400);
    expect(await bad({ trigger_kind: 'sku' })).toBe(400);
    expect(await bad({ trigger_kind: 'sku', trigger_ref: 'NOPE' })).toBe(400);
    expect(await bad({ trigger_kind: 'product', trigger_ref: 'nope' })).toBe(400);
    expect(await bad({ trigger_kind: 'sku', trigger_ref: offered.sku })).toBe(400); // offering a variant of the trigger's own product
    expect(await bad({ trigger_kind: 'product', trigger_ref: await productOf(offered.sku) })).toBe(400);
    expect((await call('/v1/m/offers/nope', { method: 'PUT', json: rule() })).status).toBe(404);
  });
  it('is closed when the module is off, and needs a sign-in', async () => {
    expect((await call('/m/offers/match?skus=a', { key: null })).status).toBe(200);
    expect((await call('/v1/m/offers', { key: null })).status).toBe(401);
    await call('/v1/modules/offers', { method: 'PUT', json: { enabled: false } });
    expect((await call('/m/offers/match?skus=a', { key: null })).status).toBe(404);
  });
  it('roles: manager writes, staff only reads', () => {
    expect(roleCanRequest('manager', 'POST', '/v1/m/offers').ok).toBe(true);
    expect(roleCanRequest('staff', 'GET', '/v1/m/offers').ok).toBe(true);
    expect(roleCanRequest('staff', 'POST', '/v1/m/offers').ok).toBe(false);
  });
});

describe('which offers fit a cart', () => {
  const match = async (skus: string[], extra = '') => (await j(await pub(`/match?skus=${skus.join(',')}${extra}`))).items as any[];
  it('an "any" rule fits every non-empty cart, with the discounted price', async () => {
    const id = await makeRule();
    const m = await match([main.sku]);
    expect(m).toHaveLength(1); expect(m[0]).toMatchObject({ id, sku: offered.sku, price_cents: 5000, discounted_cents: 4000, discount_pct: 20, max_qty: 1 });
    expect(await match([])).toEqual([]);
  });
  it('a product rule fits only carts holding that product; a sku rule only that variant', async () => {
    await makeRule({ name: 'p', trigger_kind: 'product', trigger_ref: await productOf(main.sku) });
    expect(await match([main.sku])).toHaveLength(1);
    expect(await match([other.sku])).toHaveLength(0);
    await db().run(`DELETE FROM offers`);
    await makeRule({ name: 's', trigger_kind: 'sku', trigger_ref: main.sku });
    expect(await match([main.sku])).toHaveLength(1);
    expect(await match([other.sku])).toHaveLength(0);
  });
  it('never offers what is already in the cart (or the same product)', async () => {
    await makeRule();
    expect(await match([main.sku, offered.sku])).toHaveLength(0);
    const sib = 'SIB-1'; await db().run(`INSERT INTO variants (id, product_id, sku, title, price_cents, weight_g, product_type) VALUES (?, ?, ?, 'Sibling', 100, 0, 'physical')`, [crypto.randomUUID(), await productOf(offered.sku), sib]);
    expect(await match([main.sku, sib])).toHaveLength(0);
  });
  it('skips inactive rules, draft or sold-out items, and respects priority and the limit', async () => {
    const a = await makeRule({ name: 'low', priority: 0 }); const b = await makeRule({ name: 'high', priority: 5, offer_sku: other.sku });
    expect((await match([main.sku])).map((x) => x.id)).toEqual([b, a]);
    expect(await match([main.sku], '&limit=1')).toHaveLength(1);
    await call(`/v1/m/offers/${a}`, { method: 'PUT', json: rule({ name: 'low', active: false }) });
    expect((await match([main.sku])).map((x) => x.id)).toEqual([b]);
    await db().run(`UPDATE inventory SET on_hand = 0 WHERE sku = ?`, [other.sku]);
    expect(await match([main.sku])).toHaveLength(0);
    await db().run(`UPDATE inventory SET on_hand = 5 WHERE sku = ?`, [other.sku]); await db().run(`UPDATE products SET status = 'draft' WHERE id = ?`, [await productOf(other.sku)]);
    expect(await match([main.sku])).toHaveLength(0);
  });
  it('digital items need no stock; the headline follows the language', async () => {
    const dig = await seedProduct(db(), { product_type: 'digital', price_cents: 900, on_hand: 0 });
    await makeRule({ offer_sku: dig.sku, headline_fr: 'Bonus', headline_en: 'Bonus!' });
    expect((await match([main.sku]))[0].headline).toBe('Bonus'); expect((await match([main.sku], '&lang=en'))[0].headline).toBe('Bonus!');
  });
  it('ignores junk in the sku list', async () => {
    await makeRule(); expect(await match(['<script>', main.sku])).toHaveLength(1);
  });
});

describe('confirming an offer at checkout (the shop sets the price)', () => {
  const attach = async (cartId: string, ids: string[]) => j(await pub('/attach', { cart_id: cartId, offer_ids: ids }));
  it('prices the offered line, records it once, and counts it as taken', async () => {
    const id = await makeRule(); const c = await cart([{ sku: main.sku }, { sku: offered.sku }]);
    expect(await attach(c, [id])).toEqual({ attached: [id], refused: [] });
    expect(await priceIn(c, offered.sku)).toBe(4000); expect(await priceIn(c, main.sku)).toBe(10000);
    expect(await attach(c, [id])).toEqual({ attached: [id], refused: [] }); // again: same result, still one "taken"
    expect(await priceIn(c, offered.sku)).toBe(4000);
    expect((await q(`SELECT * FROM offer_events WHERE kind = 'taken'`))).toHaveLength(1);
    expect((await q(`SELECT * FROM offer_carts`))).toHaveLength(1);
  });
  it('a zero-discount rule is confirmed at the normal price', async () => {
    const id = await makeRule({ discount_pct: 0 }); const c = await cart([{ sku: main.sku }, { sku: offered.sku }]);
    expect((await attach(c, [id])).attached).toEqual([id]); expect(await priceIn(c, offered.sku)).toBe(5000);
  });
  it('refuses when the trigger is not in the cart, the line is missing, or the quantity is above the limit', async () => {
    const id = await makeRule({ trigger_kind: 'product', trigger_ref: await productOf(main.sku) });
    let c = await cart([{ sku: other.sku }, { sku: offered.sku }]);
    expect((await attach(c, [id])).refused).toEqual([id]); expect(await priceIn(c, offered.sku)).toBe(5000);
    c = await cart([{ sku: main.sku }]); expect((await attach(c, [id])).refused).toEqual([id]);
    c = await cart([{ sku: main.sku }, { sku: offered.sku, qty: 2 }]); expect((await attach(c, [id])).refused).toEqual([id]); expect(await priceIn(c, offered.sku)).toBe(5000);
    await call(`/v1/m/offers/${id}`, { method: 'PUT', json: rule({ trigger_kind: 'product', trigger_ref: await productOf(main.sku), max_qty: 2 }) });
    expect((await attach(c, [id])).attached).toEqual([id]); expect(await priceIn(c, offered.sku)).toBe(4000);
  });
  it('refuses inactive or unknown rules, a closed cart, and a line re-priced by something else', async () => {
    const id = await makeRule(); const c = await cart([{ sku: main.sku }, { sku: offered.sku }]);
    expect((await attach(c, ['00000000-0000-0000-0000-000000000000'])).refused).toHaveLength(1);
    await db().run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [c]); expect((await attach(c, [id])).refused).toEqual([id]);
    const c3 = await cart([{ sku: main.sku }, { sku: offered.sku, price: 777 }]); expect((await attach(c3, [id])).refused).toEqual([id]); expect(await priceIn(c3, offered.sku)).toBe(777);
    await call(`/v1/m/offers/${id}`, { method: 'PUT', json: rule({ active: false }) });
    const c4 = await cart([{ sku: main.sku }, { sku: offered.sku }]); expect((await attach(c4, [id])).refused).toEqual([id]); expect(await priceIn(c4, offered.sku)).toBe(5000);
  });
  it('does not compare currencies: the store-wide currency rules (variant currency is a legacy label)', async () => {
    const id = await makeRule(); const c = await cart([{ sku: main.sku }, { sku: offered.sku }], 'XOF');
    expect((await attach(c, [id])).attached).toEqual([id]); expect(await priceIn(c, offered.sku)).toBe(4000);
  });
  it('an offer the cart dropped is forgotten', async () => {
    const id = await makeRule(); const c = await cart([{ sku: main.sku }, { sku: offered.sku }]);
    await attach(c, [id]); expect(await q(`SELECT * FROM offer_carts`)).toHaveLength(1);
    await attach(c, []); expect(await q(`SELECT * FROM offer_carts`)).toHaveLength(0);
  });
  it('rejects a missing cart id', async () => { expect((await pub('/attach', { offer_ids: [] })).status).toBe(400); });
});

describe('the report', () => {
  const order = async (cartId: string, over: { status?: string; paid?: boolean; lines?: Array<{ sku: string; qty: number; price: number }> } = {}) => {
    const id = crypto.randomUUID(); n++;
    await db().run(`INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, total_cents, currency, cart_id, paid_at) VALUES (?, ?, ?, 'a@shop.test', 1, 0, 1, 'USD', ?, ?)`, [id, `OF-${n}`, over.status ?? 'paid', cartId, over.paid === false ? null : new Date().toISOString()]);
    for (const l of over.lines ?? []) await db().run(`INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, 't', ?, ?)`, [crypto.randomUUID(), id, l.sku, l.qty, l.price]);
    return id;
  };
  const stats = async () => (await j(await call('/v1/m/offers'))).items[0];
  it('counts views, taken, paid and revenue, each paid order once', async () => {
    const id = await makeRule();
    await pub('/seen', { offer_ids: [id] }); await pub('/seen', { offer_ids: [id, 'not-an-id', '00000000-0000-0000-0000-000000000000'] });
    const c = await cart([{ sku: main.sku }, { sku: offered.sku }]); await pub('/attach', { cart_id: c, offer_ids: [id] });
    expect(await stats()).toMatchObject({ seen: 2, taken: 1, sold: 0, revenue_cents: 0 });
    await order(c, { lines: [{ sku: main.sku, qty: 1, price: 10000 }, { sku: offered.sku, qty: 1, price: 4000 }] });
    const { credit } = await import('../modules/offers/lib');
    expect(await credit(db())).toBe(1); expect(await credit(db())).toBe(0);
    expect(await stats()).toMatchObject({ seen: 2, taken: 1, sold: 1, revenue_cents: 4000 });
  });
  it('does not credit unpaid, pending, or canceled orders; credits late payment when the order is paid', async () => {
    const id = await makeRule(); const { credit } = await import('../modules/offers/lib');
    const c = await cart([{ sku: main.sku }, { sku: offered.sku }]); await pub('/attach', { cart_id: c, offer_ids: [id] });
    const o = await order(c, { status: 'pending', paid: false, lines: [{ sku: offered.sku, qty: 1, price: 4000 }] });
    expect(await credit(db())).toBe(0);
    await db().run(`UPDATE orders SET status = 'canceled', paid_at = ? WHERE id = ?`, [new Date().toISOString(), o]); expect(await credit(db())).toBe(0);
    await db().run(`UPDATE orders SET status = 'paid' WHERE id = ?`, [o]); expect(await credit(db())).toBe(1);
    expect((await stats()).revenue_cents).toBe(4000);
  });
  it('the payment hook credits automatically', async () => {
    const id = await makeRule(); const c = await cart([{ sku: main.sku }, { sku: offered.sku }]); await pub('/attach', { cart_id: c, offer_ids: [id] });
    await order(c, { lines: [{ sku: offered.sku, qty: 2, price: 4000 }] });
    const { runOrderPaidHooks } = await import('../modules/registry');
    await runOrderPaidHooks(db()); expect((await stats())).toMatchObject({ sold: 1, revenue_cents: 8000 });
  });
});
