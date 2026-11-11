// =============================================================================
// Ad tracking module: campaign capture per cart, per-campaign report with profit and spend, privacy.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct, seedCart, mockFetch } from './setup';
import { roleCanRequest } from '../auth/permissions';
import { normalizeAttribution, purgeOld } from '../modules/ads/lib';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let ip = 0; let restore = () => {}; let sku = '';
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.116.${(++ip % 250) + 1}` },
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const today = () => new Date().toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const rep = async (q = '') => j(await call(`/v1/m/ads/report?from=${today()}&to=${today()}${q}`));
const xof = (d: any) => d.currencies.find((c: any) => c.currency === 'XOF');
const attach = (cart_id: string, extra: Record<string, unknown>) => call('/m/ads/attach', { key: null, json: { cart_id, ...extra } });

/** A paid order that came from a cart (so it can carry an attribution). */
async function order(extra: Record<string, unknown> | null, qty = 1) {
  const cart = await seedCart(db(), [{ sku, qty, price_cents: 10000 }]);
  if (extra) expect((await attach(cart, extra)).status).toBe(200);
  expect([200, 201]).toContain((await call('/v1/orders/manual', { json: { items: [{ sku, qty }], payment: { amount_cents: 10000 * qty, method: 'cash' } } })).status);
  const [o] = await db().query<any>(`SELECT id FROM orders ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const id = o.id;
  await db().run(`UPDATE orders SET cart_id = ? WHERE id = ?`, [cart, id]);
  return { id, cart };
}

beforeEach(async () => {
  const d = db();
  for (const t of ['refunds', 'order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'customer_addresses', 'customers', 'inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) { try { await d.run(`DELETE FROM ${t}`); } catch { /* ignore */ } }
  await d.run(`DELETE FROM config WHERE key IN ('modules', 'profit_fees')`);
  adminKey = (await seedApiKeys(d)).adminKey;
  sku = (await seedProduct(d, { price_cents: 10000, on_hand: 100 })).sku;
  await d.run(`UPDATE variants SET currency = 'XOF', cost_cents = 6000`);
  restore = mockFetch(() => new Response('{}', { status: 200 }));
  expect((await call('/v1/modules/ads', { method: 'PUT', json: { enabled: true } })).status).toBe(200);
  await d.run(`DELETE FROM ad_attribution`); await d.run(`DELETE FROM ad_spend`);
});
afterEach(() => restore());

describe('what the storefront reports', () => {
  it('cleans the input, infers the platform from a click id, ignores visits with nothing to attribute', () => {
    expect(normalizeAttribution({})).toBeNull();
    expect(normalizeAttribution({ landing: '/fr/', referrer: 'https://x.test' })).toBeNull();
    expect(normalizeAttribution({ click_id_type: 'fbclid', click_id: 'abc' })).toMatchObject({ source: 'facebook', medium: 'paid', click_id_type: 'fbclid' });
    expect(normalizeAttribution({ click_id_type: 'ttclid', click_id: 'abc' })).toMatchObject({ source: 'tiktok' });
    expect(normalizeAttribution({ click_id_type: 'bogus', click_id: 'abc' })).toBeNull();
    const a = normalizeAttribution({ utm_source: ' Facebook\n', utm_medium: 'CPC', utm_campaign: 'X'.repeat(500), utm_content: 'a\u0000b' })!;
    expect(a.source).toBe('facebook'); expect(a.medium).toBe('cpc'); expect(a.campaign).toHaveLength(120); expect(a.content).toBe('a b');
  });

  it('the public route is closed while the module is off, and needs a real cart', async () => {
    const cart = await seedCart(db(), [{ sku, qty: 1, price_cents: 10000 }]);
    expect(await j(await attach(cart, { utm_source: 'tiktok', utm_campaign: 'c1' }))).toEqual({ attached: true });
    expect(await j(await attach('no-such-cart-123', { utm_source: 'tiktok' }))).toEqual({ attached: false });
    expect(await j(await attach(cart, { landing: '/' }))).toEqual({ attached: false });
    expect((await call('/m/ads/attach', { key: null, json: { cart_id: 'x' } })).status).toBe(400);
    expect((await call('/v1/modules/ads', { method: 'PUT', json: { enabled: false } })).status).toBe(200);
    expect((await attach(cart, { utm_source: 'tiktok' })).status).toBe(404);
  });

  it('the latest campaign wins until the cart becomes an order, then it is frozen', async () => {
    const { id, cart } = await order({ utm_source: 'facebook', utm_campaign: 'first' });
    await attach(cart, { utm_source: 'tiktok', utm_campaign: 'later' });
    const [r] = await db().query<any>(`SELECT campaign FROM ad_attribution WHERE cart_id = ?`, [cart]);
    expect(r.campaign).toBe('first');
    expect((await j(await call(`/v1/m/ads/order/${id}`))).attribution).toMatchObject({ source: 'facebook', campaign: 'first' });
    const c2 = await seedCart(db(), [{ sku, qty: 1, price_cents: 10000 }]);
    await attach(c2, { utm_source: 'facebook', utm_campaign: 'a' }); await attach(c2, { utm_source: 'tiktok', utm_campaign: 'b' });
    expect((await db().query<any>(`SELECT campaign FROM ad_attribution WHERE cart_id = ?`, [c2]))[0].campaign).toBe('b');
  });
});

describe('the campaign report', () => {
  it('groups orders by campaign, keeps direct sales apart, and agrees with the profit report', async () => {
    await order({ utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'Black-Friday' });
    await order({ utm_source: 'Facebook', utm_medium: 'cpc', utm_campaign: 'black-friday' }, 2);   // same campaign, other letter case
    await order({ utm_source: 'tiktok', utm_campaign: 'launch' });
    await order(null);                                                                              // direct
    const r = xof(await rep());
    const bf = r.rows.find((x: any) => x.key === 'black-friday');
    expect(bf).toMatchObject({ orders: 2, revenue_cents: 30000, margin_cents: 12000 });
    expect(r.rows.find((x: any) => x.key === 'launch')).toMatchObject({ orders: 1, revenue_cents: 10000 });
    expect(r.rows.find((x: any) => x.key === '')).toMatchObject({ campaign: '(direct / unknown)', orders: 1 });
    expect(r.rows[r.rows.length - 1].key).toBe('');                                               // direct is listed last
    expect(r.totals).toMatchObject({ orders: 4, revenue_cents: 50000, attributed_orders: 3, attributed_revenue_cents: 40000 });
    const profit = xof(await j(await call(`/v1/profit?from=${today()}&to=${today()}`)));
    expect(r.totals.revenue_cents).toBe(profit.revenue_cents);
    expect(r.totals.margin_cents).toBe(profit.margin_cents);
  });

  it('spend is spread over its days and counted only for the days in the period; ROAS follows', async () => {
    await order({ utm_source: 'facebook', utm_campaign: 'promo' });
    const add = (body: Record<string, unknown>) => call('/v1/m/ads/spend', { json: { platform: 'Facebook', campaign: 'Promo', currency: 'xof', ...body } });
    expect((await add({ from_day: day(-1), to_day: day(1), amount_cents: 3000 })).status).toBe(201);   // 3 days, 1000 a day
    let r = xof(await rep()); const row = r.rows.find((x: any) => x.key === 'promo');
    expect(row).toMatchObject({ spend_cents: 1000, orders: 1, revenue_cents: 10000, roas: 10, net_cents: 3000 });   // margin 4000 - 1000
    r = xof(await j(await call(`/v1/m/ads/report?from=${day(-1)}&to=${day(1)}`)));
    expect(r.rows.find((x: any) => x.key === 'promo').spend_cents).toBe(3000);
    // spend for a campaign with no orders still shows up, and a period that does not overlap counts for nothing
    expect((await add({ campaign: 'Quiet', from_day: today(), to_day: today(), amount_cents: 500 })).status).toBe(201);
    expect((await add({ campaign: 'Old', from_day: day(-40), to_day: day(-30), amount_cents: 999 })).status).toBe(201);
    r = xof(await rep());
    expect(r.rows.find((x: any) => x.key === 'quiet')).toMatchObject({ orders: 0, spend_cents: 500 });
    expect(r.rows.find((x: any) => x.key === 'old')).toBeUndefined();
    // validation and delete
    expect((await add({ from_day: today(), to_day: day(-1), amount_cents: 1 })).status).toBe(400);
    expect((await add({ from_day: today(), to_day: today(), amount_cents: 0 })).status).toBe(400);
    const list = await j(await call('/v1/m/ads/spend'));
    expect((await call(`/v1/m/ads/spend/${list.items[0].id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call('/v1/m/ads/spend/nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('an order whose items have no cost still counts as revenue but not as profit', async () => {
    await db().run(`UPDATE variants SET cost_cents = NULL`);
    await order({ utm_source: 'tiktok', utm_campaign: 'nocost' });
    const row = xof(await rep()).rows.find((x: any) => x.key === 'nocost');
    expect(row).toMatchObject({ orders: 1, revenue_cents: 10000, known_orders: 0, margin_cents: 0, coverage_pct: 0 });
  });
});

describe('privacy and housekeeping', () => {
  it('profit figures are not for staff', () => {
    expect(roleCanRequest('manager', 'GET', '/v1/m/ads/report').ok).toBe(true);
    expect(roleCanRequest('staff', 'GET', '/v1/m/ads/report').ok).toBe(false);
    expect(roleCanRequest('staff', 'POST', '/v1/m/ads/spend').ok).toBe(false);
  });

  it('old carts without an order lose their attribution; those with an order keep it', async () => {
    const { cart: kept } = await order({ utm_source: 'tiktok', utm_campaign: 'k' });
    const gone = await seedCart(db(), [{ sku, qty: 1, price_cents: 10000 }]); await attach(gone, { utm_source: 'tiktok', utm_campaign: 'g' });
    const recent = await seedCart(db(), [{ sku, qty: 1, price_cents: 10000 }]); await attach(recent, { utm_source: 'tiktok', utm_campaign: 'r' });
    const old = new Date(Date.now() - 61 * 86_400_000).toISOString();
    await db().run(`UPDATE ad_attribution SET created_at = ? WHERE cart_id IN (?, ?)`, [old, kept, gone]);
    await purgeOld(db());
    const left = (await db().query<any>(`SELECT cart_id FROM ad_attribution`)).map((x) => x.cart_id).sort();
    expect(left).toEqual([kept, recent].sort());
  });
});
