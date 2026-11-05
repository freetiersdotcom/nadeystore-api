// =============================================================================
// Abandoned-cart recovery module: snapshot, timing, eligibility, opt-out, resume link, stats.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct, seedEmailConfig, mockFetch, MOCK_RESPONSES } from './setup';
import { runScheduledHooks } from '../modules/registry';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let ip = 0; let seq = 0; let sent: any[] = []; let restore = () => {}; let sku = ''; let productId = '';
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.107.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
    redirect: 'manual',
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const rows = <T = any>(q: string, a: unknown[] = []) => db().query<T>(q, a);
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const run = async () => j(await call('/v1/m/recovery/run', { json: {} }));
const mails = () => sent.filter((m) => !String(m.subject).startsWith('[TEST]'));

async function cart(o: { email?: string; hours?: number; status?: string; locale?: string; title?: string; qty?: number; items?: boolean; s?: string } = {}) {
  const id = `cart-${++seq}-${Math.random().toString(36).slice(2, 10)}`;
  await db().run(`INSERT INTO carts (id, status, customer_email, currency, locale, expires_at, created_at) VALUES (?, ?, ?, 'XOF', ?, ?, ?)`,
    [id, o.status ?? 'expired', o.email ?? 'ama@shop.test', o.locale ?? 'fr', ago(-1), ago(o.hours ?? 4)]);
  if (o.items !== false) await db().run(`INSERT INTO cart_items (id, cart_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, 5000)`, [`ci-${id}`, id, o.s ?? sku, o.title ?? 'Savon karité', o.qty ?? 2]);
  return id;
}
async function order(o: { cart?: string | null; email?: string; hoursAgo?: number; paid?: boolean; status?: string } = {}) {
  const id = `ord-${++seq}`;
  await db().run(`INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, cart_id, amount_paid_cents, created_at) VALUES (?, ?, ?, ?, 10000, 0, 0, 10000, 'XOF', ?, ?, ?)`,
    [id, `N-${id}`, o.status ?? 'paid', o.email ?? 'ama@shop.test', o.cart ?? null, o.paid === false ? 0 : 10000, ago(o.hoursAgo ?? 0)]);
  return id;
}
const tokenOf = async (cartId: string) => (await rows(`SELECT token FROM recovery_carts WHERE cart_id = ?`, [cartId]))[0]?.token as string;

beforeEach(async () => {
  const d = db();
  for (const t of ['recovery_carts', 'recovery_optout', 'recovery_settings']) await d.run(`DROP TABLE IF EXISTS ${t}`);
  await d.run(`DELETE FROM config WHERE key IN ('modules', 'email')`);
  await d.run(`DELETE FROM audit_log WHERE action LIKE 'recovery.%' OR action LIKE 'module.%'`);
  for (const t of ['refunds', 'order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'api_keys', 'discounts']) await d.run(`DELETE FROM ${t}`);
  adminKey = (await seedApiKeys(d)).adminKey;
  const p = await seedProduct(d); sku = p.sku; productId = p.productId;
  sent = []; await seedEmailConfig(d);
  restore = mockFetch((url, init) => { if (url.includes('api.resend.com')) { sent.push(JSON.parse(String(init?.body))); return MOCK_RESPONSES.resendSend(); } return new Response('{}', { status: 200 }); });
  expect((await call('/v1/modules/recovery', { method: 'PUT', json: { enabled: true } })).status).toBe(200);
  expect((await call('/v1/m/recovery')).status).toBe(200);   // the admin screen teaches the module where it lives (for the opt-out link)
});
afterEach(async () => { await new Promise((r) => setTimeout(r, 100)); restore(); });

describe('recovery: timing', () => {
  it('is off by default', async () => {
    await db().run(`DELETE FROM config WHERE key = 'modules'`);
    expect((await call('/v1/m/recovery')).status).toBe(404);
    expect((await call('/m/recovery/resume/' + 'x'.repeat(24), { key: null })).status).toBe(404);
  });
  it('waits for the delay, then sends once, then the second reminder with the code', async () => {
    await db().run(`INSERT INTO discounts (id, code, type, value, status) VALUES ('d1', 'BACK10', 'percentage', 10, 'active')`);
    expect((await call('/v1/m/recovery/settings', { method: 'PUT', json: { step1_hours: 3, step2_hours: 48, discount_code: 'BACK10', cooldown_days: 3, max_age_days: 7 } })).status).toBe(200);
    const recent = await cart({ hours: 1 });
    await run(); expect(mails().length).toBe(0);
    await db().run(`UPDATE carts SET created_at = ? WHERE id = ?`, [ago(4), recent]); await db().run(`UPDATE recovery_carts SET cart_at = ? WHERE cart_id = ?`, [ago(4), recent]);
    await run(); await run(); await new Promise((r) => setTimeout(r, 100));
    expect(mails().length).toBe(1);
    const m = mails()[0]; expect(m.to).toEqual(['ama@shop.test']); expect(m.html).toContain('Savon karité'); expect(m.html).toContain('/fr/panier?resume=' + await tokenOf(recent)); expect(m.html).toContain('/m/recovery/stop/');
    expect(m.html).not.toContain('BACK10');
    await db().run(`UPDATE recovery_carts SET first_sent_at = ?, last_sent_at = ? WHERE cart_id = ?`, [ago(49), ago(49), recent]);
    await run(); await new Promise((r) => setTimeout(r, 100));
    expect(mails().length).toBe(2); expect(mails()[1].html).toContain('BACK10');
    await db().run(`UPDATE recovery_carts SET first_sent_at = ?, last_sent_at = ? WHERE cart_id = ?`, [ago(100), ago(100), recent]);
    await run(); expect(mails().length).toBe(2);
  });
  it('second reminder can be turned off; english carts get english mail and the /cart link', async () => {
    await call('/v1/m/recovery/settings', { method: 'PUT', json: { step1_hours: 2, step2_hours: 0, discount_code: null, cooldown_days: 3, max_age_days: 7 } });
    const id = await cart({ locale: 'en' }); await run(); await new Promise((r) => setTimeout(r, 100));
    expect(mails().length).toBe(1); expect(mails()[0].html).toContain('/en/cart?resume='); expect(mails()[0].subject).toMatch(/left something/);
    await db().run(`UPDATE recovery_carts SET first_sent_at = ? WHERE cart_id = ?`, [ago(200), id]); await run(); expect(mails().length).toBe(1);
  });
  it('the cron hook does the same work', async () => {
    await cart(); await runScheduledHooks(db(), { storeBaseUrl: 'https://shop.test', storeName: 'Santé Natur’' }); await new Promise((r) => setTimeout(r, 100));
    expect(mails().length).toBe(1); expect(mails()[0].html).toContain('https://shop.test/fr/panier?resume=');
  });
});

describe('recovery: who is not reminded', () => {
  it('carts that became an order, buyers who bought another way, counter customers, no items', async () => {
    const a = await cart({ email: 'a@x.test' }); await order({ cart: a, email: 'a@x.test' });
    await cart({ email: 'b@x.test' }); await order({ email: 'B@X.test', hoursAgo: 1 });
    await cart({ email: 'walk-in@counter.invalid' }); await cart({ email: 'c@x.invalid' }); await cart({ email: 'd@x.test', items: false });
    await run(); expect(mails().length).toBe(0);
  });
  it('a canceled order does not count as a purchase', async () => {
    await cart({ email: 'e@x.test' }); await order({ email: 'e@x.test', status: 'canceled', hoursAgo: 1 });
    await run(); await new Promise((r) => setTimeout(r, 100)); expect(mails().length).toBe(1);
  });
  it('carts older than the maximum age are dropped', async () => {
    const old = await cart({ hours: 24 * 9 }); await run(); expect(mails().length).toBe(0);
    expect((await rows(`SELECT COUNT(*) n FROM recovery_carts WHERE cart_id = ?`, [old]))[0].n).toBe(0);
  });
  it('one customer with two carts: only one reminder inside the cool-down', async () => {
    await cart({ email: 'f@x.test' }); await cart({ email: 'f@x.test', hours: 5 });
    await run(); await run(); await new Promise((r) => setTimeout(r, 100)); expect(mails().length).toBe(1);
  });
  it('nothing is sent without an e-mail provider, and nothing breaks', async () => {
    await db().run(`DELETE FROM config WHERE key = 'email'`); await cart();
    expect((await run()).sent).toBe(0); expect(mails().length).toBe(0);
    await seedEmailConfig(db()); await run(); await new Promise((r) => setTimeout(r, 100)); expect(mails().length).toBe(1);
  });
  it('does not send before it knows where the opt-out link lives', async () => {
    await db().run(`UPDATE recovery_settings SET origin = NULL`); await cart();
    await runScheduledHooks(db(), { storeBaseUrl: 'https://shop.test', storeName: 'S' }); expect(mails().length).toBe(0);
    expect((await call('/v1/m/recovery')).status).toBe(200); await run(); await new Promise((r) => setTimeout(r, 100)); expect(mails().length).toBe(1);
  });
  it('escapes what the customer-facing mail shows', async () => {
    await cart({ title: '<img src=x onerror=alert(1)>' }); await run(); await new Promise((r) => setTimeout(r, 100));
    expect(mails()[0].html).not.toContain('<img src=x'); expect(mails()[0].html).toContain('&lt;img');
  });
});

describe('recovery: cart contents are copied before the core deletes them', () => {
  it('the second reminder and the resume link still work after cart_items are gone', async () => {
    const id = await cart(); await run(); await new Promise((r) => setTimeout(r, 100));
    await db().run(`DELETE FROM cart_items WHERE cart_id = ?`, [id]);
    const r = await j(await call(`/m/recovery/resume/${await tokenOf(id)}`, { key: null }));
    expect(r.items.length).toBe(1); expect(r.items[0].qty).toBe(2);
  });
});

describe('recovery: opt-out', () => {
  it('the page alone changes nothing; the button opts the address out of every cart', async () => {
    const a = await cart({ email: 'g@x.test' }); const b = await cart({ email: 'g@x.test', hours: 6 }); await run(); await new Promise((r) => setTimeout(r, 100));
    const t = await tokenOf(a); const page = await call(`/m/recovery/stop/${t}`, { key: null });
    expect(page.status).toBe(200); expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await rows(`SELECT COUNT(*) n FROM recovery_optout`))[0].n).toBe(0);
    const done = await call(`/m/recovery/stop/${t}`, { key: null, method: 'POST' }); expect(done.status).toBe(200); expect(await done.text()).toMatch(/ne recevrez plus/);
    expect((await rows(`SELECT COUNT(*) n FROM recovery_optout WHERE email = 'g@x.test'`))[0].n).toBe(1);
    await db().run(`UPDATE recovery_settings SET cooldown_days = 0`);
    await cart({ email: 'g@x.test', hours: 7 }); const before = mails().length; await run(); expect(mails().length).toBe(before);
    expect(b).toBeTruthy();
    expect((await call('/m/recovery/stop/' + 'z'.repeat(24), { key: null })).status).toBe(404);
  });
  it('the shop can remove an opt-out', async () => {
    const a = await cart(); await run(); await call(`/m/recovery/stop/${await tokenOf(a)}`, { key: null, method: 'POST' });
    expect((await j(await call('/v1/m/recovery/optouts'))).items.length).toBe(1);
    expect((await call('/v1/m/recovery/optouts/ama%40shop.test', { method: 'DELETE' })).status).toBe(200);
    expect((await j(await call('/v1/m/recovery/optouts'))).items.length).toBe(0);
  });
});

describe('recovery: resume link', () => {
  it('gives live prices and leaves out products that are no longer sold', async () => {
    const gone = (await seedProduct(db())).sku;
    const id = await cart(); await db().run(`INSERT INTO cart_items (id, cart_id, sku, title, qty, unit_price_cents) VALUES ('x1', ?, ?, 'Old', 1, 100)`, [id, gone]);
    await run(); await db().run(`UPDATE variants SET price_cents = 7777 WHERE sku = ?`, [sku]); await db().run(`UPDATE variants SET status = 'draft' WHERE sku = ?`, [gone]);
    const r = await j(await call(`/m/recovery/resume/${await tokenOf(id)}`, { key: null }));
    expect(r.items.map((i: any) => [i.sku, i.price_cents])).toEqual([[sku, 7777]]);
    expect((await rows(`SELECT resumed_at FROM recovery_carts WHERE cart_id = ?`, [id]))[0].resumed_at).toBeTruthy();
    expect((await j(await call('/m/recovery/resume/unknown-token-1234567890', { key: null }))).items).toEqual([]);
    expect(productId).toBeTruthy();
  });
});

describe('recovery: numbers and settings', () => {
  it('counts a paid order after a reminder as recovered, with its revenue', async () => {
    const id = await cart(); await run(); await new Promise((r) => setTimeout(r, 100));
    await order({ cart: id, hoursAgo: -1 });
    await db().run(`UPDATE orders SET created_at = ? WHERE cart_id = ?`, [new Date(Date.now() + 60_000).toISOString(), id]);
    const g = await j(await call('/v1/m/recovery'));
    expect(g.stats.recovered).toBe(1); expect(g.stats.recovered_revenue[0]).toMatchObject({ currency: 'XOF', cents: 10000 });
    expect(g.items[0].state).toBe('recovered');
  });
  it('validates settings', async () => {
    const put = (b: any) => call('/v1/m/recovery/settings', { method: 'PUT', json: { step1_hours: 3, step2_hours: 48, discount_code: null, cooldown_days: 3, max_age_days: 7, ...b } });
    expect((await put({ step2_hours: 2 })).status).toBe(400);
    expect((await put({ discount_code: 'NOPE' })).status).toBe(400);
    expect((await put({ step1_hours: 0 })).status).toBe(400);
    expect((await put({})).status).toBe(200);
  });
  it('sends a clearly marked test mail to the address given', async () => {
    const r = await call('/v1/m/recovery/test', { json: { to: 'owner@shop.test', lang: 'en' } }); expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 100)); expect(sent.at(-1).subject).toMatch(/^\[TEST\]/); expect(sent.at(-1).to).toEqual(['owner@shop.test']);
    expect((await call('/v1/m/recovery/test', { json: { to: 'bad' } })).status).toBe(400);
  });
  it('needs a key', async () => { expect((await call('/v1/m/recovery', { key: null })).status).toBe(401); });
});
