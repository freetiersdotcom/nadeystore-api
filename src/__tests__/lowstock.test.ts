// =============================================================================
// Low-stock alerts: thresholds, announce-once, escalation to "out", re-arming, suppliers, digest mail.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct, seedEmailConfig, mockFetch, MOCK_RESPONSES } from './setup';
import { runScheduledHooks } from '../modules/registry';
import { recordPayment } from '../lib/payments';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let ip = 0; let sent: any[] = []; let restore = () => {};
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.109.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
    redirect: 'manual',
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const wait = () => new Promise((r) => setTimeout(r, 100));
const check = async () => j(await call('/v1/m/lowstock/check', { json: {} }));
const stock = (sku: string, onHand: number, reserved = 0) => db().run(`UPDATE inventory SET on_hand = ?, reserved = ? WHERE sku = ?`, [onHand, reserved, sku]);
const item = async (sku: string) => (await j(await call('/v1/m/lowstock'))).items.find((x: any) => x.sku === sku);
const put = (path: string, json: unknown) => call(path, { method: 'PUT', json });
let sku = '';

beforeEach(async () => {
  const d = db();
  for (const t of ['lowstock_items', 'lowstock_state', 'lowstock_suppliers', 'lowstock_settings']) await d.run(`DROP TABLE IF EXISTS ${t}`);
  await d.run(`DELETE FROM config WHERE key IN ('modules', 'email')`);
  for (const t of ['refunds', 'order_payments', 'order_items', 'orders', 'inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) await d.run(`DELETE FROM ${t}`);
  await d.run(`DELETE FROM audit_log WHERE action LIKE 'lowstock.%' OR action LIKE 'module.%'`);
  adminKey = (await seedApiKeys(d)).adminKey; sku = (await seedProduct(d, { on_hand: 20 })).sku;
  sent = []; await seedEmailConfig(d);
  restore = mockFetch((url, init) => { if (url.includes('api.resend.com')) { sent.push(JSON.parse(String(init?.body))); return MOCK_RESPONSES.resendSend(); } return new Response('{}', { status: 200 }); });
  expect((await call('/v1/modules/lowstock', { method: 'PUT', json: { enabled: true } })).status).toBe(200);
  expect((await put('/v1/m/lowstock/settings', { default_threshold: 5, emails: 'owner@shop.test', push: false })).status).toBe(200);
});
afterEach(async () => { await wait(); restore(); });

describe('lowstock: levels', () => {
  it('is off by default', async () => {
    await db().run(`DELETE FROM config WHERE key = 'modules'`);
    expect((await call('/v1/m/lowstock')).status).toBe(404);
  });
  it('uses available = on hand - reserved, the default threshold, and a per-product override', async () => {
    expect((await item(sku)).level).toBe('ok');
    await stock(sku, 8, 3); expect(await item(sku)).toMatchObject({ available: 5, level: 'low', threshold: 5 });
    await stock(sku, 8, 2); expect((await item(sku)).level).toBe('ok');
    await put(`/v1/m/lowstock/items/${sku}`, { threshold: 10 }); expect(await item(sku)).toMatchObject({ level: 'low', threshold: 10 });
    await stock(sku, 3, 3); expect((await item(sku)).level).toBe('out');
  });
  it('ignores digital goods, services and draft products', async () => {
    await stock(sku, 0); await db().run(`UPDATE variants SET product_type = 'digital' WHERE sku = ?`, [sku]);
    expect(await item(sku)).toBeUndefined();
    await db().run(`UPDATE variants SET product_type = 'physical' WHERE sku = ?`, [sku]); expect(await item(sku)).toBeTruthy();
    await db().run(`UPDATE products SET status = 'draft'`); expect(await item(sku)).toBeUndefined();
  });
});

describe('lowstock: announcements', () => {
  it('announces once when a product drops, not on every run', async () => {
    expect((await check()).announced).toBe(0); await stock(sku, 4);
    expect((await check()).announced).toBe(1); expect((await check()).announced).toBe(0); expect((await check()).announced).toBe(0);
    await wait(); expect(sent.length).toBe(1); expect(sent[0].to).toEqual(['owner@shop.test']); expect(sent[0].html).toContain('Test Product');
  });
  it('announces again if it then runs out, and re-arms once restocked', async () => {
    await stock(sku, 4); await check(); await stock(sku, 0); expect((await check()).announced).toBe(1); expect((await check()).announced).toBe(0);
    await wait(); expect(sent.length).toBe(2); expect(sent[1].subject).toMatch(/rupture/);
    await stock(sku, 50); expect((await check()).announced).toBe(0);
    await stock(sku, 2); expect((await check()).announced).toBe(1);
  });
  it('one mail for several products', async () => {
    const b = (await seedProduct(db(), { on_hand: 1 })).sku; await stock(sku, 2);
    expect((await check()).announced).toBe(2); await wait(); expect(sent.length).toBe(1); expect(JSON.stringify(sent[0])).toContain('Test Product');
    expect(b).toBeTruthy();
  });
  it('a muted product is never announced; unmuting works; a changed threshold re-arms', async () => {
    await put(`/v1/m/lowstock/items/${sku}`, { muted: true }); await stock(sku, 1); expect((await check()).announced).toBe(0);
    await put(`/v1/m/lowstock/items/${sku}`, { muted: false }); expect((await check()).announced).toBe(1);
    await put(`/v1/m/lowstock/items/${sku}`, { threshold: 9 }); expect((await check()).announced).toBe(1);
  });
  it('no recipients and no push: nothing is sent, nothing breaks; no e-mail provider also fine', async () => {
    await put('/v1/m/lowstock/settings', { default_threshold: 5, emails: '', push: false }); await stock(sku, 1);
    expect((await check()).announced).toBe(1); await wait(); expect(sent.length).toBe(0);
    await db().run(`DELETE FROM lowstock_state`); await put('/v1/m/lowstock/settings', { default_threshold: 5, emails: 'a@x.test', push: false }); await db().run(`DELETE FROM config WHERE key = 'email'`);
    expect((await check()).announced).toBe(1);
  });
  it('the cron hook and a payment both trigger the check', async () => {
    await stock(sku, 3); await runScheduledHooks(db(), { storeBaseUrl: 'https://shop.test', storeName: 'Santé' }); await wait();
    expect(sent.length).toBe(1); expect(sent[0].subject).toContain('Santé');
    await db().run(`DELETE FROM lowstock_state`);
    const id = 'o-1'; await db().run(`INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, amount_paid_cents, created_at) VALUES (?, 'N-1', 'pending', 'b@x.test', 100, 0, 0, 100, 'XOF', 0, ?)`, [id, new Date().toISOString()]);
    const [o] = await db().query<any>(`SELECT * FROM orders WHERE id = ?`, [id]);
    await recordPayment(db(), o, { amount_cents: 100, method: 'cash' } as any); await wait();
    expect(sent.length).toBe(2);
  });
  it('escapes names in the mail', async () => {
    await db().run(`UPDATE products SET title = '<b>x</b>'`); await stock(sku, 1); await check(); await wait();
    expect(sent[0].html).not.toContain('<b>x</b>'); expect(sent[0].html).toContain('&lt;b&gt;');
  });
});

describe('lowstock: suppliers and reorder message', () => {
  it('links a supplier, builds the message in both languages, deleting the supplier unlinks it', async () => {
    const s = await j(await call('/v1/m/lowstock/suppliers', { json: { name: 'Mama Karité', phone: '+22961000000', email: null } }));
    expect(s.id).toBeTruthy();
    expect((await put(`/v1/m/lowstock/items/${sku}`, { supplier_id: s.id, reorder_qty: 40 })).status).toBe(200);
    const fr = await j(await call(`/v1/m/lowstock/items/${sku}/message`)); expect(fr.message).toContain('Mama Karité'); expect(fr.message).toContain('40 × Test Product'); expect(fr.supplier.phone).toBe('+22961000000');
    expect((await j(await call(`/v1/m/lowstock/items/${sku}/message?lang=en`))).message).toMatch(/reorder 40/);
    await stock(sku, 1); await check(); await wait(); expect(sent[0].html).toContain('+22961000000');
    expect((await call(`/v1/m/lowstock/suppliers/${s.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await item(sku)).supplier_id).toBeNull();
    expect((await put(`/v1/m/lowstock/items/${sku}`, { supplier_id: 'nope' })).status).toBe(400);
    expect((await put(`/v1/m/lowstock/items/NOPE`, { threshold: 1 })).status).toBe(404);
  });
  it('validates settings and needs a key', async () => {
    expect((await put('/v1/m/lowstock/settings', { default_threshold: -1, emails: '', push: true })).status).toBe(400);
    const r = await j(await put('/v1/m/lowstock/settings', { default_threshold: 7, emails: 'a@x.test, not-an-email, A@x.test', push: true })); expect(r.emails).toBe('a@x.test');
    expect((await call('/v1/m/lowstock', { key: null })).status).toBe(401);
  });
});
