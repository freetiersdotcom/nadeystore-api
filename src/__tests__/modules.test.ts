// =============================================================================
// Optional modules: the framework, and the quotations module built on it.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { mockFetch, MOCK_RESPONSES, seedApiKeys, seedEmailConfig, seedProduct } from './setup';
import { roleCanRequest } from '../auth/permissions';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let publicKey = ''; let ip = 0; let sent: any[] = []; let restore: () => void; let sku = '';
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.104.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
    redirect: 'manual',
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const enable = () => call('/v1/modules/quotes', { method: 'PUT', json: { enabled: true } });
const rows = <T = any>(q: string, a: unknown[] = []) => db().query<T>(q, a);
const tokenOf = (url: string) => url.split('/q/')[1];
async function newQuote(extra: Record<string, unknown> = {}) {
  const r = await call('/v1/m/quotes', { json: { currency: 'XOF', items: [{ sku, qty: 2 }], customer_name: 'Ama Kossi', customer_email: 'ama@shop.test', ...extra } });
  return { status: r.status, q: await j(r) };
}

beforeEach(async () => {
  const d = db();
  await d.run(`DROP TABLE IF EXISTS quotes`);
  await d.run(`DELETE FROM config WHERE key IN ('modules', 'email')`);
  await d.run(`DELETE FROM audit_log WHERE action LIKE 'quote.%' OR action LIKE 'module.%'`);
  for (const t of ['order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'customer_addresses', 'customers', 'inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) await d.run(`DELETE FROM ${t}`);
  const k = await seedApiKeys(d); adminKey = k.adminKey; publicKey = (k as any).publicKey ?? '';
  sku = (await seedProduct(d, { price_cents: 450000, on_hand: 20 })).sku;
  sent = [];
  restore = mockFetch((url, init) => {
    if (url.includes('api.resend.com')) { sent.push(JSON.parse(String(init?.body))); return MOCK_RESPONSES.resendSend(); }
    return new Response('{}', { status: 200 });
  });
});
afterEach(async () => { await new Promise((r) => setTimeout(r, 50)); restore(); });

describe('framework', () => {
  it('lists the modules, all off by default, and a module that is off answers 404 and has no tables', async () => {
    const list = await j(await call('/v1/modules'));
    const q = list.items.find((m: any) => m.id === 'quotes');
    expect(q).toMatchObject({ enabled: false, version: 1 });
    expect(q.name.fr).toBe('Devis');
    expect((await call('/v1/m/quotes')).status).toBe(404);
    expect((await call('/m/quotes/q/abcdefghijklmnopqrstuvwx', { key: null })).status).toBe(404);
    expect(await rows(`SELECT name FROM sqlite_master WHERE name = 'quotes'`)).toHaveLength(0);
  });

  it('enabling creates the tables and opens the routes; disabling closes them but keeps the data', async () => {
    expect((await enable()).status).toBe(200);
    expect(await rows(`SELECT name FROM sqlite_master WHERE name = 'quotes'`)).toHaveLength(1);
    expect((await call('/v1/m/quotes')).status).toBe(200);
    const { q } = await newQuote();
    expect((await call('/v1/modules/quotes', { method: 'PUT', json: { enabled: false } })).status).toBe(200);
    expect((await call('/v1/m/quotes')).status).toBe(404);
    expect(await rows(`SELECT number FROM quotes`)).toEqual([{ number: q.number }]);   // kept
    await enable();
    expect((await j(await call('/v1/m/quotes'))).items).toHaveLength(1);              // and back
    const actions = (await rows(`SELECT action FROM audit_log WHERE action LIKE 'module.%'`)).map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['module.enabled', 'module.disabled']));
  });

  it('re-runs the migrations when the stored version is behind (a module update)', async () => {
    await enable();
    await db().run(`DROP TABLE quotes`);
    await db().run(`UPDATE config SET value = ? WHERE key = 'modules'`, [JSON.stringify({ enabled: ['quotes'], versions: { quotes: 0 } })]);
    expect((await call('/v1/m/quotes')).status).toBe(200);
    expect(await rows(`SELECT name FROM sqlite_master WHERE name = 'quotes'`)).toHaveLength(1);
  });

  it('rejects unknown modules and bad bodies', async () => {
    expect((await call('/v1/modules/nope', { method: 'PUT', json: { enabled: true } })).status).toBe(404);
    expect((await call('/v1/modules/quotes', { method: 'PUT', json: { enabled: 'yes' } })).status).toBe(400);
  });

  it('needs an admin sign-in: nothing for no key or a public key', async () => {
    await enable();
    expect((await call('/v1/m/quotes', { key: null })).status).toBe(401);
    expect((await call('/v1/modules', { key: null })).status).toBe(401);
    if (publicKey) { expect((await call('/v1/m/quotes', { key: publicKey })).status).toBe(403); }
  });

  it('role access: owner/agency everything, manager write, staff read, nobody else; modules list open to all, switching is a setting', () => {
    expect(roleCanRequest('owner', 'POST', '/v1/m/quotes').ok).toBe(true);
    expect(roleCanRequest('agency', 'DELETE', '/v1/m/quotes/x').ok).toBe(true);
    expect(roleCanRequest('manager', 'POST', '/v1/m/quotes').ok).toBe(true);
    expect(roleCanRequest('staff', 'GET', '/v1/m/quotes').ok).toBe(true);
    expect(roleCanRequest('staff', 'POST', '/v1/m/quotes').ok).toBe(false);
    expect(roleCanRequest('staff', 'DELETE', '/v1/m/quotes/x').ok).toBe(false);
    expect(roleCanRequest('manager', 'GET', '/v1/m/unknown-module').ok).toBe(false);
    expect(roleCanRequest('staff', 'GET', '/v1/modules').ok).toBe(true);
    expect(roleCanRequest('staff', 'PUT', '/v1/modules/quotes').ok).toBe(false);
    expect(roleCanRequest('manager', 'PUT', '/v1/modules/quotes').ok).toBe(false);
    expect(roleCanRequest('owner', 'PUT', '/v1/modules/quotes').ok).toBe(true);
  });
});

describe('quotes: admin side', () => {
  beforeEach(async () => { await enable(); });

  it('creates numbered quotes with catalog titles and prices (override allowed) and a shareable link', async () => {
    const { status, q } = await newQuote();
    expect(status).toBe(201);
    expect(q).toMatchObject({ number: 'Q-0001', status: 'draft', currency: 'XOF', total_cents: 900000, locale: 'fr' });
    expect(q.items[0]).toMatchObject({ sku, qty: 2, unit_price_cents: 450000 });
    expect(q.public_url).toMatch(/\/m\/quotes\/q\/[A-Za-z0-9_-]{30,}$/);
    const two = await newQuote({ items: [{ sku, qty: 1, unit_price_cents: 300000, title: 'Prix négocié' }] });
    expect(two.q.number).toBe('Q-0002');
    expect(two.q.items[0]).toMatchObject({ title: 'Prix négocié', unit_price_cents: 300000 });
    expect(two.q.total_cents).toBe(300000);
  });

  it('validates input', async () => {
    expect((await newQuote({ items: [{ sku: 'NOPE', qty: 1 }] })).status).toBe(400);
    expect((await newQuote({ items: [] })).status).toBe(400);
    expect((await newQuote({ currency: 'EURO' })).status).toBe(400);
    expect((await newQuote({ customer_email: 'not-an-email' })).status).toBe(400);
  });

  it('send: marks it sent, e-mails the link, and works without an e-mail address or provider (link only)', async () => {
    await seedEmailConfig(db());
    const { q } = await newQuote();
    const s = await j(await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' }));
    expect(s).toMatchObject({ status: 'sent', emailed: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(expect.arrayContaining(['ama@shop.test']));
    expect(JSON.stringify(sent[0])).toContain(tokenOf(q.public_url));
    // no e-mail address: still "sent" (the merchant shares the link on WhatsApp)
    const w = await newQuote({ customer_email: undefined, customer_phone: '+22961000000' });
    const s2 = await j(await call(`/v1/m/quotes/${w.q.id}/send`, { method: 'POST' }));
    expect(s2).toMatchObject({ status: 'sent', emailed: false });
  });

  it('editing a sent quote puts it back to draft; an accepted one cannot be edited', async () => {
    const { q } = await newQuote();
    await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' });
    const edited = await j(await call(`/v1/m/quotes/${q.id}`, { method: 'PATCH', json: { items: [{ sku, qty: 3 }] } }));
    expect(edited).toMatchObject({ status: 'draft', total_cents: 1350000 });
    await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' });
    await SELF.fetch(q.public_url.replace(/^https?:\/\/[^/]+/, 'http://localhost') + '/accept', { method: 'POST' });
    expect((await call(`/v1/m/quotes/${q.id}`, { method: 'PATCH', json: { note: 'x' } })).status).toBe(409);
  });

  it('a sent quote past its date reads as expired, and list can filter by status', async () => {
    const { q } = await newQuote();
    await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' });
    await newQuote();
    await db().run(`UPDATE quotes SET valid_until = '2020-01-01T00:00:00.000Z' WHERE id = ?`, [q.id]);
    expect((await j(await call(`/v1/m/quotes/${q.id}`))).status).toBe('expired');
    expect((await j(await call('/v1/m/quotes?status=expired'))).items).toHaveLength(1);
    expect((await j(await call('/v1/m/quotes?status=draft'))).items).toHaveLength(1);
  });

  it('delete: drafts yes; sent, accepted no', async () => {
    const a = (await newQuote()).q; const b = (await newQuote()).q;
    await call(`/v1/m/quotes/${b.id}/send`, { method: 'POST' });
    expect((await call(`/v1/m/quotes/${b.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await call(`/v1/m/quotes/${a.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await rows(`SELECT 1 FROM quotes`)).toHaveLength(1);
  });

  it('an accepted quote becomes an order: link it, once, to a real order', async () => {
    const { q } = await newQuote();
    const base = q.public_url.replace(/^https?:\/\/[^/]+/, 'http://localhost');
    expect((await call(`/v1/m/quotes/${q.id}/converted`, { json: { order_id: 'nope' } })).status).toBe(400);
    await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' });
    const o = await j(await call('/v1/orders/manual', { json: { customer_email: 'ama@shop.test', items: [{ sku, qty: 2 }] } }));
    const [{ id: orderId }] = await rows(`SELECT id FROM orders WHERE number = ?`, [o.order_number]);
    expect((await call(`/v1/m/quotes/${q.id}/converted`, { json: { order_id: orderId } })).status).toBe(409); // not accepted yet
    await SELF.fetch(`${base}/accept`, { method: 'POST' });
    const done = await call(`/v1/m/quotes/${q.id}/converted`, { json: { order_id: orderId } });
    expect(done.status).toBe(200);
    expect(await j(done)).toMatchObject({ status: 'converted', order_id: orderId });
  });
});

describe('quotes: the customer page', () => {
  let q: any; let base = '';
  const get = (path = '', init: RequestInit = {}) => SELF.fetch(`http://localhost${base}${path}`, { ...init, headers: { 'CF-Connecting-IP': `198.51.105.${(++ip % 250) + 1}`, ...(init.headers ?? {}) } });
  beforeEach(async () => {
    await enable();
    q = (await newQuote({ customer_name: '<script>alert(1)</script>', note: 'Livraison "offerte" & rapide' })).q;
    base = new URL(q.public_url).pathname;
  });

  it('a draft is not visible; a sent quote shows the lines, total and answer buttons, safely', async () => {
    expect((await get()).status).toBe(404);
    await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' });
    const r = await get();
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Q-0001');
    expect(html).toMatch(/9\s?000\s?(F\s?CFA|XOF)|900\s?000/); // total formatted for the currency
    expect(html).toContain('/accept'); expect(html).toContain('/decline');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Livraison &quot;offerte&quot; &amp; rapide');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('x-robots-tag')).toBe('noindex');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('accept is recorded once; a later decline changes nothing', async () => {
    await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' });
    const a = await get('/accept', { method: 'POST' });
    expect(a.status).toBe(200);
    expect(await a.text()).toMatch(/accepté/);
    expect((await j(await call(`/v1/m/quotes/${q.id}`))).status).toBe('accepted');
    await get('/decline', { method: 'POST' });
    expect((await j(await call(`/v1/m/quotes/${q.id}`))).status).toBe('accepted');
    expect(await rows(`SELECT action FROM audit_log WHERE action = 'quote.accepted'`)).toHaveLength(1);
  });

  it('decline works, and English is available', async () => {
    await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' });
    const en = await (await get('?lang=en')).text();
    expect(en).toContain('Accept the quotation');
    const d = await get('/decline', { method: 'POST' });
    expect(await d.text()).toMatch(/refusé/);
    expect((await j(await call(`/v1/m/quotes/${q.id}`))).status).toBe('declined');
  });

  it('an expired quote cannot be accepted', async () => {
    await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' });
    await db().run(`UPDATE quotes SET valid_until = '2020-01-01T00:00:00.000Z' WHERE id = ?`, [q.id]);
    const r = await get('/accept', { method: 'POST' });
    expect(await r.text()).toMatch(/plus valable/);
    expect((await rows(`SELECT status FROM quotes`))[0].status).toBe('sent');
  });

  it('wrong or malformed tokens are just "not found"', async () => {
    for (const t of ['x', 'a'.repeat(32), '../../v1/orders', 'a'.repeat(200)]) {
      expect((await SELF.fetch(`http://localhost/m/quotes/q/${encodeURIComponent(t)}`)).status).toBe(404);
    }
  });

  it('tells the merchant by e-mail when the customer answers (if CONTACT_NOTIFY_EMAIL is set)', async () => {
    await seedEmailConfig(db());
    await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' });
    sent.length = 0;
    const r = await SELF.fetch(`http://localhost${base}/accept`, { method: 'POST' });
    expect(r.status).toBe(200);
    // the test environment has no CONTACT_NOTIFY_EMAIL: nothing must be sent, and nothing must break
    await new Promise((x) => setTimeout(x, 80));
    expect(sent).toHaveLength(0);
  });
});
