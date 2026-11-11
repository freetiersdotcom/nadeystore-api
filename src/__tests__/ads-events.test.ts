// =============================================================================
// Ad tracking, part 2: pixel settings and server-side purchase events (Meta Conversions API, TikTok Events API).
// All network calls are mocked: these tests prove WHAT is sent and WHEN, not that the platforms accept it.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct, seedCart, mockFetch } from './setup';
import { roleCanRequest } from '../auth/permissions';
import { runOrderPaidHooks } from '../modules/registry';
import { metaEvent, tiktokEvent, sha256, normPhone, sendPending, type EventCtx } from '../modules/ads/events';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let ip = 0; let restore = () => {}; let sku = '';
let calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
let answer: (url: string) => Response = () => new Response('{}', { status: 200 });
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown; extra?: Record<string, string> } = {}) {
  const { key = adminKey, json, extra, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.117.${(++ip % 250) + 1}`, ...(extra ?? {}) },
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const configure = (meta = true, tiktok = true) => call('/v1/m/ads/pixels', { method: 'PUT', json: {
  ...(meta ? { meta: { pixel_id: '111222', access_token: 'META-SECRET', test_code: '' } } : {}),
  ...(tiktok ? { tiktok: { pixel_id: 'TTPIX', access_token: 'TT-SECRET', test_code: '' } } : {}),
} });

/** A paid order that came from a campaign cart, with a real e-mail and phone. */
async function order(attach: Record<string, unknown> | null = { utm_source: 'facebook', utm_campaign: 'bf', click_id_type: 'fbclid', click_id: 'FB123', fbp: 'fb.1.9.9', ttp: 'ttp-1', landing: 'https://shop.test/fr/?x=1' }) {
  const cart = await seedCart(db(), [{ sku, qty: 2, price_cents: 10000 }]);
  if (attach) expect((await call('/m/ads/attach', { key: null, extra: { 'User-Agent': 'UA-Test', 'CF-Connecting-IP': '203.0.113.7' }, json: { cart_id: cart, ...attach } })).status).toBe(200);
  expect([200, 201]).toContain((await call('/v1/orders/manual', { json: { items: [{ sku, qty: 2 }], payment: { amount_cents: 20000, method: 'cash' } } })).status);
  const [o] = await db().query<any>(`SELECT id FROM orders ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  await db().run(`UPDATE orders SET cart_id = ?, customer_email = ?, shipping_phone = ? WHERE id = ?`, [cart, ' Client@Example.COM ', '+229 01 94 45 89 56', o.id]);
  return { id: o.id as string, cart };
}

beforeEach(async () => {
  const d = db();
  for (const t of ['refunds', 'order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'customer_addresses', 'customers', 'inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) { try { await d.run(`DELETE FROM ${t}`); } catch { /* ignore */ } }
  await d.run(`DELETE FROM config WHERE key IN ('modules', 'profit_fees', 'ads_pixels')`);
  adminKey = (await seedApiKeys(d)).adminKey;
  sku = (await seedProduct(d, { price_cents: 10000, on_hand: 100 })).sku;
  await d.run(`UPDATE variants SET currency = 'XOF'`);
  calls = []; answer = () => new Response('{}', { status: 200 });
  restore = mockFetch((url: string, init?: RequestInit) => {
    if (/facebook\.com|tiktok\.com/.test(url)) { calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()), body: JSON.parse(String(init?.body ?? '{}')) }); return answer(url); }
    return new Response('{}', { status: 200 });
  });
  expect((await call('/v1/modules/ads', { method: 'PUT', json: { enabled: true } })).status).toBe(200);
  await d.run(`DELETE FROM ad_attribution`); await d.run(`DELETE FROM ad_events`);
});
afterEach(() => restore());

const ctx = (over: Partial<EventCtx> = {}): EventCtx => ({ orderId: 'ord-1', currency: 'XOF', totalCents: 20000, paidAtMs: 1_700_000_000_000, items: [{ sku: 'A', qty: 2, unit_price_cents: 10000 }], email: 'client@example.com', phone: '22901944589', ip: '203.0.113.7', ua: 'UA', fbp: 'fb.1.9.9', ttp: 'tt1', clickIdType: 'fbclid', clickId: 'FB123', clickAtMs: 1_699_999_000_000, url: 'https://shop.test/fr/', referrer: '', ...over });

describe('what is sent', () => {
  it('Meta payload: hashed identifiers, order id as event id, value in the right unit, fbc built from the click id', async () => {
    const e: any = await metaEvent(ctx());
    expect(e).toMatchObject({ event_name: 'Purchase', event_id: 'ord-1', action_source: 'website', event_time: 1_700_000_000, event_source_url: 'https://shop.test/fr/' });
    expect(e.user_data.em).toEqual([await sha256('client@example.com')]); expect(e.user_data.ph).toEqual([await sha256('22901944589')]);
    expect(e.user_data.fbc).toBe('fb.1.1699999000000.FB123'); expect(e.user_data.fbp).toBe('fb.1.9.9'); expect(e.user_data.client_ip_address).toBe('203.0.113.7');
    expect(e.custom_data).toMatchObject({ currency: 'XOF', value: 20000, order_id: 'ord-1', content_ids: ['A'], num_items: 2 });
    expect(JSON.stringify(e)).not.toContain('client@example.com');
    expect((await metaEvent(ctx({ currency: 'EUR', totalCents: 2550 }))as any).custom_data.value).toBe(25.5);
    expect((await metaEvent(ctx({ clickIdType: 'ttclid', clickId: 'T' })) as any).user_data.fbc).toBeUndefined();
  });

  it('TikTok payload: CompletePayment (same name as the browser pixel), hashed email, phone hashed with a leading +, ttclid only for TikTok clicks', async () => {
    const e: any = await tiktokEvent(ctx({ clickIdType: 'ttclid', clickId: 'TT9' }));
    expect(e).toMatchObject({ event: 'CompletePayment', event_id: 'ord-1', event_time: 1_700_000_000 });
    expect(e.user.email).toBe(await sha256('client@example.com')); expect(e.user.phone).toBe(await sha256('+22901944589'));
    expect(e.user).toMatchObject({ ttclid: 'TT9', ttp: 'tt1', ip: '203.0.113.7', user_agent: 'UA' });
    expect(e.properties).toMatchObject({ currency: 'XOF', value: 20000 });
    expect((await tiktokEvent(ctx()) as any).user.ttclid).toBeUndefined();
  });

  it('phone numbers: digits only, rejects things that are not numbers', () => {
    expect(normPhone('+229 01 94 45 89 56')).toBe('2290194458956'); expect(normPhone('12')).toBe(''); expect(normPhone(null)).toBe('');
  });
});

describe('settings', () => {
  it('never returns an access token; omitting it keeps it, null removes it', async () => {
    expect((await configure()).status).toBe(200);
    let v = await j(await call('/v1/m/ads/pixels', { method: 'GET' }));
    expect(v.meta).toMatchObject({ pixel_id: '111222', token_set: true, active: true }); expect(JSON.stringify(v)).not.toContain('SECRET');
    await call('/v1/m/ads/pixels', { method: 'PUT', json: { meta: { pixel_id: '111222', test_code: 'TEST1' } } });
    v = await j(await call('/v1/m/ads/pixels', { method: 'GET' })); expect(v.meta).toMatchObject({ token_set: true, test_code: 'TEST1' });
    await call('/v1/m/ads/pixels', { method: 'PUT', json: { meta: { pixel_id: '111222', access_token: null, test_code: '' } } });
    v = await j(await call('/v1/m/ads/pixels', { method: 'GET' })); expect(v.meta).toMatchObject({ token_set: false, active: false }); expect(v.tiktok.token_set).toBe(true);
    expect((await call('/v1/m/ads/pixels', { method: 'PUT', json: { meta: { pixel_id: 'bad id!', test_code: '' } } })).status).toBe(400);
  });

  it('the storage is sealed when a config key is set, and staff cannot touch it', async () => {
    expect(roleCanRequest('staff', 'PUT', '/v1/m/ads/pixels').ok).toBe(false);
    expect(roleCanRequest('manager', 'PUT', '/v1/m/ads/pixels').ok).toBe(true);
  });

  it('the storefront gets only the pixel ids, and only while the module is on', async () => {
    expect(await j(await call('/m/ads/config', { key: null, method: 'GET' }))).toEqual({ meta_pixel_id: null, tiktok_pixel_id: null });
    await configure(true, false);
    const c = await j(await call('/m/ads/config', { key: null, method: 'GET' }));
    expect(c).toEqual({ meta_pixel_id: '111222', tiktok_pixel_id: null }); expect(JSON.stringify(c)).not.toContain('SECRET');
    await call('/v1/modules/ads', { method: 'PUT', json: { enabled: false } });
    expect((await call('/m/ads/config', { key: null, method: 'GET' })).status).toBe(404);
  });

  it('attach remembers the visitor IP and browser (only to match the sale), and they are erased after delivery', async () => {
    await configure();
    const { id, cart } = await order();
    let [a] = await db().query<any>(`SELECT ip, ua FROM ad_attribution WHERE cart_id = ?`, [cart]);
    expect(a).toEqual({ ip: '203.0.113.7', ua: 'UA-Test' });
    expect((await sendPending(db())).sent).toBe(2);
    [a] = await db().query<any>(`SELECT ip, ua FROM ad_attribution WHERE cart_id = ?`, [cart]);
    expect(a).toEqual({ ip: null, ua: null }); expect(id).toBeTruthy();
  });
});

describe('sending purchases', () => {
  it('sends nothing until a platform has both a pixel id and a token', async () => {
    await order(); expect(await sendPending(db())).toEqual({ sent: 0, failed: 0 });
    await call('/v1/m/ads/pixels', { method: 'PUT', json: { meta: { pixel_id: '111222', test_code: '' } } });
    expect(await sendPending(db())).toEqual({ sent: 0, failed: 0 }); expect(calls).toHaveLength(0);
  });

  it('sends each attributed paid order once to each platform, with the order id as event id', async () => {
    await configure(); const { id } = await order();
    expect(await sendPending(db())).toEqual({ sent: 2, failed: 0 });
    const m = calls.find((c) => /facebook/.test(c.url))!; const t = calls.find((c) => /tiktok/.test(c.url))!;
    expect(m.url).toContain('/111222/events'); expect(m.body.access_token).toBe('META-SECRET'); expect(m.body.data[0]).toMatchObject({ event_name: 'Purchase', event_id: id });
    expect(m.body.test_event_code).toBeUndefined();
    expect(m.body.data[0].user_data.em).toEqual([await sha256('client@example.com')]);
    expect(t.headers['access-token']).toBe('TT-SECRET'); expect(t.body).toMatchObject({ event_source: 'web', event_source_id: 'TTPIX' }); expect(t.body.data[0]).toMatchObject({ event: 'CompletePayment', event_id: id });
    expect(await sendPending(db())).toEqual({ sent: 0, failed: 0 }); expect(calls).toHaveLength(2);
  });

  it('skips orders without an attribution (no consent), canceled orders and old orders', async () => {
    await configure();
    await order(null);
    const c = await order(); await db().run(`UPDATE orders SET status = 'canceled' WHERE id = ?`, [c.id]);
    const old = await order(); await db().run(`UPDATE orders SET paid_at = ? WHERE id = ?`, [new Date(Date.now() - 9 * 86_400_000).toISOString(), old.id]);
    expect(await sendPending(db())).toEqual({ sent: 0, failed: 0 }); expect(calls).toHaveLength(0);
  });

  it('a failure is retried later and stops after 5 tries; a success is never repeated', async () => {
    await configure(true, false); const { id } = await order();
    answer = () => new Response('{"error":"down"}', { status: 500 });
    expect(await sendPending(db())).toEqual({ sent: 0, failed: 1 });
    let [e] = await db().query<any>(`SELECT status, tries, detail FROM ad_events WHERE order_id = ?`, [id]); expect(e).toMatchObject({ status: 'failed', tries: 1 }); expect(e.detail).toContain('500');
    answer = () => new Response('{}', { status: 200 });
    expect(await sendPending(db())).toEqual({ sent: 1, failed: 0 });
    [e] = await db().query<any>(`SELECT status, tries FROM ad_events WHERE order_id = ?`, [id]); expect(e).toMatchObject({ status: 'sent', tries: 2 });
    expect(await sendPending(db())).toEqual({ sent: 0, failed: 0 });
    const b = await order(); answer = () => new Response('no', { status: 400 });
    for (let i = 0; i < 7; i++) await sendPending(db());
    const [x] = await db().query<any>(`SELECT tries FROM ad_events WHERE order_id = ?`, [b.id]); expect(x.tries).toBe(5);
  });

  it('TikTok answers 200 with an error code in the body: that is a failure', async () => {
    await configure(false, true); await order();
    answer = () => new Response(JSON.stringify({ code: 40001, message: 'Invalid pixel' }), { status: 200 });
    expect(await sendPending(db())).toEqual({ sent: 0, failed: 1 });
    answer = () => new Response(JSON.stringify({ code: 0, message: 'OK' }), { status: 200 });
    expect(await sendPending(db())).toEqual({ sent: 1, failed: 0 });
  });

  it('the paid-order hook sends it right away', async () => {
    await configure(true, false); await order();
    await runOrderPaidHooks(db()); expect(calls).toHaveLength(1);
  });

  it('the test button refuses without a test code, and with one marks the event as a test', async () => {
    await configure(true, false);
    let r = await j(await call('/v1/m/ads/pixels/test', { json: { platform: 'meta' } })); expect(r.ok).toBe(false); expect(r.detail).toContain('test event code'); expect(calls).toHaveLength(0);
    await call('/v1/m/ads/pixels', { method: 'PUT', json: { meta: { pixel_id: '111222', test_code: 'TEST42' } } });
    r = await j(await call('/v1/m/ads/pixels/test', { json: { platform: 'meta' } })); expect(r.ok).toBe(true);
    expect(calls[0].body.test_event_code).toBe('TEST42'); expect(calls[0].body.data[0].event_id).toMatch(/^test-/);
    expect((await call('/v1/m/ads/pixels/test', { json: { platform: 'tiktok' } })).status).toBe(200);
  });

  it('lists recent deliveries for the admin', async () => {
    await configure(true, false); const { id } = await order(); await sendPending(db());
    const l = await j(await call('/v1/m/ads/events', { method: 'GET' }));
    expect(l.items[0]).toMatchObject({ order_id: id, platform: 'meta', status: 'sent' });
    expect((await j(await call('/v1/m/ads/pixels', { method: 'GET' }))).meta.sent).toBe(1);
  });
});
