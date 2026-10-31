// =============================================================================
// src/__tests__/account.test.ts
//
// Storefront customer accounts: link + code sign-in, sessions (cookie and bearer),
// order history, addresses, downloads, and the wall between customers and the admin.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { uuid } from '../types';
import { mockFetch, MOCK_RESPONSES, seedEmailConfig, seedProduct } from './setup';
import { validateDownloadToken } from '../lib/downloads';

const STORE = 'https://store.test.com';
const ADMIN = 'https://admin.test.com';
const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);

let ipCounter = 0;
const nextIp = () => `100.64.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

type CallOpts = { body?: unknown; token?: string; origin?: string; cookie?: string; ip?: string; headers?: Record<string, string> };
async function call(path: string, method: string, o: CallOpts = {}) {
  const res = await SELF.fetch(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': o.ip ?? nextIp(),
      ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
      ...(o.origin ? { Origin: o.origin } : {}),
      ...(o.cookie ? { Cookie: o.cookie } : {}),
      ...o.headers,
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, json, status: res.status };
}

// ── emails are sent in the background; capture them ─────────────────────────
let restore: () => void;
let sent: Array<{ to: string[]; subject: string; html: string; text: string }>;
const waitForEmails = async (n: number) => {
  for (let i = 0; i < 100 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
  expect(sent.length).toBe(n);
};
const lastEmail = () => {
  const m = sent[sent.length - 1];
  return {
    code: m.text.match(/\b(\d{6})\b/)![1],
    token: decodeURIComponent(m.text.match(/#confirm=(ct_[A-Za-z0-9_%-]+)/)![1]),
    m,
  };
};

beforeEach(async () => {
  const d = db();
  for (const t of ['customer_sessions', 'customer_login_tokens', 'auth_throttle', 'download_tokens', 'order_items', 'order_payments', 'orders', 'customer_addresses', 'customers']) {
    await d.run(`DELETE FROM ${t}`);
  }
  await d.run(`DELETE FROM config WHERE key = 'email'`);
  sent = [];
  await seedEmailConfig(d);
  restore = mockFetch((url, init) => {
    if (url.includes('api.resend.com')) {
      sent.push(JSON.parse(String(init?.body)));
      return MOCK_RESPONSES.resendSend();
    }
    return new Response('{}', { status: 200 });
  });
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 150));
  restore();
});

/** Request a link, redeem the code, and return a bearer session token. */
async function signIn(email: string, locale: 'fr' | 'en' = 'en') {
  const before = sent.length;
  const r = await call('/v1/account/login-link', 'POST', { body: { email, locale } });
  expect(r.status).toBe(200);
  await waitForEmails(before + 1);
  const { code } = lastEmail();
  const v = await call('/v1/account/verify', 'POST', { body: { email, code, mode: 'bearer' } });
  expect(v.status).toBe(200);
  return { token: v.json.session_token as string, customer: v.json.customer };
}

async function seedOrder(opts: { email: string; customerId?: string | null; status?: string; number?: string; items?: Array<{ sku: string; title: string; qty: number; price: number }>; total?: number; paid?: number; payToken?: string }) {
  const id = uuid();
  const number = opts.number ?? `N-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await db().run(
    `INSERT INTO orders (id, customer_id, number, status, customer_email, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, amount_paid_cents, pay_token, locale)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 'XOF', ?, ?, 'en')`,
    [id, opts.customerId ?? null, number, opts.status ?? 'paid', opts.email, opts.total ?? 5000, opts.total ?? 5000, opts.paid ?? (opts.total ?? 5000), opts.payToken ?? null]
  );
  for (const i of opts.items ?? [{ sku: 'X-1', title: 'Item', qty: 1, price: 5000 }]) {
    await db().run(`INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`, [uuid(), id, i.sku, i.title, i.qty, i.price]);
  }
  return { id, number };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('sign-in by link and code', () => {
  it('emails a link to the storefront account page and a code; the answer never depends on the address', async () => {
    const a = await call('/v1/account/login-link', 'POST', { body: { email: 'new@mail.test', locale: 'en' } });
    const b = await call('/v1/account/login-link', 'POST', { body: { email: 'other@mail.test', locale: 'en' } });
    expect(a.status).toBe(200);
    expect(b.json).toEqual(a.json);
    await waitForEmails(2);
    const m = sent[0];
    expect(m.to).toEqual(['new@mail.test']);
    expect(m.subject).toMatch(/sign-in link/i);
    expect(m.text).toMatch(/https:\/\/store\.test\.com\/en\/account\/#confirm=ct_/);
  });

  it('uses the French page and wording by default', async () => {
    await call('/v1/account/login-link', 'POST', { body: { email: 'fr@mail.test' } });
    await waitForEmails(1);
    expect(sent[0].subject).toMatch(/lien de connexion/i);
    expect(sent[0].text).toContain('https://store.test.com/fr/compte/#confirm=ct_');
  });

  it('the code signs in, creates the account and marks the email verified', async () => {
    const { token, customer } = await signIn('Ana@Mail.test');
    expect(token).toMatch(/^cus_/);
    expect(customer.email).toBe('ana@mail.test');
    expect(customer.email_verified).toBe(true);
    const me = await call('/v1/account/me', 'GET', { token });
    expect(me.status).toBe(200);
    expect(me.json.customer.email).toBe('ana@mail.test');
  });

  it('the link signs in too, and works only once', async () => {
    await call('/v1/account/login-link', 'POST', { body: { email: 'once@mail.test' } });
    await waitForEmails(1);
    const { token } = lastEmail();
    const first = await call('/v1/account/verify', 'POST', { body: { token } });
    expect(first.status).toBe(200);
    expect(first.json.session_token).toMatch(/^cus_/);
    expect((await call('/v1/account/verify', 'POST', { body: { token } })).status).toBe(401);
  });

  it('a wrong code is refused, and the code is locked after 5 attempts', async () => {
    await call('/v1/account/login-link', 'POST', { body: { email: 'brute@mail.test' } });
    await waitForEmails(1);
    const { code } = lastEmail();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      expect((await call('/v1/account/verify', 'POST', { body: { email: 'brute@mail.test', code: wrong } })).status).toBe(401);
    }
    expect((await call('/v1/account/verify', 'POST', { body: { email: 'brute@mail.test', code } })).status).toBe(401);
  });

  it('a newer link replaces the older one', async () => {
    await call('/v1/account/login-link', 'POST', { body: { email: 'twice@mail.test' } });
    await waitForEmails(1);
    const old = lastEmail();
    await call('/v1/account/login-link', 'POST', { body: { email: 'twice@mail.test' } });
    await waitForEmails(2);
    expect((await call('/v1/account/verify', 'POST', { body: { token: old.token } })).status).toBe(401);
    expect((await call('/v1/account/verify', 'POST', { body: { token: lastEmail().token } })).status).toBe(200);
  });

  it('only a hash of the link is stored', async () => {
    await call('/v1/account/login-link', 'POST', { body: { email: 'hash@mail.test' } });
    await waitForEmails(1);
    const { token, code } = lastEmail();
    const rows = await db().query<any>(`SELECT * FROM customer_login_tokens`);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(`"${code}"`);
  });

  it('limits how many emails one address can be sent per hour, without saying whether it exists', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await call('/v1/account/login-link', 'POST', { body: { email: 'flood@mail.test' } })).status);
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
  });

  it('limits a single client sending to many addresses', async () => {
    const ip = '203.0.113.200';
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await call('/v1/account/login-link', 'POST', { ip, body: { email: `n${i}@mail.test` } })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  });

  it('rejects bad input', async () => {
    expect((await call('/v1/account/login-link', 'POST', { body: { email: 'not-an-email' } })).status).toBe(400);
    expect((await call('/v1/account/login-link', 'POST', { body: {} })).status).toBe(400);
    expect((await call('/v1/account/verify', 'POST', { body: {} })).status).toBe(400);
    expect((await call('/v1/account/verify', 'POST', { body: { token: 'ses_nope' } })).status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cookie sessions', () => {
  it('sets __Host-cid, HttpOnly, Secure, Lax, and keeps the token out of the body', async () => {
    await call('/v1/account/login-link', 'POST', { body: { email: 'cookie@mail.test' } });
    await waitForEmails(1);
    const { code } = lastEmail();
    const v = await call('/v1/account/verify', 'POST', { origin: STORE, body: { email: 'cookie@mail.test', code, mode: 'cookie' } });
    expect(v.status).toBe(200);
    expect(v.json.session_token).toBeUndefined();
    const set = v.res.headers.get('set-cookie')!;
    expect(set).toMatch(/^__Host-cid=cus_/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Domain=/i);
    const cookie = set.split(';')[0];
    const me = await call('/v1/account/me', 'GET', { origin: STORE, cookie });
    expect(me.status).toBe(200);
    expect(me.json.customer.email).toBe('cookie@mail.test');
    expect(me.json.via).toBe('cookie');
  });

  it('the second storefront origin (STORE_ORIGINS) works too', async () => {
    await call('/v1/account/login-link', 'POST', { body: { email: 'www@mail.test' } });
    await waitForEmails(1);
    const v = await call('/v1/account/verify', 'POST', { origin: 'https://www.store.test.com', body: { email: 'www@mail.test', code: lastEmail().code, mode: 'cookie' } });
    expect(v.status).toBe(200);
  });

  it('refuses cookie mode from other origins, before spending the one-time link', async () => {
    await call('/v1/account/login-link', 'POST', { body: { email: 'evil@mail.test' } });
    await waitForEmails(1);
    const { token } = lastEmail();
    for (const origin of [ADMIN, 'https://evil.example', undefined]) {
      expect((await call('/v1/account/verify', 'POST', { origin, body: { token, mode: 'cookie' } })).status).toBe(400);
    }
    expect((await call('/v1/account/verify', 'POST', { body: { token } })).status).toBe(200);
  });

  it('a write with the cookie from another origin is blocked (CSRF); a read is not', async () => {
    await call('/v1/account/login-link', 'POST', { body: { email: 'csrf@mail.test' } });
    await waitForEmails(1);
    const v = await call('/v1/account/verify', 'POST', { origin: STORE, body: { email: 'csrf@mail.test', code: lastEmail().code, mode: 'cookie' } });
    const cookie = v.res.headers.get('set-cookie')!.split(';')[0];
    for (const origin of ['https://evil.example', ADMIN, undefined]) {
      const w = await call('/v1/account/me', 'PATCH', { origin, cookie, body: { name: 'Hacked' } });
      expect(w.status, String(origin)).toBe(403);
    }
    expect((await call('/v1/account/logout', 'POST', { origin: 'https://evil.example', cookie })).status).toBe(403);
    expect((await call('/v1/account/me', 'GET', { origin: STORE, cookie })).json.customer.name).toBeNull();
    expect((await call('/v1/account/me', 'PATCH', { origin: STORE, cookie, body: { name: 'Ana' } })).status).toBe(200);
  });

  it('logout revokes the session and clears the cookie', async () => {
    await call('/v1/account/login-link', 'POST', { body: { email: 'out@mail.test' } });
    await waitForEmails(1);
    const v = await call('/v1/account/verify', 'POST', { origin: STORE, body: { email: 'out@mail.test', code: lastEmail().code, mode: 'cookie' } });
    const cookie = v.res.headers.get('set-cookie')!.split(';')[0];
    const out = await call('/v1/account/logout', 'POST', { origin: STORE, cookie });
    expect(out.status).toBe(200);
    expect(out.res.headers.get('set-cookie')).toMatch(/__Host-cid=;|Max-Age=0|Expires=/i);
    expect((await call('/v1/account/me', 'GET', { origin: STORE, cookie })).status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('sessions', () => {
  it('logout and logout-all revoke', async () => {
    const a = await signIn('multi@mail.test');
    const b = await signIn('multi@mail.test');
    expect((await call('/v1/account/logout', 'POST', { token: a.token })).status).toBe(200);
    expect((await call('/v1/account/me', 'GET', { token: a.token })).status).toBe(401);
    expect((await call('/v1/account/me', 'GET', { token: b.token })).status).toBe(200);
    const c = await signIn('multi@mail.test');
    expect((await call('/v1/account/logout-all', 'POST', { token: b.token })).status).toBe(200);
    expect((await call('/v1/account/me', 'GET', { token: b.token })).status).toBe(401);
    expect((await call('/v1/account/me', 'GET', { token: c.token })).status).toBe(401);
  });

  it('expires after the absolute lifetime and after being idle', async () => {
    const { token } = await signIn('exp@mail.test');
    await db().run(`UPDATE customer_sessions SET expires_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
    expect((await call('/v1/account/me', 'GET', { token })).status).toBe(401);
    const s = await signIn('idle@mail.test');
    await db().run(`UPDATE customer_sessions SET last_seen_at = ? WHERE token_hash IS NOT NULL AND customer_id = (SELECT id FROM customers WHERE email = 'idle@mail.test')`, [new Date(Date.now() - 15 * 86_400_000).toISOString()]);
    expect((await call('/v1/account/me', 'GET', { token: s.token })).status).toBe(401);
  });

  it('needs a session for everything private', async () => {
    for (const [m, p] of [['GET', '/v1/account/me'], ['GET', '/v1/account/orders'], ['GET', '/v1/account/orders/X'], ['GET', '/v1/account/addresses'], ['POST', '/v1/account/addresses'], ['POST', '/v1/account/logout']] as const) {
      expect((await call(p, m)).status, `${m} ${p}`).toBe(401);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('customers and the admin are separate worlds', () => {
  it('a customer token opens nothing in the admin', async () => {
    const { token } = await signIn('shopper@mail.test');
    for (const [m, p] of [['GET', '/v1/orders'], ['GET', '/v1/customers'], ['GET', '/v1/auth/me'], ['GET', '/v1/auth/users'], ['GET', '/v1/auth/keys'], ['GET', '/v1/setup/email'], ['GET', '/v1/discounts']] as const) {
      const r = await call(p, m, { token });
      expect([401, 403], `${m} ${p} -> ${r.status}`).toContain(r.status);
    }
  });

  it('a customer cookie is not an admin cookie, and an admin session is not a customer session', async () => {
    await call('/v1/account/login-link', 'POST', { body: { email: 'swap@mail.test' } });
    await waitForEmails(1);
    const v = await call('/v1/account/verify', 'POST', { origin: STORE, body: { email: 'swap@mail.test', code: lastEmail().code, mode: 'cookie' } });
    const value = v.res.headers.get('set-cookie')!.split(';')[0].split('=')[1];
    // the customer's value pasted into the admin cookie name
    expect((await call('/v1/auth/me', 'GET', { origin: ADMIN, cookie: `__Host-sid=${value}` })).status).toBe(401);
    // the admin bootstrap session as a bearer token on the account API
    const boot = await call('/v1/auth/bootstrap', 'POST', { body: { email: 'owner@shop.test' }, headers: { 'X-Setup-Token': 'test-setup-token' } });
    const adm = await call('/v1/auth/verify', 'POST', { body: { token: boot.json.token, mode: 'bearer' } });
    expect(adm.json.session_token).toMatch(/^ses_/);
    expect((await call('/v1/account/me', 'GET', { token: adm.json.session_token })).status).toBe(401);
  });

  it('being a customer never grants a role, even with the same email as a staff member', async () => {
    const boot = await call('/v1/auth/bootstrap', 'POST', { body: { email: 'same@mail.test' }, headers: { 'X-Setup-Token': 'test-setup-token' } });
    expect(boot.status).toBe(200);
    const { token } = await signIn('same@mail.test');
    expect((await call('/v1/auth/me', 'GET', { token })).status).toBe(401);
    expect((await call('/v1/orders', 'GET', { token })).status).toBeGreaterThanOrEqual(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('profile', () => {
  it('updates name, phone, language and marketing consent', async () => {
    const { token } = await signIn('prof@mail.test');
    const r = await call('/v1/account/me', 'PATCH', { token, body: { name: 'Ana Dossou', phone: '+229 01 61 00 00 00', locale: 'en', accepts_marketing: true } });
    expect(r.status).toBe(200);
    expect(r.json.customer).toMatchObject({ name: 'Ana Dossou', phone: '+2290161000000', locale: 'en', accepts_marketing: true });
    const cleared = await call('/v1/account/me', 'PATCH', { token, body: { phone: null, name: null } });
    expect(cleared.json.customer).toMatchObject({ name: null, phone: null });
  });

  it('refuses an invalid phone number and does not change the email', async () => {
    const { token } = await signIn('prof2@mail.test');
    expect((await call('/v1/account/me', 'PATCH', { token, body: { phone: '12' } })).status).toBe(400);
    const r = await call('/v1/account/me', 'PATCH', { token, body: { email: 'other@mail.test', name: 'X' } });
    expect(r.json.customer.email).toBe('prof2@mail.test');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('orders', () => {
  it('past guest orders show up once the email is verified, whatever its letter case', async () => {
    const cid = uuid();
    await db().run(`INSERT INTO customers (id, email, order_count, total_spent_cents) VALUES (?, 'Guest@Mail.Test', 2, 0)`, [cid]);
    await seedOrder({ email: 'Guest@Mail.Test', customerId: cid, number: 'G-1' });
    await seedOrder({ email: 'guest@mail.test', customerId: null, number: 'G-2' });
    const { token, customer } = await signIn('guest@mail.test');
    expect(customer.id).toBe(cid);
    const list = await call('/v1/account/orders', 'GET', { token });
    expect(list.status).toBe(200);
    expect(list.json.items.map((o: any) => o.number).sort()).toEqual(['G-1', 'G-2']);
    const [{ n }] = await db().query<{ n: number }>(`SELECT COUNT(*) AS n FROM customers WHERE lower(email) = 'guest@mail.test'`);
    expect(n).toBe(1);
  });

  it('shows only the customer’s own orders, and a stranger’s order looks like it does not exist', async () => {
    await seedOrder({ email: 'mine@mail.test', number: 'MINE-1' });
    await seedOrder({ email: 'theirs@mail.test', number: 'THEIRS-1' });
    const { token } = await signIn('mine@mail.test');
    const list = await call('/v1/account/orders', 'GET', { token });
    expect(list.json.items.map((o: any) => o.number)).toEqual(['MINE-1']);
    expect((await call('/v1/account/orders/MINE-1', 'GET', { token })).status).toBe(200);
    expect((await call('/v1/account/orders/THEIRS-1', 'GET', { token })).status).toBe(404);
    expect((await call('/v1/account/orders/NOPE', 'GET', { token })).status).toBe(404);
  });

  it('does not match on a similar email', async () => {
    await seedOrder({ email: 'ana@mail.test.evil.com', number: 'E-1' });
    await seedOrder({ email: 'xana@mail.test', number: 'E-2' });
    const { token } = await signIn('ana@mail.test');
    expect((await call('/v1/account/orders', 'GET', { token })).json.items).toEqual([]);
  });

  it('pages through orders, newest first', async () => {
    for (let i = 1; i <= 5; i++) {
      const o = await seedOrder({ email: 'pager@mail.test', number: `P-${i}` });
      await db().run(`UPDATE orders SET created_at = ? WHERE id = ?`, [`2026-01-0${i}T10:00:00.000Z`, o.id]);
    }
    const { token } = await signIn('pager@mail.test');
    const p1 = await call('/v1/account/orders?limit=2', 'GET', { token });
    expect(p1.json.items.map((o: any) => o.number)).toEqual(['P-5', 'P-4']);
    expect(p1.json.pagination.has_more).toBe(true);
    const p2 = await call(`/v1/account/orders?limit=2&cursor=${encodeURIComponent(p1.json.pagination.next_cursor)}`, 'GET', { token });
    expect(p2.json.items.map((o: any) => o.number)).toEqual(['P-3', 'P-2']);
    const p3 = await call(`/v1/account/orders?limit=2&cursor=${encodeURIComponent(p2.json.pagination.next_cursor)}`, 'GET', { token });
    expect(p3.json.items.map((o: any) => o.number)).toEqual(['P-1']);
    expect(p3.json.pagination.has_more).toBe(false);
  });

  it('the detail has items, totals, balance and a pay link, and leaks no internal fields', async () => {
    await db().run(`UPDATE orders SET id = id WHERE 0`);
    const o = await seedOrder({ email: 'detail@mail.test', number: 'D-1', status: 'pending', total: 10000, paid: 4000, payToken: 'tok123', items: [{ sku: 'A', title: 'Savon', qty: 2, price: 5000 }] });
    await db().run(`UPDATE orders SET needs_review = 1, review_reason = 'internal note', stripe_payment_intent_id = 'pi_secret', service_note = 'private' WHERE id = ?`, [o.id]);
    const { token } = await signIn('detail@mail.test');
    const r = await call('/v1/account/orders/D-1', 'GET', { token });
    expect(r.status).toBe(200);
    const ord = r.json.order;
    expect(ord).toMatchObject({ number: 'D-1', status: 'pending', total_cents: 10000, amount_paid_cents: 4000, balance_cents: 6000 });
    expect(ord.items[0]).toMatchObject({ title: 'Savon', qty: 2 });
    expect(ord.pay_url).toBe('https://store.test.com/en/payment/?token=tok123');
    const raw = JSON.stringify(r.json);
    for (const secret of ['internal note', 'pi_secret', 'private', 'needs_review', 'stripe']) expect(raw).not.toContain(secret);
  });

  it('shows no pay link when nothing is due or the order is canceled', async () => {
    await seedOrder({ email: 'paid@mail.test', number: 'PD-1', total: 3000, paid: 3000, payToken: 't1' });
    await seedOrder({ email: 'paid@mail.test', number: 'PD-2', status: 'canceled', total: 3000, paid: 0, payToken: 't2' });
    const { token } = await signIn('paid@mail.test');
    expect((await call('/v1/account/orders/PD-1', 'GET', { token })).json.order.pay_url).toBeNull();
    expect((await call('/v1/account/orders/PD-2', 'GET', { token })).json.order.pay_url).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('downloads', () => {
  it('gives a fresh working link for a paid digital item', async () => {
    const p = await seedProduct(db(), { product_type: 'digital' });
    const o = await seedOrder({ email: 'dl@mail.test', number: 'DL-1', items: [{ sku: p.sku, title: 'Guide', qty: 1, price: 2000 }] });
    const { token } = await signIn('dl@mail.test');
    const detail = await call('/v1/account/orders/DL-1', 'GET', { token });
    expect(detail.json.order.items[0]).toMatchObject({ digital: true, can_download: true });
    const r = await call('/v1/account/orders/DL-1/downloads', 'POST', { token, body: { sku: p.sku } });
    expect(r.status).toBe(200);
    expect(r.json.download_url).toMatch(/^https:\/\/store\.test\.com\/en\/downloads\/\?token=[0-9a-f]{64}$/);
    const check = await validateDownloadToken(db(), r.json.token);
    expect(check.ok).toBe(true);
    void o;
  });

  it('refuses unpaid orders, physical items, and other people’s orders', async () => {
    const dig = await seedProduct(db(), { product_type: 'digital' });
    const phys = await seedProduct(db(), { product_type: 'physical' });
    await seedOrder({ email: 'dl2@mail.test', number: 'DL-U', status: 'pending', items: [{ sku: dig.sku, title: 'Guide', qty: 1, price: 1 }] });
    await seedOrder({ email: 'dl2@mail.test', number: 'DL-P', items: [{ sku: phys.sku, title: 'Savon', qty: 1, price: 1 }] });
    await seedOrder({ email: 'other@mail.test', number: 'DL-O', items: [{ sku: dig.sku, title: 'Guide', qty: 1, price: 1 }] });
    const { token } = await signIn('dl2@mail.test');
    expect((await call('/v1/account/orders/DL-U/downloads', 'POST', { token, body: { sku: dig.sku } })).status).toBe(403);
    expect((await call('/v1/account/orders/DL-P/downloads', 'POST', { token, body: { sku: phys.sku } })).status).toBe(404);
    expect((await call('/v1/account/orders/DL-O/downloads', 'POST', { token, body: { sku: dig.sku } })).status).toBe(404);
    expect((await call('/v1/account/orders/DL-U/downloads', 'POST', { token, body: {} })).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('addresses', () => {
  const addr = (o: Record<string, unknown> = {}) => ({ line1: '12 rue des Fleurs', city: 'Cotonou', country: 'BJ', ...o });

  it('adds, lists, updates and deletes; the first one becomes the default', async () => {
    const { token } = await signIn('addr@mail.test');
    const a = await call('/v1/account/addresses', 'POST', { token, body: addr({ label: 'Maison', phone: '+229 01 61 00 00 00' }) });
    expect(a.status).toBe(201);
    expect(a.json.address).toMatchObject({ label: 'Maison', is_default: true, country: 'BJ', phone: '+2290161000000' });
    const b = await call('/v1/account/addresses', 'POST', { token, body: addr({ label: 'Bureau', city: 'Porto-Novo' }) });
    expect(b.json.address.is_default).toBe(false);
    const c = await call('/v1/account/addresses', 'POST', { token, body: addr({ label: 'Paris', country: 'FR', postal_code: '75011', city: 'Paris', is_default: true }) });
    expect(c.json.address.is_default).toBe(true);
    const list = await call('/v1/account/addresses', 'GET', { token });
    expect(list.json.items.filter((x: any) => x.is_default)).toHaveLength(1);
    expect(list.json.items[0].label).toBe('Paris');
    const upd = await call(`/v1/account/addresses/${b.json.address.id}`, 'PATCH', { token, body: { city: 'Abomey', is_default: true } });
    expect(upd.json.address).toMatchObject({ city: 'Abomey', is_default: true, label: 'Bureau' });
    expect((await call('/v1/account/addresses', 'GET', { token })).json.items.filter((x: any) => x.is_default)).toHaveLength(1);
    expect((await call(`/v1/account/addresses/${b.json.address.id}`, 'DELETE', { token })).status).toBe(200);
    const left = await call('/v1/account/addresses', 'GET', { token });
    expect(left.json.items).toHaveLength(2);
    expect(left.json.items.filter((x: any) => x.is_default)).toHaveLength(1);
  });

  it('validates the country and the postal code like checkout', async () => {
    const { token } = await signIn('addr2@mail.test');
    expect((await call('/v1/account/addresses', 'POST', { token, body: addr({ country: 'ZZ' }) })).status).toBe(400);
    expect((await call('/v1/account/addresses', 'POST', { token, body: addr({ country: 'FR', city: 'Paris' }) })).status).toBe(400);
    expect((await call('/v1/account/addresses', 'POST', { token, body: addr({ line1: '' }) })).status).toBe(400);
    expect((await call('/v1/account/addresses', 'POST', { token, body: addr({ phone: '12' }) })).status).toBe(400);
  });

  it('nobody can read, change or delete another customer’s address', async () => {
    const a = await signIn('owner1@mail.test');
    const b = await signIn('owner2@mail.test');
    const mine = await call('/v1/account/addresses', 'POST', { token: a.token, body: addr() });
    const id = mine.json.address.id;
    expect((await call('/v1/account/addresses', 'GET', { token: b.token })).json.items).toEqual([]);
    expect((await call(`/v1/account/addresses/${id}`, 'PATCH', { token: b.token, body: { city: 'X' } })).status).toBe(404);
    expect((await call(`/v1/account/addresses/${id}`, 'DELETE', { token: b.token })).status).toBe(404);
    expect((await call('/v1/account/addresses', 'GET', { token: a.token })).json.items).toHaveLength(1);
  });

  it('caps the number of saved addresses', async () => {
    const { token } = await signIn('many@mail.test');
    for (let i = 0; i < 10; i++) expect((await call('/v1/account/addresses', 'POST', { token, body: addr({ line1: `${i} rue` }) })).status).toBe(201);
    expect((await call('/v1/account/addresses', 'POST', { token, body: addr() })).status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('CORS', () => {
  const preflight = (path: string, origin: string) =>
    SELF.fetch(`http://localhost${path}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });

  it('a storefront origin gets credentials on /v1/account, an admin origin does not', async () => {
    const s = await preflight('/v1/account/me', STORE);
    expect(s.headers.get('access-control-allow-origin')).toBe(STORE);
    expect(s.headers.get('access-control-allow-credentials')).toBe('true');
    const a = await preflight('/v1/account/me', ADMIN);
    expect(a.headers.get('access-control-allow-credentials')).toBeNull();
    expect(a.headers.get('access-control-allow-origin')).toBe('*');
    const e = await preflight('/v1/account/me', 'https://evil.example');
    expect(e.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('and the other way round on /v1/auth', async () => {
    const s = await preflight('/v1/auth/me', STORE);
    expect(s.headers.get('access-control-allow-credentials')).toBeNull();
    expect(s.headers.get('access-control-allow-origin')).toBeNull();
    const a = await preflight('/v1/auth/me', ADMIN);
    expect(a.headers.get('access-control-allow-origin')).toBe(ADMIN);
    expect(a.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
