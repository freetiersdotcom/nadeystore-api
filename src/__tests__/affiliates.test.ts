// =============================================================================
// Affiliates module: link/code attribution, commission rules, payouts, affiliate page.
// Orders are inserted directly so every payment/refund state can be set exactly.
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys } from './setup';
import { roleCanRequest } from '../auth/permissions';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let ip = 0; let seq = 0;
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.105.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
    redirect: 'manual',
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const rows = <T = any>(q: string, a: unknown[] = []) => db().query<T>(q, a);
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

async function newAffiliate(extra: Record<string, unknown> = {}) {
  const r = await call('/v1/m/affiliates', { json: { name: 'Kofi Mensah', rate_percent: 10, email: 'kofi@partner.test', ...extra } });
  return { status: r.status, a: await j(r) };
}
async function newCart(status = 'open') {
  const id = `cart-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  await db().run(`INSERT INTO carts (id, status, customer_email, currency, expires_at) VALUES (?, ?, 'x@y.test', 'XOF', ?)`, [id, status, iso(-1)]);
  return id;
}
/** An order the way the core stores it: totals, what was paid (with its date), optional refund. */
async function newOrder(o: { cart?: string | null; email?: string; subtotal?: number; discount?: number; shipping?: number; paid?: number; paidDaysAgo?: number; status?: string; refunded?: number; code?: string; currency?: string } = {}) {
  const id = `ord-${++seq}`; const subtotal = o.subtotal ?? 10000; const discount = o.discount ?? 0; const shipping = o.shipping ?? 0;
  const total = subtotal - discount + shipping; const paid = o.paid ?? total;
  await db().run(
    `INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, discount_code, discount_amount_cents, cart_id, amount_paid_cents, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, `N-${id}`, o.status ?? (paid >= total ? 'paid' : 'pending'), o.email ?? 'buyer@shop.test', subtotal, shipping, total, o.currency ?? 'XOF', o.code ?? null, discount, o.cart ?? null, paid, iso(o.paidDaysAgo ?? 30)]
  );
  if (paid > 0) await db().run(`INSERT INTO order_payments (id, order_id, amount_cents, method, created_at) VALUES (?, ?, ?, 'cash', ?)`, [`pay-${id}`, id, paid, iso(o.paidDaysAgo ?? 30)]);
  if (o.refunded) await db().run(`INSERT INTO refunds (id, order_id, stripe_refund_id, amount_cents, status) VALUES (?, ?, 'manual', ?, 'succeeded')`, [`ref-${id}`, id, o.refunded]);
  return id;
}
const attach = (cart_id: string, ref: string) => call('/m/affiliates/attach', { key: null, json: { cart_id, ref } });
const detail = async (id: string) => j(await call(`/v1/m/affiliates/${id}`));
const xof = (d: any) => d.totals.find((t: any) => t.currency === 'XOF') ?? { available_cents: 0, pending_cents: 0, paid_out_cents: 0, balance_cents: 0 };

beforeEach(async () => {
  const d = db();
  for (const t of ['affiliates', 'affiliate_referrals', 'affiliate_orders', 'affiliate_payouts', 'affiliate_settings']) await d.run(`DROP TABLE IF EXISTS ${t}`);
  await d.run(`DELETE FROM config WHERE key = 'modules'`);
  await d.run(`DELETE FROM audit_log WHERE action LIKE 'affiliate.%' OR action LIKE 'module.%'`);
  for (const t of ['refunds', 'order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'api_keys']) await d.run(`DELETE FROM ${t}`);
  adminKey = (await seedApiKeys(d)).adminKey;
  expect((await call('/v1/modules/affiliates', { method: 'PUT', json: { enabled: true } })).status).toBe(200);
});

describe('affiliates: setup', () => {
  it('is off until enabled (routes 404, no tables)', async () => {
    await db().run(`DROP TABLE affiliates`); await db().run(`DELETE FROM config WHERE key = 'modules'`);
    expect((await call('/v1/m/affiliates')).status).toBe(404);
    expect((await call('/m/affiliates/a/abcdefghijklmnopqrstuvwx', { key: null })).status).toBe(404);
    expect((await call('/m/affiliates/attach', { key: null, json: { cart_id: 'abcdefgh', ref: 'X' } })).status).toBe(404);
  });

  it('creates an affiliate with a generated code, a link and a private page', async () => {
    const { status, a } = await newAffiliate();
    expect(status).toBe(201);
    expect(a.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(a.rate_percent).toBe(10);
    expect(a.link).toContain(`/?ref=${a.code}`);
    expect(a.portal_url).toMatch(/\/m\/affiliates\/a\/[A-Za-z0-9_-]{20,}$/);
  });

  it('accepts a chosen code (any case), refuses duplicates and bad codes, validates the rate', async () => {
    expect((await newAffiliate({ code: 'kofi10' })).a.code).toBe('KOFI10');
    expect((await newAffiliate({ code: 'KOFI10', name: 'Other' })).status).toBe(409);
    expect((await newAffiliate({ code: 'a b', name: 'Other' })).status).toBe(400);
    expect((await newAffiliate({ rate_percent: 101 })).status).toBe(400);
    expect((await newAffiliate({ rate_percent: -1 })).status).toBe(400);
    expect((await newAffiliate({ name: '' })).status).toBe(400);
    expect((await newAffiliate({ rate_percent: 7.5 })).a.rate_percent).toBe(7.5);
  });

  it('requires admin sign-in and the right role', async () => {
    expect((await call('/v1/m/affiliates', { key: null })).status).toBe(401);
    expect(roleCanRequest('manager', 'GET', '/v1/m/affiliates').ok).toBe(true);
    expect(roleCanRequest('manager', 'POST', '/v1/m/affiliates/abc/payouts').ok).toBe(false);   // owners record payouts
    expect(roleCanRequest('staff', 'GET', '/v1/m/affiliates').ok).toBe(false);
    expect(roleCanRequest('owner', 'POST', '/v1/m/affiliates/abc/payouts').ok).toBe(true);
  });
});

describe('affiliates: attribution', () => {
  it('attaches an open cart to the affiliate by code; the latest link wins', async () => {
    const a = (await newAffiliate({ code: 'AAA111' })).a; const b = (await newAffiliate({ code: 'BBB222', name: 'Other', email: 'o@p.test' })).a;
    const cart = await newCart();
    expect((await j(await attach(cart, 'aaa111'))).attached).toBe(true);
    expect((await j(await attach(cart, 'BBB222'))).attached).toBe(true);
    await newOrder({ cart });
    expect((await detail(a.id)).orders).toHaveLength(0);
    expect((await detail(b.id)).orders).toHaveLength(1);
  });

  it('ignores unknown codes, paused affiliates, closed carts and unknown carts', async () => {
    const a = (await newAffiliate({ code: 'AAA111' })).a;
    expect((await j(await attach(await newCart(), 'NOPE'))).attached).toBe(false);
    expect((await j(await attach(await newCart('checked_out'), 'AAA111'))).attached).toBe(false);
    expect((await j(await attach('cart-does-not-exist', 'AAA111'))).attached).toBe(false);
    await call(`/v1/m/affiliates/${a.id}`, { method: 'PATCH', json: { status: 'paused' } });
    expect((await j(await attach(await newCart(), 'AAA111'))).attached).toBe(false);
    expect((await call('/m/affiliates/attach', { key: null, json: { cart_id: 'x' } })).status).toBe(400);
  });

  it('works without a key and answers cross-origin calls from the storefront', async () => {
    await newAffiliate({ code: 'AAA111' });
    const r = await call('/m/affiliates/attach', { key: null, json: { cart_id: await newCart(), ref: 'AAA111' }, headers: { Origin: 'https://shop.example' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('attributes orders that used the affiliate’s linked discount code', async () => {
    const a = (await newAffiliate({ discount_code: 'kofi-10' })).a;
    await newOrder({ code: 'KOFI-10' }); await newOrder({ code: 'OTHER' }); await newOrder();
    const d = await detail(a.id);
    expect(d.orders).toHaveLength(1); expect(d.orders[0].via).toBe('code');
  });

  it('never counts an affiliate’s own purchases', async () => {
    const a = (await newAffiliate({ code: 'AAA111', email: 'Kofi@Partner.test' })).a;
    const cart = await newCart(); await attach(cart, 'AAA111');
    await newOrder({ cart, email: 'kofi@partner.test' });
    expect((await detail(a.id)).orders).toHaveLength(0);
  });
});

describe('affiliates: commission rules', () => {
  async function one(order: Parameters<typeof newOrder>[0], rate = 10) {
    const a = (await newAffiliate({ code: `C${++seq}X`, rate_percent: rate, email: `p${seq}@partner.test` })).a;
    const cart = await newCart(); await attach(cart, a.code);
    await newOrder({ cart, ...order });
    return detail(a.id);
  }

  it('is a percentage of the goods (not shipping), once money is paid and the hold has passed', async () => {
    const d = await one({ subtotal: 10000, shipping: 2000 });
    expect(d.orders[0]).toMatchObject({ state: 'available', commission_cents: 1000, base_cents: 10000 });
    expect(xof(d)).toMatchObject({ available_cents: 1000, balance_cents: 1000 });
  });

  it('is calculated after the discount the customer got', async () => {
    const d = await one({ subtotal: 10000, discount: 2000 });
    expect(d.orders[0].commission_cents).toBe(800);
  });

  it('counts nothing for an unpaid order', async () => {
    const d = await one({ paid: 0 });
    expect(d.orders[0]).toMatchObject({ state: 'awaiting_payment', commission_cents: 0 });
    expect(xof(d).available_cents).toBe(0);
  });

  it('counts only the paid share of a part-paid order (deposit)', async () => {
    const d = await one({ subtotal: 10000, paid: 4000 });
    expect(d.orders[0].commission_cents).toBe(400);
  });

  it('keeps a fresh payment on hold until the hold period has passed', async () => {
    const d = await one({ paidDaysAgo: 2 });
    expect(d.orders[0].state).toBe('pending');
    expect(xof(d)).toMatchObject({ pending_cents: 1000, available_cents: 0 });
    expect((await call('/v1/m/affiliates/settings', { method: 'PUT', json: { hold_days: 0 } })).status).toBe(200);
    expect((await detail(d.id)).orders[0].state).toBe('available');
    expect((await call('/v1/m/affiliates/settings', { method: 'PUT', json: { hold_days: 400 } })).status).toBe(400);
    expect((await j(await call('/v1/m/affiliates/settings'))).hold_days).toBe(0);
  });

  it('cancels the commission of a refunded or canceled order', async () => {
    for (const status of ['refunded', 'canceled']) {
      const d = await one({ status });
      expect(d.orders[0]).toMatchObject({ state: 'canceled', commission_cents: 0 });
    }
    const full = await one({ refunded: 10000 });                       // refund recorded, status not changed
    expect(full.orders[0]).toMatchObject({ state: 'canceled', commission_cents: 0 });
  });

  it('reduces the commission in proportion to a partial refund', async () => {
    const d = await one({ subtotal: 10000, refunded: 2500 });
    expect(d.orders[0]).toMatchObject({ state: 'available', commission_cents: 750 });
  });

  it('freezes the rate an order was placed under', async () => {
    const a = (await newAffiliate({ code: 'AAA111', rate_percent: 10 })).a;
    const c1 = await newCart(); await attach(c1, 'AAA111'); await newOrder({ cart: c1 });
    await detail(a.id);                                                // orders are attributed when first seen
    await call(`/v1/m/affiliates/${a.id}`, { method: 'PATCH', json: { rate_percent: 20 } });
    const c2 = await newCart(); await attach(c2, 'AAA111'); await newOrder({ cart: c2 });
    const d = await detail(a.id);
    expect(d.orders.map((o: any) => o.commission_cents).sort()).toEqual([1000, 2000]);
  });

  it('keeps currencies apart', async () => {
    const a = (await newAffiliate({ code: 'AAA111' })).a;
    for (const currency of ['XOF', 'EUR']) { const c = await newCart(); await attach(c, 'AAA111'); await newOrder({ cart: c, currency, subtotal: 5000 }); }
    const d = await detail(a.id);
    expect(d.totals.map((t: any) => t.currency)).toEqual(['EUR', 'XOF']);
    expect(d.totals.every((t: any) => t.available_cents === 500)).toBe(true);
  });
});

describe('affiliates: payouts', () => {
  async function owed() {
    const a = (await newAffiliate({ code: 'AAA111' })).a;
    const cart = await newCart(); await attach(cart, 'AAA111');
    const order = await newOrder({ cart });
    return { a, order };
  }
  const pay = (id: string, extra: Record<string, unknown> = {}) => call(`/v1/m/affiliates/${id}/payouts`, { json: { amount_cents: 600, currency: 'XOF', method: 'mobile_money', reference: 'MTN-123', ...extra } });

  it('records a payout and lowers what is owed; cannot pay more than is owed or in another currency', async () => {
    const { a } = await owed();
    expect((await pay(a.id)).status).toBe(201);
    expect(xof(await detail(a.id))).toMatchObject({ paid_out_cents: 600, balance_cents: 400 });
    expect((await pay(a.id, { amount_cents: 401 })).status).toBe(409);
    expect((await pay(a.id, { currency: 'EUR', amount_cents: 1 })).status).toBe(409);
    expect((await pay(a.id, { amount_cents: 0 })).status).toBe(400);
    expect((await pay(a.id, { method: 'crypto' })).status).toBe(400);
    expect((await pay(a.id, { amount_cents: 400 })).status).toBe(201);
    expect(xof(await detail(a.id)).balance_cents).toBe(0);
  });

  it('shows a negative balance when an order is refunded after the payout', async () => {
    const { a, order } = await owed();
    await pay(a.id, { amount_cents: 1000 });
    await db().run(`UPDATE orders SET status = 'refunded' WHERE id = ?`, [order]);
    expect(xof(await detail(a.id))).toMatchObject({ available_cents: 0, paid_out_cents: 1000, balance_cents: -1000 });
  });

  it('removes a payout recorded by mistake', async () => {
    const { a } = await owed();
    const id = (await j(await pay(a.id))).id;
    expect((await call(`/v1/m/affiliates/${a.id}/payouts/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(xof(await detail(a.id)).balance_cents).toBe(1000);
    expect((await call(`/v1/m/affiliates/${a.id}/payouts/${id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('writes payouts to the audit log', async () => {
    const { a } = await owed(); await pay(a.id);
    expect(await rows(`SELECT 1 FROM audit_log WHERE action = 'affiliate.payout'`)).toHaveLength(1);
  });

  it('deletes only an affiliate with no history', async () => {
    const { a } = await owed();
    expect((await call(`/v1/m/affiliates/${a.id}`, { method: 'DELETE' })).status).toBe(409);
    const fresh = (await newAffiliate({ code: 'ZZZ999', name: 'New', email: 'n@p.test' })).a;
    expect((await call(`/v1/m/affiliates/${fresh.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('lists every affiliate with what each is owed', async () => {
    await owed();
    const list = await j(await call('/v1/m/affiliates'));
    expect(list.hold_days).toBe(14);
    expect(list.items[0].totals[0]).toMatchObject({ currency: 'XOF', balance_cents: 1000 });
  });
});

describe('affiliates: the affiliate’s own page', () => {
  it('shows the link, code, earnings and payouts, without customer details', async () => {
    const a = (await newAffiliate({ code: 'AAA111', name: 'Kofi <script>alert(1)</script>' })).a;
    const cart = await newCart(); await attach(cart, 'AAA111');
    await newOrder({ cart, email: 'secret-buyer@shop.test' });
    await call(`/v1/m/affiliates/${a.id}/payouts`, { json: { amount_cents: 300, currency: 'XOF', method: 'cash' } });
    const r = await call(new URL(a.portal_url).pathname, { key: null });
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain('AAA111'); expect(html).toContain('?ref=AAA111');
    expect(html).not.toContain('<script>alert(1)'); expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('secret-buyer');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-robots-tag')).toBe('noindex');
    expect(await (await call(new URL(a.portal_url).pathname + '?lang=en', { key: null })).text()).toContain('Affiliate page');
  });

  it('answers 404 to wrong or malformed tokens', async () => {
    expect((await call('/m/affiliates/a/short', { key: null })).status).toBe(404);
    expect((await call('/m/affiliates/a/' + 'x'.repeat(32), { key: null })).status).toBe(404);
  });
});
