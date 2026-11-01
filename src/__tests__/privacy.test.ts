// =============================================================================
// src/__tests__/privacy.test.ts
//
// Customer privacy: change the account email, export my data, erase my account.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { uuid } from '../types';
import { mockFetch, MOCK_RESPONSES, seedEmailConfig } from './setup';
import { openCustomer, createCustomerSession } from '../account/service';
import { eraseCustomer, openOrderCount } from '../account/privacy';

const STORE = 'https://store.test.com';
const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);

let ipCounter = 0;
const nextIp = () => `192.0.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
type CallOpts = { body?: unknown; token?: string; origin?: string; cookie?: string; ip?: string };
async function call(path: string, method: string, o: CallOpts = {}) {
  const res = await SELF.fetch(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json', 'CF-Connecting-IP': o.ip ?? nextIp(),
      ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
      ...(o.origin ? { Origin: o.origin } : {}), ...(o.cookie ? { Cookie: o.cookie } : {}),
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
  return { res, json, status: res.status, text };
}

let restore: () => void;
let sent: Array<{ to: string[] | string; subject: string; html: string; text: string }>;
const toList = (m: { to: string[] | string }) => (Array.isArray(m.to) ? m.to : [m.to]);
const waitFor = async (n: number) => {
  for (let i = 0; i < 100 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
  expect(sent.length).toBeGreaterThanOrEqual(n);
};
const lastCode = () => sent[sent.length - 1].text.match(/\b(\d{6})\b/)![1];

const TABLES = ['customer_codes', 'passkey_credentials', 'webauthn_challenges', 'customer_sessions', 'customer_login_tokens', 'auth_throttle',
  'download_tokens', 'order_items', 'order_payments', 'orders', 'customer_addresses', 'carts', 'submissions', 'audit_log', 'oauth_tokens', 'customers'];
beforeEach(async () => {
  const d = db();
  for (const t of TABLES) await d.run(`DELETE FROM ${t}`);
  await d.run(`DELETE FROM config WHERE key = 'email'`);
  sent = [];
  await seedEmailConfig(d);
  restore = mockFetch((url, init) => {
    if (url.includes('api.resend.com')) { sent.push(JSON.parse(String(init?.body))); return MOCK_RESPONSES.resendSend(); }
    return new Response('{}', { status: 200 });
  });
});
afterEach(async () => { await new Promise((r) => setTimeout(r, 150)); restore(); });

async function person(email: string, locale: 'fr' | 'en' = 'en') {
  const c = await openCustomer(db(), email, locale);
  const s = await createCustomerSession(db(), c.id, { via: 'bearer' });
  return { id: c.id, token: s.token };
}
async function seedOrder(o: { email: string; customerId?: string | null; status?: string; number?: string; sku?: string; total?: number }) {
  const id = uuid();
  const number = o.number ?? `P-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await db().run(
    `INSERT INTO orders (id, customer_id, number, status, customer_email, shipping_name, shipping_phone, ship_to, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, amount_paid_cents, locale)
     VALUES (?, ?, ?, ?, ?, 'Ann Martin', '+33612345678', '{"line1":"12 rue X","city":"Paris","country":"FR"}', ?, 0, 0, ?, 'XOF', ?, 'en')`,
    [id, o.customerId ?? null, number, o.status ?? 'delivered', o.email, o.total ?? 5000, o.total ?? 5000, o.total ?? 5000]);
  await db().run(`INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, 'Item', 1, ?)`, [uuid(), id, o.sku ?? 'X-1', o.total ?? 5000]);
  return { id, number };
}
const customerOf = async (id: string) => (await db().query<any>(`SELECT * FROM customers WHERE id = ?`, [id]))[0];

const P = '/v1/account/privacy';
async function requestChange(token: string, new_email: string, ip?: string) {
  return call(`${P}/email/request`, 'POST', { token, origin: STORE, body: { new_email }, ip });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('changing the email', () => {
  it('sends a code to the NEW address; the code moves the account; the old address is told', async () => {
    const ann = await person('ann@old.test');
    const other = await createCustomerSession(db(), ann.id, { via: 'bearer' }); // a second device
    await seedOrder({ email: 'ann@old.test', customerId: null, number: 'OLD-1' });
    await seedOrder({ email: 'ann@new.test', customerId: null, number: 'NEW-1' });

    const r = await requestChange(ann.token, 'Ann@New.test');
    expect(r.status).toBe(200);
    await waitFor(1);
    expect(toList(sent[0])).toEqual(['ann@new.test']);
    const code = lastCode();

    const bad = await call(`${P}/email/confirm`, 'POST', { token: ann.token, origin: STORE, body: { code: '000000' } });
    expect(bad.status).toBe(400);
    expect((await customerOf(ann.id)).email).toBe('ann@old.test');

    const ok = await call(`${P}/email/confirm`, 'POST', { token: ann.token, origin: STORE, body: { code } });
    expect(ok.status).toBe(200);
    expect(ok.json.customer.email).toBe('ann@new.test');
    expect((await customerOf(ann.id)).email_verified_at).toBeTruthy();
    await waitFor(2);
    expect(toList(sent[1])).toEqual(['ann@old.test']);
    expect(sent[1].text).toContain('ann@new.test');

    // this device stays signed in; the other one is signed out
    expect((await call('/v1/account/me', 'GET', { token: ann.token })).json.customer.email).toBe('ann@new.test');
    expect((await call('/v1/account/me', 'GET', { token: other.token })).status).toBe(401);
    // orders made as a guest with either address are tied to the account now
    const linked = await db().query<any>(`SELECT number FROM orders WHERE customer_id = ? ORDER BY number`, [ann.id]);
    expect(linked.map((o: any) => o.number)).toEqual(['NEW-1', 'OLD-1']);
    const list = await call('/v1/account/orders', 'GET', { token: ann.token });
    expect(list.json.items.map((o: any) => o.number).sort()).toEqual(['NEW-1', 'OLD-1']);
    // the code is single use
    expect((await call(`${P}/email/confirm`, 'POST', { token: ann.token, origin: STORE, body: { code } })).status).toBe(400);
    // the old address is just an address now: signing in with it makes a different, empty account
    const again = await openCustomer(db(), 'ann@old.test', 'en');
    expect(again.id).not.toBe(ann.id);
  });

  it('does not reveal that an address already has an account (same answer, no code is sent)', async () => {
    const ann = await person('ann@old.test');
    await person('bob@taken.test');
    const ok = await requestChange(ann.token, 'new@free.test');
    const taken = await requestChange(ann.token, 'BOB@taken.test');
    expect(taken.status).toBe(ok.status);
    expect(taken.json).toEqual(ok.json);
    await waitFor(2);
    const notice = sent.find((m) => toList(m).includes('bob@taken.test'))!;
    expect(notice.text).not.toMatch(/\b\d{6}\b/);
    // and nothing can be confirmed for it
    const guess = await call(`${P}/email/confirm`, 'POST', { token: ann.token, origin: STORE, body: { code: '123456' } });
    expect(guess.status).toBe(400);
    expect((await customerOf(ann.id)).email).toBe('ann@old.test');
  });

  it('caps the notices to a taken address (no mail bombing through this form)', async () => {
    const ann = await person('ann@old.test');
    await person('bob@taken.test');
    for (let i = 0; i < 5; i++) await requestChange(ann.token, 'bob@taken.test', `10.1.1.${i + 1}`);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.filter((m) => toList(m).includes('bob@taken.test')).length).toBe(3);
  });

  it('refuses the same or an invalid address', async () => {
    const ann = await person('ann@old.test');
    expect((await requestChange(ann.token, 'ANN@old.test')).status).toBe(400);
    expect((await requestChange(ann.token, 'not-an-email')).status).toBe(400);
    expect((await call(`${P}/email/request`, 'POST', { token: ann.token, origin: STORE, body: {} })).status).toBe(400);
  });

  it('limits wrong codes to 5 tries, and a newer request cancels the older code', async () => {
    const ann = await person('ann@old.test');
    await requestChange(ann.token, 'a@new.test'); await waitFor(1);
    const first = lastCode();
    await requestChange(ann.token, 'b@new.test'); await waitFor(2);
    const second = lastCode();
    expect((await call(`${P}/email/confirm`, 'POST', { token: ann.token, origin: STORE, body: { code: first } })).status).toBe(400);
    for (let i = 0; i < 4; i++) await call(`${P}/email/confirm`, 'POST', { token: ann.token, origin: STORE, body: { code: '111111' } });
    // 5 tries are used up (1 above + 4): even the right code is refused now
    const locked = await call(`${P}/email/confirm`, 'POST', { token: ann.token, origin: STORE, body: { code: second } });
    expect(locked.status).toBe(400);
    expect((await customerOf(ann.id)).email).toBe('ann@old.test');
  });

  it('a code only works for the person it was issued to, and expires', async () => {
    const ann = await person('ann@old.test');
    const bob = await person('bob@old.test');
    await requestChange(ann.token, 'a@new.test'); await waitFor(1);
    const code = lastCode();
    expect((await call(`${P}/email/confirm`, 'POST', { token: bob.token, origin: STORE, body: { code } })).status).toBe(400);
    await db().run(`UPDATE customer_codes SET expires_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
    expect((await call(`${P}/email/confirm`, 'POST', { token: ann.token, origin: STORE, body: { code } })).status).toBe(400);
  });

  it('fails with a conflict when the address was taken in the meantime', async () => {
    const ann = await person('ann@old.test');
    await requestChange(ann.token, 'race@new.test'); await waitFor(1);
    const code = lastCode();
    await person('race@new.test');
    const r = await call(`${P}/email/confirm`, 'POST', { token: ann.token, origin: STORE, body: { code } });
    expect(r.status).toBe(409);
    expect((await customerOf(ann.id)).email).toBe('ann@old.test');
  });

  it('needs a signed-in customer, and a cookie from a foreign site is refused', async () => {
    expect((await call(`${P}/email/request`, 'POST', { origin: STORE, body: { new_email: 'a@b.test' } })).status).toBe(401);
    expect((await call(`${P}/email/confirm`, 'POST', { origin: STORE, body: { code: '123456' } })).status).toBe(401);
    const ann = await person('ann@old.test');
    const cookie = `__Host-cid=${ann.token}`;
    expect((await call(`${P}/email/request`, 'POST', { cookie, origin: 'https://evil.example', body: { new_email: 'x@y.test' } })).status).toBe(403);
    expect((await call(`${P}/delete/request`, 'POST', { cookie, origin: 'https://evil.example' })).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('export', () => {
  it('returns my data (account, addresses, orders including guest ones, messages) and nobody else\'s, without secrets', async () => {
    const ann = await person('ann@shop.test');
    await person('bob@shop.test');
    await db().run(`INSERT INTO customer_addresses (id, customer_id, line1, city, postal_code, country, name) VALUES (?, ?, '12 rue X', 'Paris', '75011', 'FR', 'Ann')`, [uuid(), ann.id]);
    await seedOrder({ email: 'ann@shop.test', number: 'ANN-1' });
    await seedOrder({ email: 'bob@shop.test', number: 'BOB-1' });
    await db().run(`INSERT INTO submissions (id, form, name, email, message, created_at) VALUES (?, 'contact', 'Ann', 'ann@shop.test', 'Hello there', ?)`, [uuid(), new Date().toISOString()]);
    await db().run(`INSERT INTO submissions (id, form, name, email, message, created_at) VALUES (?, 'contact', 'Bob', 'bob@shop.test', 'Secret bob', ?)`, [uuid(), new Date().toISOString()]);
    await db().run(`INSERT INTO passkey_credentials (id, realm, subject_id, public_key, counter, name, created_at) VALUES ('cred1', 'customer', ?, 'SECRETKEY', 0, 'Phone', ?)`, [ann.id, new Date().toISOString()]);

    const r = await call(`${P}/export`, 'GET', { token: ann.token });
    expect(r.status).toBe(200);
    expect(r.res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(r.json.account.email).toBe('ann@shop.test');
    expect(r.json.addresses).toHaveLength(1);
    expect(r.json.orders.map((o: any) => o.number)).toEqual(['ANN-1']);
    expect(r.json.orders[0].items).toHaveLength(1);
    expect(r.json.orders[0].shipping.address.city).toBe('Paris');
    expect(r.json.contact_messages).toHaveLength(1);
    expect(r.json.passkeys).toEqual([expect.objectContaining({ name: 'Phone' })]);
    expect(r.text).not.toMatch(/bob@shop|Secret bob|BOB-1/);
    expect(r.text).not.toMatch(/SECRETKEY|token_hash|password_hash|code_hash|public_key/);
  });

  it('needs sign-in and is limited to 5 a day', async () => {
    expect((await call(`${P}/export`, 'GET', {})).status).toBe(401);
    const ann = await person('ann@shop.test');
    for (let i = 0; i < 5; i++) expect((await call(`${P}/export`, 'GET', { token: ann.token })).status).toBe(200);
    expect((await call(`${P}/export`, 'GET', { token: ann.token })).status).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('erasing the account', () => {
  async function seedLife(email: string) {
    const me = await person(email);
    await db().run(`INSERT INTO customer_addresses (id, customer_id, line1, city, postal_code, country) VALUES (?, ?, '12 rue X', 'Paris', '75011', 'FR')`, [uuid(), me.id]);
    await db().run(`INSERT INTO passkey_credentials (id, realm, subject_id, public_key, counter, created_at) VALUES (?, 'customer', ?, 'k', 0, ?)`, [uuid(), me.id, new Date().toISOString()]);
    await db().run(`UPDATE customers SET name = 'Ann Martin', phone = '+33612345678', accepts_marketing = 1 WHERE id = ?`, [me.id]);
    const order = await seedOrder({ email, customerId: me.id, number: `${email.slice(0, 3).toUpperCase()}-1`, status: 'delivered' });
    await db().run(`INSERT INTO download_tokens (id, order_id, sku, token_hash, expires_at, created_at) VALUES (?, ?, 'X-1', ?, ?, ?)`, [uuid(), order.id, uuid(), new Date(Date.now() + 1e9).toISOString(), new Date().toISOString()]);
    await db().run(`INSERT INTO submissions (id, form, name, email, message, created_at) VALUES (?, 'contact', 'Ann', ?, 'hi', ?)`, [uuid(), email, new Date().toISOString()]);
    await db().run(`INSERT INTO carts (id, status, customer_email, currency, shipping_name, contact_phone, ship_to, expires_at) VALUES (?, 'open', ?, 'XOF', 'Ann', '+336', '{"a":1}', ?)`, [uuid(), email, new Date(Date.now() + 1e9).toISOString()]);
    return { me, order };
  }
  async function erase(token: string) {
    const rq = await call(`${P}/delete/request`, 'POST', { token, origin: STORE });
    if (rq.status !== 200) return { rq };
    await waitFor(sent.length || 1);
    const code = lastCode();
    return { rq, code, conf: await call(`${P}/delete/confirm`, 'POST', { token, origin: STORE, body: { code } }) };
  }

  it('needs the code from my mailbox: a stolen session alone cannot erase the account', async () => {
    const { me } = await seedLife('ann@shop.test');
    expect((await call(`${P}/delete/confirm`, 'POST', { token: me.token, origin: STORE, body: { code: '123456' } })).status).toBe(400);
    expect((await call(`${P}/delete/confirm`, 'POST', { token: me.token, origin: STORE, body: {} })).status).toBe(400);
    await call(`${P}/delete/request`, 'POST', { token: me.token, origin: STORE });
    await waitFor(1);
    expect(toList(sent[0])).toEqual(['ann@shop.test']);
    expect((await call(`${P}/delete/confirm`, 'POST', { token: me.token, origin: STORE, body: { code: '000000' } })).status).toBe(400);
    expect((await customerOf(me.id)).email).toBe('ann@shop.test');
  });

  it('erases personal data, keeps the order record, and ends every session', async () => {
    const { me, order } = await seedLife('ann@shop.test');
    const bob = await seedLife('bob@shop.test');
    const second = await createCustomerSession(db(), me.id, { via: 'bearer' });
    const r = await erase(me.token);
    expect(r.conf!.status).toBe(200);

    const c = await customerOf(me.id);
    expect(c.email).toMatch(/^erased\+.*@erased\.invalid$/);
    expect([c.name, c.phone, c.password_hash, c.email_verified_at]).toEqual([null, null, null, null]);
    expect(c.accepts_marketing).toBe(0);
    expect(JSON.parse(c.metadata).erased_at).toBeTruthy();
    const count = async (sql: string, ...a: unknown[]) => (await db().query<{ n: number }>(sql, a))[0].n;
    expect(await count(`SELECT COUNT(*) n FROM customer_addresses WHERE customer_id = ?`, me.id)).toBe(0);
    expect(await count(`SELECT COUNT(*) n FROM customer_sessions WHERE customer_id = ?`, me.id)).toBe(0);
    expect(await count(`SELECT COUNT(*) n FROM passkey_credentials WHERE subject_id = ?`, me.id)).toBe(0);
    expect(await count(`SELECT COUNT(*) n FROM customer_codes WHERE customer_id = ?`, me.id)).toBe(0);
    expect(await count(`SELECT COUNT(*) n FROM download_tokens WHERE order_id = ?`, order.id)).toBe(0);
    expect(await count(`SELECT COUNT(*) n FROM submissions WHERE lower(email) = 'ann@shop.test'`)).toBe(0);
    const [cart] = await db().query<any>(`SELECT * FROM carts WHERE customer_email LIKE 'erased+%'`);
    expect([cart.shipping_name, cart.contact_phone, cart.ship_to]).toEqual([null, null, null]);

    // default mode keeps the order and its contact details for accounting
    const [o] = await db().query<any>(`SELECT * FROM orders WHERE id = ?`, [order.id]);
    expect(o.total_cents).toBe(5000);
    expect(o.shipping_name).toBe('Ann Martin');
    expect(o.customer_id).toBe(me.id);

    // sessions are gone, on every device
    expect((await call('/v1/account/me', 'GET', { token: me.token })).status).toBe(401);
    expect((await call('/v1/account/me', 'GET', { token: second.token })).status).toBe(401);
    // the final notice went to the old address; the audit trail has no personal data
    await waitFor(2);
    expect(toList(sent[sent.length - 1])).toEqual(['ann@shop.test']);
    const audits = await db().query<any>(`SELECT * FROM audit_log WHERE action = 'account.erased'`);
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toMatch(/ann@shop/);
    // someone else is untouched
    expect((await customerOf(bob.me.id)).email).toBe('bob@shop.test');
    expect(await count(`SELECT COUNT(*) n FROM customer_addresses WHERE customer_id = ?`, bob.me.id)).toBe(1);
    expect((await call('/v1/account/me', 'GET', { token: bob.me.token })).status).toBe(200);
    // the same address can sign up again as a brand-new account
    const fresh = await openCustomer(db(), 'ann@shop.test', 'en');
    expect(fresh.id).not.toBe(me.id);
  });

  it('blanks the buyer details kept on agent-checkout sessions', async () => {
    const { me } = await seedLife('ann@shop.test');
    await db().run(`INSERT INTO ucp_checkout_sessions (id, currency, line_items, totals, created_at, updated_at, buyer) VALUES ('u1', 'XOF', '[]', '{}', '2026-01-01', '2026-01-01', '{"email":"Ann@Shop.test","name":"Ann"}')`);
    await db().run(`INSERT INTO ucp_checkout_sessions (id, currency, line_items, totals, created_at, updated_at, buyer) VALUES ('u2', 'XOF', '[]', '{}', '2026-01-01', '2026-01-01', '{"email":"bob@shop.test"}')`);
    await eraseCustomer(db(), (await openCustomer(db(), 'ann@shop.test', 'en')), 'keep');
    const rows = await db().query<any>(`SELECT id, buyer FROM ucp_checkout_sessions ORDER BY id`);
    expect(rows).toEqual([{ id: 'u1', buyer: null }, { id: 'u2', buyer: '{"email":"bob@shop.test"}' }]);
    expect(me.id).toBeTruthy();
  });

  it("'scrub' mode also blanks who the orders were for", async () => {
    const { me, order } = await seedLife('ann@shop.test');
    const cust = (await openCustomer(db(), 'ann@shop.test', 'en'));
    await eraseCustomer(db(), cust, 'scrub');
    const [o] = await db().query<any>(`SELECT * FROM orders WHERE id = ?`, [order.id]);
    expect(o.customer_email).toMatch(/^erased\+/);
    expect([o.shipping_name, o.shipping_phone, o.ship_to]).toEqual([null, null, null]);
    expect(o.total_cents).toBe(5000);
    expect(me.id).toBe(cust.id);
  });

  it('refuses while orders are still in progress, and does not spend the code', async () => {
    const me = await person('ann@shop.test');
    await seedOrder({ email: 'ann@shop.test', customerId: me.id, status: 'shipped' });
    const r = await call(`${P}/delete/request`, 'POST', { token: me.token, origin: STORE });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('open_orders');
    expect(sent).toHaveLength(0);
    expect((await customerOf(me.id)).email).toBe('ann@shop.test');
  });

  it('an order placed after the code was requested blocks the confirmation', async () => {
    const me = await person('ann@shop.test');
    await call(`${P}/delete/request`, 'POST', { token: me.token, origin: STORE });
    await waitFor(1);
    const code = lastCode();
    await seedOrder({ email: 'ann@shop.test', customerId: me.id, status: 'pending' });
    expect((await call(`${P}/delete/confirm`, 'POST', { token: me.token, origin: STORE, body: { code } })).status).toBe(409);
    expect((await customerOf(me.id)).email).toBe('ann@shop.test');
  });

  it("which orders count as open depends on the mode ('scrub' also waits for paid physical orders)", async () => {
    const me = await person('ann@shop.test');
    const cust = (await openCustomer(db(), 'ann@shop.test', 'en'));
    await seedOrder({ email: 'ann@shop.test', customerId: me.id, status: 'paid', sku: 'PHYS-1' });
    await seedOrder({ email: 'ann@shop.test', customerId: me.id, status: 'delivered' });
    expect(await openOrderCount(db(), cust, 'keep')).toBe(0);
    expect(await openOrderCount(db(), cust, 'scrub')).toBe(1);
  });

  it('limits wrong codes, and needs sign-in', async () => {
    expect((await call(`${P}/delete/request`, 'POST', { origin: STORE })).status).toBe(401);
    const me = await person('ann@shop.test');
    await call(`${P}/delete/request`, 'POST', { token: me.token, origin: STORE });
    await waitFor(1);
    const code = lastCode();
    for (let i = 0; i < 5; i++) await call(`${P}/delete/confirm`, 'POST', { token: me.token, origin: STORE, body: { code: '111111' } });
    expect((await call(`${P}/delete/confirm`, 'POST', { token: me.token, origin: STORE, body: { code } })).status).toBe(400);
    expect((await customerOf(me.id)).email).toBe('ann@shop.test');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what the admin sees of erased customers', () => {
  const SETUP = { 'X-Setup-Token': 'test-setup-token' };
  async function adminToken() {
    const d = db();
    for (const t of ['sessions', 'login_tokens', 'identities', 'users']) await d.run(`DELETE FROM ${t}`);
    await d.run(`DELETE FROM config WHERE key = 'auth'`);
    const r = await SELF.fetch('http://localhost/v1/auth/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Token': SETUP['X-Setup-Token'], 'CF-Connecting-IP': nextIp() }, body: JSON.stringify({ email: 'owner@shop.test', role: 'owner' }) });
    const boot: any = await r.json();
    const v = await call('/v1/auth/verify', 'POST', { body: { token: boot.token, mode: 'bearer' } });
    return v.json.session_token as string;
  }
  async function twoCustomers() {
    const keep = await person('bob@shop.test');
    const gone = await person('ann@shop.test');
    await db().run(`UPDATE customers SET name = 'Ann Martin' WHERE id = ?`, [gone.id]);
    await seedOrder({ email: 'ann@shop.test', customerId: gone.id, number: 'ANN-1', status: 'delivered' });
    await eraseCustomer(db(), (await openCustomer(db(), 'ann@shop.test', 'en')), 'keep');
    return { keep, gone };
  }

  it('hides erased accounts from the normal list, and lists them on request', async () => {
    const admin = await adminToken(); const { keep, gone } = await twoCustomers();
    const def = await call('/v1/customers', 'GET', { token: admin });
    expect(def.json.items.map((c: any) => c.id)).toEqual([keep.id]);
    expect(def.json.items[0].erased).toBe(false);
    const only = await call('/v1/customers?erased=only', 'GET', { token: admin });
    expect(only.json.items.map((c: any) => c.id)).toEqual([gone.id]);
    expect(only.json.items[0]).toMatchObject({ erased: true, name: null, phone: null });
    expect(only.json.items[0].erased_at).toBeTruthy();
    const all = await call('/v1/customers?erased=all', 'GET', { token: admin });
    expect(all.json.items).toHaveLength(2);
  });

  it('an erased account cannot be edited or given addresses, but its retained orders can still be read', async () => {
    const admin = await adminToken(); const { gone } = await twoCustomers();
    const patch = await call(`/v1/customers/${gone.id}`, 'PATCH', { token: admin, body: { name: 'Someone' } });
    expect(patch.status).toBe(409);
    const addr = await call(`/v1/customers/${gone.id}/addresses`, 'POST', { token: admin, body: { line1: 'x', city: 'Paris', country: 'FR', postal_code: '75001' } });
    expect(addr.status).toBe(409);
    const detail = await call(`/v1/customers/${gone.id}`, 'GET', { token: admin });
    expect(detail.json.erased).toBe(true);
    const orders = await call(`/v1/customers/${gone.id}/orders`, 'GET', { token: admin });
    expect(orders.status).toBe(200);
    expect(orders.json.items.map((o: any) => o.number)).toEqual(['ANN-1']);
  });

  it('a normal customer is still editable', async () => {
    const admin = await adminToken(); const { keep } = await twoCustomers();
    expect((await call(`/v1/customers/${keep.id}`, 'PATCH', { token: admin, body: { name: 'Bob' } })).status).toBe(200);
  });
});
