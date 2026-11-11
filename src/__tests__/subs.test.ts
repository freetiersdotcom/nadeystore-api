// =============================================================================
// Subscriptions module: plans, renewal orders with a pay link, payment counting, dunning, skip / pause / cancel,
// the storefront start (cart attached to a plan) and the customer's private page.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct, seedCart, seedEmailConfig, mockFetch, MOCK_RESPONSES } from './setup';
import { roleCanRequest } from '../auth/permissions';
import { recordPayment } from '../lib/payments';
import { addPeriods, tick } from '../modules/subs/lib';

const stub = () => env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any;
const db = () => getDb(stub());
const CTX = () => ({ storeBaseUrl: 'https://shop.test', storeName: 'Santé', stub: stub(), exec: { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException() {} } as any });
let adminKey = ''; let ip = 0; let sent: any[] = []; let restore = () => {}; let sku = '';
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.118.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
    redirect: 'manual',
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const q = <T = any>(s: string, a: unknown[] = []) => db().query<T>(s, a);
const stock = async () => (await q<any>(`SELECT on_hand, reserved FROM inventory WHERE sku = ?`, [sku]))[0];
const run = () => tick(db(), CTX());
const plan = async (o: Record<string, unknown> = {}) => (await j(await call('/v1/m/subs/plans', { json: { sku, name: 'Monthly', unit: 'month', every_n: 1, price_cents: 9000, max_cycles: null, ...o } }))).id as string;
async function subscribe(planId: string, o: Record<string, unknown> = {}) {
  const r = await call('/v1/m/subs/subs', { json: { plan_id: planId, email: 'ama@shop.test', name: 'Ama', phone: '+22961000000', qty: 2, ...o } });
  expect(r.status).toBe(201); return (await j(r)).id as string;
}
const sub = async (id: string) => (await q<any>(`SELECT * FROM subscriptions WHERE id = ?`, [id]))[0];
const orderOf = async (id: string) => (await q<any>(`SELECT o.* FROM sub_orders so JOIN orders o ON o.id = so.order_id WHERE so.sub_id = ? ORDER BY so.cycle DESC LIMIT 1`, [id]))[0];
const pay = async (orderId: string) => { const [o] = await q<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]); await recordPayment(db(), o, { amount_cents: Number(o.total_cents) - Number(o.amount_paid_cents ?? 0), method: 'cash' }); };
const mails = () => sent.filter((m) => !String(m.subject).startsWith('[TEST]'));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(async () => {
  const d = db();
  for (const t of ['sub_orders', 'sub_carts', 'subscriptions', 'sub_plans', 'sub_settings']) await d.run(`DROP TABLE IF EXISTS ${t}`);
  await d.run(`DELETE FROM config WHERE key IN ('modules', 'email')`);
  for (const t of ['refunds', 'order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'customer_addresses', 'customers', 'inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) { try { await d.run(`DELETE FROM ${t}`); } catch { /* ignore */ } }
  adminKey = (await seedApiKeys(d)).adminKey;
  sku = (await seedProduct(d, { price_cents: 10000, on_hand: 20 })).sku;
  await d.run(`UPDATE variants SET currency = 'XOF'`);
  sent = []; await seedEmailConfig(d);
  restore = mockFetch((url, init) => { if (url.includes('api.resend.com')) { sent.push(JSON.parse(String(init?.body))); return MOCK_RESPONSES.resendSend(); } return new Response('{}', { status: 200 }); });
  expect((await call('/v1/modules/subs', { method: 'PUT', json: { enabled: true } })).status).toBe(200);
  expect((await call('/v1/m/subs/plans')).status).toBe(200);   // remembers the API address for the manage link
});
afterEach(() => restore());

describe('dates', () => {
  it('months keep their day without drifting (31st → end of February → 31st again), weeks add 7 days', () => {
    const s = '2026-01-31T09:00:00.000Z';
    expect(addPeriods(s, 'month', 1, 1)).toBe('2026-02-28T09:00:00.000Z'); expect(addPeriods(s, 'month', 1, 2)).toBe('2026-03-31T09:00:00.000Z');
    expect(addPeriods(s, 'month', 2, 1)).toBe('2026-03-31T09:00:00.000Z'); expect(addPeriods(s, 'week', 2, 1)).toBe('2026-02-14T09:00:00.000Z');
    expect(addPeriods('2026-11-30T00:00:00.000Z', 'month', 3, 1)).toBe('2027-02-28T00:00:00.000Z');
  });
});

describe('plans and access', () => {
  it('is off until enabled; staff can look but not change; managers can change', async () => {
    await db().run(`DELETE FROM config WHERE key = 'modules'`);
    expect((await call('/v1/m/subs/plans')).status).toBe(404); expect((await call('/m/subs/plans?sku=x', { key: null })).status).toBe(404);
    expect(roleCanRequest('staff', 'GET', '/v1/m/subs/subs').ok).toBe(true); expect(roleCanRequest('staff', 'POST', '/v1/m/subs/plans').ok).toBe(false);
    expect(roleCanRequest('staff', 'POST', '/v1/m/subs/subs/abc/action').ok).toBe(false); expect(roleCanRequest('manager', 'POST', '/v1/m/subs/plans').ok).toBe(true);
  });

  it('creates a plan on an existing variant, refuses unknown products and silly values, and lists subscribers per plan', async () => {
    expect((await call('/v1/m/subs/plans', { json: { sku: 'NOPE', name: 'x', unit: 'month', every_n: 1, price_cents: 100 } })).status).toBe(400);
    expect((await call('/v1/m/subs/plans', { json: { sku, name: 'x', unit: 'year', every_n: 1, price_cents: 100 } })).status).toBe(400);
    expect((await call('/v1/m/subs/plans', { json: { sku, name: 'x', unit: 'month', every_n: 0, price_cents: 100 } })).status).toBe(400);
    const id = await plan(); await subscribe(id);
    const l = await j(await call('/v1/m/subs/plans')); expect(l.items[0]).toMatchObject({ id, subscribers: 1, active_subscribers: 1, currency: 'XOF' });
  });

  it('a plan with subscribers cannot be deleted (switch it off instead); an unused one can', async () => {
    const used = await plan(); await subscribe(used); const free = await plan({ name: 'Free' });
    expect((await call(`/v1/m/subs/plans/${used}`, { method: 'DELETE' })).status).toBe(409);
    expect((await call(`/v1/m/subs/plans/${free}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/v1/m/subs/plans/${used}`, { method: 'PUT', json: { sku, name: 'Monthly', unit: 'month', every_n: 1, price_cents: 9000, active: false } })).status).toBe(200);
    expect((await j(await call(`/m/subs/plans?sku=${sku}`, { key: null }))).items).toHaveLength(0);
  });
});

describe('renewal orders', () => {
  it('creates the order of a due cycle once: pending, stock taken, pay link e-mailed, next date one interval later', async () => {
    const id = await plan(); const sid = await subscribe(id);
    const before = await stock();
    expect(await run()).toMatchObject({ renewed: 1 });
    const s = await sub(sid); const o = await orderOf(sid);
    expect(o).toMatchObject({ status: 'pending', total_cents: 18000, currency: 'XOF', customer_email: 'ama@shop.test' }); expect(o.pay_token).toHaveLength(64);
    expect(o.due_at ?? null).toBeNull();                                         // the module has its own deadline; the deposit sweep must not touch these orders
    expect((await stock()).on_hand + (await stock()).reserved).toBeLessThanOrEqual(before.on_hand + before.reserved);
    expect(s).toMatchObject({ billed: 1, period: 1, cycles_done: 0, status: 'active' }); expect(Date.parse(s.next_due_at)).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    expect(mails()).toHaveLength(1); expect(mails()[0].to).toContain('ama@shop.test');
    expect(mails()[0].html).toContain(`https://shop.test/fr/paiement/?token=${o.pay_token}`); expect(mails()[0].html).toContain('/m/subs/manage/');
    expect(await run()).toMatchObject({ renewed: 0 }); expect(await q(`SELECT 1 FROM sub_orders`)).toHaveLength(1);
  });

  it('does not create the order before the lead time, and does when the due date comes within it', async () => {
    const id = await plan(); const sid = await subscribe(id, { start_date: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) });
    expect(await run()).toMatchObject({ renewed: 0 });
    await db().run(`UPDATE subscriptions SET next_due_at = ? WHERE id = ?`, [new Date(Date.now() + 2 * 86_400_000).toISOString(), sid]);
    expect(await run()).toMatchObject({ renewed: 1 });
  });

  it('a paid renewal is counted; the last cycle of a limited plan ends the subscription and no further order is created', async () => {
    const id = await plan({ max_cycles: 1 }); const sid = await subscribe(id);
    await run(); await pay((await orderOf(sid)).id);   // paying also nudges the module, so the cycle is already counted
    expect(await sub(sid)).toMatchObject({ cycles_done: 1, status: 'ended' }); expect(await run()).toMatchObject({ counted: 0 });
    await db().run(`UPDATE subscriptions SET status = 'active', next_due_at = ? WHERE id = ?`, [daysAgo(1), sid]);
    expect(await run()).toMatchObject({ renewed: 0 }); expect(await q(`SELECT 1 FROM sub_orders`)).toHaveLength(1);
  });

  it('waits for stock without creating an order, then creates it once restocked', async () => {
    const id = await plan(); const sid = await subscribe(id, { qty: 5 });
    await db().run(`UPDATE inventory SET on_hand = 2 WHERE sku = ?`, [sku]);
    expect(await run()).toMatchObject({ renewed: 0, waiting: 1 }); expect((await sub(sid)).waiting_stock).toBe(1); expect(await q(`SELECT 1 FROM orders`)).toHaveLength(0);
    await db().run(`UPDATE inventory SET on_hand = 50 WHERE sku = ?`, [sku]);
    expect(await run()).toMatchObject({ renewed: 1 }); expect((await sub(sid)).waiting_stock).toBe(0);
  });

  it('keeps the price the subscriber signed up at when the plan price changes later', async () => {
    const id = await plan(); const sid = await subscribe(id);
    await call(`/v1/m/subs/plans/${id}`, { method: 'PUT', json: { sku, name: 'Monthly', unit: 'month', every_n: 1, price_cents: 20000 } });
    await run(); expect((await orderOf(sid)).total_cents).toBe(18000);
  });

  it('the merchant can create the next order right now, but not twice for the same cycle', async () => {
    const id = await plan(); const sid = await subscribe(id, { start_date: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10) });
    expect((await call(`/v1/m/subs/subs/${sid}/renew-now`, { json: {} })).status).toBe(200);
    expect((await call(`/v1/m/subs/subs/${sid}/renew-now`, { json: {} })).status).toBe(400);
  });
});

describe('unpaid, reminders, pause, skip, cancel', () => {
  it('sends one reminder close to the due date, and only one', async () => {
    const id = await plan(); const sid = await subscribe(id); await run(); sent = [];
    await db().run(`UPDATE sub_orders SET due_at = ? WHERE sub_id = ?`, [new Date(Date.now() + 12 * 3_600_000).toISOString(), sid]);
    expect(await run()).toMatchObject({ reminded: 1 }); expect(await run()).toMatchObject({ reminded: 0 }); expect(mails()).toHaveLength(1);
  });

  it('cancels an unpaid order after the grace period (stock back), pauses the subscription and tells the customer; resuming brings the next order at once', async () => {
    const id = await plan(); const sid = await subscribe(id); await run(); const o = await orderOf(sid); const held = await stock(); sent = [];
    await db().run(`UPDATE sub_orders SET due_at = ? WHERE sub_id = ?`, [daysAgo(4), sid]);
    expect(await run()).toMatchObject({ paused: 1 });
    expect((await orderOf(sid)).status).toBe('canceled'); expect(await sub(sid)).toMatchObject({ status: 'paused', pause_reason: 'unpaid' });
    expect((await stock()).on_hand).toBe(held.on_hand + 2); expect(mails()).toHaveLength(1); expect(mails()[0].subject).toContain('pause');
    expect(await run()).toMatchObject({ paused: 0, renewed: 0 });
    expect((await call(`/v1/m/subs/subs/${sid}/action`, { json: { action: 'resume' } })).status).toBe(200);
    expect(await run()).toMatchObject({ renewed: 1 }); expect(o.id).not.toBe((await orderOf(sid)).id);
  });

  it('a paid order is never cancelled by the grace rule', async () => {
    const id = await plan(); const sid = await subscribe(id); await run(); await pay((await orderOf(sid)).id);
    await db().run(`UPDATE sub_orders SET due_at = ? WHERE sub_id = ?`, [daysAgo(30), sid]);
    expect(await run()).toMatchObject({ paused: 0 }); expect((await orderOf(sid)).status).toBe('paid'); expect((await sub(sid)).cycles_done).toBe(1);
  });

  it('skip: moves the next date when nothing is open; drops the open unpaid order instead; refuses when already paid', async () => {
    const id = await plan(); const sid = await subscribe(id, { start_date: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10) });
    const due = (await sub(sid)).next_due_at;
    expect((await call(`/v1/m/subs/subs/${sid}/action`, { json: { action: 'skip' } })).status).toBe(200);
    expect((await sub(sid)).next_due_at).not.toBe(due); expect(Date.parse((await sub(sid)).next_due_at)).toBeGreaterThan(Date.parse(due) + 27 * 86_400_000);
    await db().run(`UPDATE subscriptions SET next_due_at = ? WHERE id = ?`, [new Date(Date.now() + 86_400_000).toISOString(), sid]);
    await run(); const o = await orderOf(sid); const next = (await sub(sid)).next_due_at;
    expect((await call(`/v1/m/subs/subs/${sid}/action`, { json: { action: 'skip' } })).status).toBe(200);
    expect((await orderOf(sid)).status).toBe('canceled'); expect((await sub(sid)).next_due_at).toBe(next); expect(o.id).toBeTruthy();
    await db().run(`UPDATE subscriptions SET next_due_at = ? WHERE id = ?`, [new Date(Date.now() + 86_400_000).toISOString(), sid]); await run();
    await db().run(`UPDATE orders SET amount_paid_cents = total_cents WHERE id = ?`, [(await orderOf(sid)).id]);   // paid but not yet counted: it is being prepared
    expect((await call(`/v1/m/subs/subs/${sid}/action`, { json: { action: 'skip' } })).status).toBe(400);
  });

  it('pause and cancel drop the unpaid order, give the stock back and stop further orders', async () => {
    const id = await plan(); const a = await subscribe(id); const b = await subscribe(id, { email: 'kofi@shop.test' }); await run();
    const full = await stock();
    await call(`/v1/m/subs/subs/${a}/action`, { json: { action: 'pause' } }); await call(`/v1/m/subs/subs/${b}/action`, { json: { action: 'cancel' } });
    expect((await orderOf(a)).status).toBe('canceled'); expect((await orderOf(b)).status).toBe('canceled'); expect((await stock()).on_hand).toBe(full.on_hand + 4);
    expect(await sub(a)).toMatchObject({ status: 'paused' }); expect(await sub(b)).toMatchObject({ status: 'canceled' });
    await db().run(`UPDATE subscriptions SET next_due_at = ?`, [daysAgo(1)]); expect(await run()).toMatchObject({ renewed: 0 });
    expect((await call(`/v1/m/subs/subs/${b}/action`, { json: { action: 'resume' } })).status).toBe(400);
  });
});

describe('starting from the storefront', () => {
  const cartWith = async (qty = 1, currency = 'XOF') => { const cart = await seedCart(db(), [{ sku, qty, price_cents: 10000 }]); await db().run(`UPDATE carts SET currency = ?, status = 'open' WHERE id = ?`, [currency, cart]); return cart; };

  it('attaching a plan sets its price on the cart line; refuses carts without that product, in another currency or already checked out', async () => {
    const id = await plan({ price_cents: 8000 }); const cart = await cartWith(2);
    expect(await j(await call('/m/subs/attach', { key: null, json: { cart_id: cart, plan_id: id } }))).toEqual({ attached: true, price_cents: 8000 });
    expect((await q<any>(`SELECT unit_price_cents FROM cart_items WHERE cart_id = ?`, [cart]))[0].unit_price_cents).toBe(8000);
    const eur = await cartWith(1, 'EUR'); expect((await j(await call('/m/subs/attach', { key: null, json: { cart_id: eur, plan_id: id } }))).attached).toBe(false);
    const done = await cartWith(); await db().run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [done]);
    expect((await j(await call('/m/subs/attach', { key: null, json: { cart_id: done, plan_id: id } }))).attached).toBe(false);
    expect((await call('/m/subs/attach', { key: null, json: { cart_id: 'short', plan_id: id } })).status).toBe(400);
    expect((await j(await call('/m/subs/attach', { key: null, json: { cart_id: cart, plan_id: 'nope' } }))).attached).toBe(false);
  });

  it('once the cart’s order is paid the subscription starts with its address and delivery, the first cycle counted and the next one due in one interval; never twice', async () => {
    const id = await plan({ price_cents: 8000 }); const cart = await cartWith(2);
    await call('/m/subs/attach', { key: null, json: { cart_id: cart, plan_id: id } });
    const paidAt = new Date(Date.now() - 3_600_000).toISOString(); const ship = { line1: '1 rue X', city: 'Cotonou', country: 'BJ', postal_code: '', phone: '+22961000000' };
    await db().run(`INSERT INTO orders (id, number, status, customer_email, shipping_name, shipping_phone, ship_to, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, cart_id, amount_paid_cents, paid_at, locale, shipping_label)
                    VALUES ('o-1', 'N-1', 'paid', 'ama@shop.test', 'Ama', '+22961000000', ?, 16000, 0, 1500, 17500, 'XOF', ?, 17500, ?, 'en', 'Courier')`, [JSON.stringify(ship), cart, paidAt]);
    await db().run(`INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES ('i-1', 'o-1', ?, 'Tea', 2, 8000)`, [sku]);
    expect(await run()).toMatchObject({ started: 1 }); expect(await run()).toMatchObject({ started: 0 });
    const [s] = await q<any>(`SELECT * FROM subscriptions`);
    expect(s).toMatchObject({ email: 'ama@shop.test', qty: 2, unit_price_cents: 8000, shipping_cents: 1500, shipping_label: 'Courier', locale: 'en', cycles_done: 1, billed: 1, period: 1, source_order_id: 'o-1', status: 'active' });
    expect(JSON.parse(s.ship_to).city).toBe('Cotonou'); expect(Date.parse(s.next_due_at)).toBeGreaterThan(Date.parse(paidAt) + 27 * 86_400_000);
    expect(await q(`SELECT 1 FROM orders`)).toHaveLength(1);   // the first cycle is that order; nothing is billed twice
  });

  it('an unpaid or cancelled first order starts nothing', async () => {
    const id = await plan(); const cart = await cartWith(); await call('/m/subs/attach', { key: null, json: { cart_id: cart, plan_id: id } });
    await db().run(`INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, cart_id, amount_paid_cents) VALUES ('o-2', 'N-2', 'pending', 'ama@shop.test', 10000, 0, 0, 10000, 'XOF', ?, 0)`, [cart]);
    expect(await run()).toMatchObject({ started: 0 });
  });
});

describe('the customer’s private page', () => {
  const token = async (sid: string) => (await q<any>(`SELECT token FROM subscriptions WHERE id = ?`, [sid]))[0].token as string;
  const html = async (r: Response) => r.text();

  it('shows the subscription, never leaks it without the exact link, and escapes what the merchant typed', async () => {
    const id = await plan(); const sid = await subscribe(id); await db().run(`UPDATE subscriptions SET title = ? WHERE id = ?`, ['<img src=x onerror=alert(1)> Tea', sid]);
    const t = await token(sid); const r = await call(`/m/subs/manage/${t}?lang=en`, { key: null }); const h = await html(r);
    expect(r.status).toBe(200); expect(h).toContain('My subscription'); expect(h).toContain('every month'); expect(h).not.toContain('<img'); expect(h).toContain('&lt;img');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'"); expect(r.headers.get('cache-control')).toContain('no-store');
    expect((await call(`/m/subs/manage/${'z'.repeat(24)}`, { key: null })).status).toBe(404); expect((await call('/m/subs/manage/short', { key: null })).status).toBe(404);
    expect((await call(`/m/subs/manage/${t}/explode`, { key: null, json: {} })).status).toBe(404);
  });

  it('pause, resume, skip and a two-step stop work from the link; the order waiting for payment shows its pay link', async () => {
    const id = await plan(); const sid = await subscribe(id); const t = await token(sid); await run();
    const page = await html(await call(`/m/subs/manage/${t}`, { key: null })); expect(page).toContain('/fr/paiement/?token=');
    expect((await sub(sid)).status).toBe('active');
    expect(await html(await call(`/m/subs/manage/${t}/pause`, { key: null, method: 'POST' }))).toContain('mis en pause'); expect((await sub(sid)).status).toBe('paused'); expect((await orderOf(sid)).status).toBe('canceled');
    await call(`/m/subs/manage/${t}/resume`, { key: null, method: 'POST' }); expect((await sub(sid)).status).toBe('active');
    const confirm = await html(await call(`/m/subs/manage/${t}?confirm=cancel`, { key: null })); expect(confirm).toContain('/cancel?lang=fr'); expect((await sub(sid)).status).toBe('active');   // a GET never stops anything
    await call(`/m/subs/manage/${t}/cancel`, { key: null, method: 'POST' }); expect((await sub(sid)).status).toBe('canceled');
    expect(await html(await call(`/m/subs/manage/${t}`, { key: null }))).toContain('terminé');
  });
});

describe('admin', () => {
  it('lists and filters subscribers, edits one, and the totals add up', async () => {
    const id = await plan(); const a = await subscribe(id); await subscribe(id, { email: 'kofi@shop.test', name: 'Kofi' }); await call(`/v1/m/subs/subs/${a}/action`, { json: { action: 'pause' } });
    const all = await j(await call('/v1/m/subs/subs')); expect(all.items).toHaveLength(2); expect(all.totals).toEqual({ active: 1, paused: 1 });
    expect((await j(await call('/v1/m/subs/subs?status=paused'))).items.map((x: any) => x.email)).toEqual(['ama@shop.test']);
    expect((await j(await call('/v1/m/subs/subs?q=kofi'))).items).toHaveLength(1); expect(JSON.stringify(all)).not.toContain('"token"');
    expect((await call(`/v1/m/subs/subs/${a}`, { method: 'PATCH', json: { qty: 3, unit_price_cents: 7000, note: 'VIP' } })).status).toBe(200);
    expect(await sub(a)).toMatchObject({ qty: 3, unit_price_cents: 7000, note: 'VIP' });
    expect((await call(`/v1/m/subs/subs/${a}`, { method: 'PATCH', json: { address: { line1: 'x', city: 'y', country: 'ZZ' } } })).status).toBe(400);
    expect((await call('/v1/m/subs/subs', { json: { plan_id: 'nope', email: 'x@y.test' } })).status).toBe(400);
    expect((await call('/v1/m/subs/subs', { json: { plan_id: id, email: 'not-an-email' } })).status).toBe(400);
  });

  it('the settings change the lead time and the grace period', async () => {
    expect(await j(await call('/v1/m/subs/settings'))).toEqual({ lead_days: 3, remind_days: 1, grace_days: 3 });
    expect((await call('/v1/m/subs/settings', { method: 'PUT', json: { lead_days: 0, remind_days: 0, grace_days: 10 } })).status).toBe(200);
    const id = await plan(); await subscribe(id, { start_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) });
    expect(await run()).toMatchObject({ renewed: 0 });   // lead time 0: not before the day itself
    expect((await call('/v1/m/subs/settings', { method: 'PUT', json: { lead_days: 99, remind_days: 0, grace_days: 1 } })).status).toBe(400);
  });
});
