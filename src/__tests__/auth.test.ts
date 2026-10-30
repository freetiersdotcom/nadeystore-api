// =============================================================================
// src/__tests__/auth.test.ts
//
// Sign-in for the admin: passwords, link/code login, sessions, cookies, roles,
// throttling and CORS. Pure modules are tested directly; the rest goes through
// SELF (the real Worker) against the same Durable Object the Worker uses
// ("default"), so what is seeded here is what the middleware sees.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { uuid } from '../types';
import { hashKey, generateApiKey } from '../middleware/auth';
import { mockFetch, MOCK_RESPONSES, seedEmailConfig } from './setup';
import {
  hashPassword, verifyPassword, needsRehash, parseHash, checkPasswordShape, DEFAULT_POLICY,
} from '../auth/password';
import { requiredPermission, roleCanRequest, roleCan, ROLES } from '../auth/permissions';
import { randomCode, timingSafeEqual, sha256Hex } from '../auth/crypto';

const ORIGIN = 'https://admin.test.com';
const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);

let ipCounter = 0;
const nextIp = () => `203.0.113.${(++ipCounter % 250) + 1}`;

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

const SETUP = { 'X-Setup-Token': 'test-setup-token' };

/** Create (or re-open) an account with the setup token and sign it in. Returns a bearer session token. */
async function signIn(email: string, role: 'owner' | 'agency' = 'owner') {
  const boot = await call('/v1/auth/bootstrap', 'POST', { body: { email, role }, headers: SETUP });
  expect(boot.status).toBe(200);
  const v = await call('/v1/auth/verify', 'POST', { body: { token: boot.json.token, mode: 'bearer' } });
  expect(v.status).toBe(200);
  return { token: v.json.session_token as string, user: v.json.user, boot: boot.json };
}

/** Owner creates a user and the invited person signs in (no email provider -> invite_url is returned). */
async function createAndSignIn(ownerToken: string, email: string, role: 'manager' | 'staff') {
  const r = await call('/v1/auth/users', 'POST', { token: ownerToken, body: { email, role } });
  expect(r.status).toBe(201);
  expect(r.json.invite_sent).toBe(false);
  const token = decodeURIComponent(String(r.json.invite_url).split('#confirm=')[1]);
  const v = await call('/v1/auth/verify', 'POST', { body: { token, mode: 'bearer' } });
  expect(v.status).toBe(200);
  return { token: v.json.session_token as string, id: r.json.user.id as string };
}

beforeEach(async () => {
  const d = db();
  for (const t of ['sessions', 'login_tokens', 'identities', 'auth_throttle', 'audit_log', 'users']) {
    await d.run(`DELETE FROM ${t}`);
  }
  await d.run(`DELETE FROM config WHERE key IN ('auth', 'email')`);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('password hashing', () => {
  it('round-trips and rejects a wrong password', async () => {
    const h = await hashPassword('correct horse battery', DEFAULT_POLICY, 'pep');
    expect(h.startsWith('$pbkdf2-sha256$i=100000,pep=1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h, 'pep')).toBe(true);
    expect(await verifyPassword('correct horse batterz', h, 'pep')).toBe(false);
  });

  it('a hash made with a pepper cannot be verified without it, or with another', async () => {
    const h = await hashPassword('correct horse battery', DEFAULT_POLICY, 'pep');
    expect(await verifyPassword('correct horse battery', h, undefined)).toBe(false);
    expect(await verifyPassword('correct horse battery', h, 'other')).toBe(false);
  });

  it('works without a pepper and records that', async () => {
    const h = await hashPassword('correct horse battery', DEFAULT_POLICY);
    expect(h).toContain('pep=0');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
  });

  it('uses a fresh salt every time', async () => {
    const a = await hashPassword('same password here', DEFAULT_POLICY, 'p');
    const b = await hashPassword('same password here', DEFAULT_POLICY, 'p');
    expect(a).not.toBe(b);
  });

  it('flags hashes that differ from the current policy', async () => {
    const weak = await hashPassword('correct horse battery', { ...DEFAULT_POLICY, iterations: 50_000 }, 'pep');
    expect(needsRehash(weak, DEFAULT_POLICY, 'pep')).toBe(true);
    const cur = await hashPassword('correct horse battery', DEFAULT_POLICY, 'pep');
    expect(needsRehash(cur, DEFAULT_POLICY, 'pep')).toBe(false);
    expect(needsRehash(cur, DEFAULT_POLICY, undefined)).toBe(true);
    expect(needsRehash(cur, { ...DEFAULT_POLICY, kdf: 'scrypt' }, 'pep')).toBe(true);
    expect(needsRehash('garbage', DEFAULT_POLICY, 'pep')).toBe(true);
  });

  it('scrypt round-trips (tiny N: this is pure JavaScript, so the real setting is slow on purpose)', async () => {
    const policy = { ...DEFAULT_POLICY, kdf: 'scrypt' as const, scrypt: { n: 1024, r: 8, p: 1 } };
    const h = await hashPassword('correct horse battery', policy, 'pep');
    expect(h.startsWith('$scrypt$n=1024,r=8,p=1,pep=1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h, 'pep')).toBe(true);
    expect(await verifyPassword('nope nope nope nope', h, 'pep')).toBe(false);
    expect(needsRehash(h, policy, 'pep')).toBe(false);
  }, 60_000);

  it('never throws on malformed or unsupported records', async () => {
    for (const bad of ['', 'plain', '$x$y$z$w', '$pbkdf2-sha256$i=abc$s$h', '$pbkdf2-sha256$i=9999999,pep=0$AAAA$AAAA']) {
      expect(await verifyPassword('whatever password', bad, 'pep')).toBe(false);
    }
    expect(parseHash('$pbkdf2-sha256$i=9999999,pep=0$AAAA$AAAA')).toBeNull();
  });

  it('checks password shape', () => {
    expect(checkPasswordShape('short')).toMatch(/at least 10/);
    expect(checkPasswordShape('x'.repeat(300))).toMatch(/too long/);
    expect(checkPasswordShape('long enough password')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('crypto helpers', () => {
  it('randomCode is six digits and varies', () => {
    const codes = new Set(Array.from({ length: 50 }, () => randomCode(6)));
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(40);
  });
  it('timingSafeEqual', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('permissions', () => {
  it('maps routes to permissions', () => {
    expect(requiredPermission('GET', '/v1/orders')).toBe('orders.read');
    expect(requiredPermission('PATCH', '/v1/orders/abc')).toBe('orders.write');
    expect(requiredPermission('POST', '/v1/orders/abc/refund')).toBe('orders.refund');
    expect(requiredPermission('POST', '/v1/orders/abc/refunds/manual')).toBe('orders.refund');
    expect(requiredPermission('GET', '/v1/orders/abc/refunds')).toBe('orders.read');
    expect(requiredPermission('POST', '/v1/orders/abc/payments')).toBe('orders.payments');
    expect(requiredPermission('POST', '/v1/discounts')).toBe('discounts.write');
    expect(requiredPermission('GET', '/v1/discounts')).toBe('discounts.read');
    expect(requiredPermission('PUT', '/v1/setup/email')).toBe('settings.manage');
    expect(requiredPermission('GET', '/v1/webhooks')).toBe('webhooks.manage');
    expect(requiredPermission('POST', '/v1/catalog/products/x/assets')).toBe('products.write');
    expect(requiredPermission('GET', '/v1/submissions')).toBe('messages.read');
    expect(requiredPermission('GET', '/v1/unknown-thing')).toBeNull();
  });

  it('applies the role table', () => {
    expect(roleCan('staff', 'orders.refund')).toBe(false);
    expect(roleCan('manager', 'orders.refund')).toBe(true);
    expect(roleCan('staff', 'orders.payments')).toBe(true);
    expect(roleCan('manager', 'settings.manage')).toBe(false);
    expect(roleCan('owner', 'users.manage')).toBe(true);
    expect(roleCan('agency', 'users.manage')).toBe(true);
    expect(roleCan('manager', 'users.manage')).toBe(false);
  });

  it('denies unlisted routes except for owner and agency', () => {
    expect(roleCanRequest('staff', 'GET', '/v1/mystery').ok).toBe(false);
    expect(roleCanRequest('manager', 'GET', '/v1/mystery').ok).toBe(false);
    expect(roleCanRequest('owner', 'GET', '/v1/mystery').ok).toBe(true);
    expect(roleCanRequest('agency', 'GET', '/v1/mystery').ok).toBe(true);
  });

  it('knows all four roles', () => {
    expect([...ROLES].sort()).toEqual(['agency', 'manager', 'owner', 'staff']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('bootstrap', () => {
  it('needs the setup token', async () => {
    const none = await call('/v1/auth/bootstrap', 'POST', { body: { email: 'owner@shop.com' } });
    expect(none.status).toBe(401);
    const wrong = await call('/v1/auth/bootstrap', 'POST', { body: { email: 'owner@shop.com' }, headers: { 'X-Setup-Token': 'nope' } });
    expect(wrong.status).toBe(401);
  });

  it('creates an owner and returns a one-time sign-in link', async () => {
    const r = await call('/v1/auth/bootstrap', 'POST', { body: { email: 'Owner@Shop.com', name: 'Nadey' }, headers: SETUP });
    expect(r.status).toBe(200);
    expect(r.json.created).toBe(true);
    expect(r.json.user.email).toBe('owner@shop.com');
    expect(r.json.user.role).toBe('owner');
    expect(r.json.login_url).toMatch(/^https:\/\/admin\.test\.com\/#confirm=lt_/);

    const first = await call('/v1/auth/verify', 'POST', { body: { token: r.json.token } });
    expect(first.status).toBe(200);
    expect(first.json.session_token).toMatch(/^ses_/);
    const second = await call('/v1/auth/verify', 'POST', { body: { token: r.json.token } });
    expect(second.status).toBe(401);
  });

  it('run again for the same address, it re-opens the account (recovery)', async () => {
    await call('/v1/auth/bootstrap', 'POST', { body: { email: 'owner@shop.com' }, headers: SETUP });
    const again = await call('/v1/auth/bootstrap', 'POST', { body: { email: 'owner@shop.com' }, headers: SETUP });
    expect(again.json.created).toBe(false);
    const v = await call('/v1/auth/verify', 'POST', { body: { token: again.json.token } });
    expect(v.status).toBe(200);
  });

  it('is rate limited against guessing the token', async () => {
    const ip = '198.51.100.7';
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await call('/v1/auth/bootstrap', 'POST', { body: { email: 'x@shop.com' }, headers: { 'X-Setup-Token': `guess${i}` }, ip })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('sign-in link and code', () => {
  let restore: () => void;
  let sent: Array<{ to: string[]; subject: string; html: string; text: string }>;

  beforeEach(async () => {
    sent = [];
    await seedEmailConfig(db());
    restore = mockFetch((url, init) => {
      if (url.includes('api.resend.com')) {
        sent.push(JSON.parse(String(init?.body)));
        return MOCK_RESPONSES.resendSend();
      }
      return new Response('{}', { status: 200 });
    });
  });
  // The email goes out in the background (waitUntil), so wait for it, and let strays land before un-mocking.
  const waitForEmails = async (n: number) => {
    for (let i = 0; i < 100 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    expect(sent.length).toBe(n);
  };
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 150));
    restore();
  });

  const lastEmail = () => {
    const m = sent[sent.length - 1];
    return {
      code: m.text.match(/\b(\d{6})\b/)![1],
      token: decodeURIComponent(m.text.match(/#confirm=(lt_[A-Za-z0-9_%-]+)/)![1]),
      m,
    };
  };

  it('emails a link and a code, and either one signs in', async () => {
    await signIn('owner@shop.com');
    const r = await call('/v1/auth/login-link', 'POST', { body: { email: 'owner@shop.com', locale: 'en' } });
    expect(r.status).toBe(200);
    await waitForEmails(1);
    expect(sent[0].to).toEqual(['owner@shop.com']);
    const { code, token } = lastEmail();
    expect(sent[0].subject).toMatch(/sign-in link/i);

    const byCode = await call('/v1/auth/verify', 'POST', { body: { email: 'owner@shop.com', code } });
    expect(byCode.status).toBe(200);
    expect(byCode.json.role).toBe('owner');
    // The link from the same email is now spent too (one token, one use).
    const byLink = await call('/v1/auth/verify', 'POST', { body: { token } });
    expect(byLink.status).toBe(401);
  });

  it('is written in French by default', async () => {
    await signIn('owner@shop.com');
    await call('/v1/auth/login-link', 'POST', { body: { email: 'owner@shop.com' } });
    await waitForEmails(1);
    expect(sent[0].subject).toMatch(/lien de connexion/i);
  });

  it('answers the same for an unknown address and sends nothing', async () => {
    const known = await call('/v1/auth/login-link', 'POST', { body: { email: 'nobody@shop.com' } });
    expect(known.status).toBe(200);
    expect(known.json.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(sent.length).toBe(0);
    expect((await db().query(`SELECT 1 FROM login_tokens`)).length).toBe(0);
  });

  it('locks a code after five wrong guesses, even for the right code', async () => {
    await signIn('owner@shop.com');
    await call('/v1/auth/login-link', 'POST', { body: { email: 'owner@shop.com' } });
    await waitForEmails(1);
    const { code } = lastEmail();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await call('/v1/auth/verify', 'POST', { body: { email: 'owner@shop.com', code: wrong } });
      expect(r.status).toBe(401);
    }
    const right = await call('/v1/auth/verify', 'POST', { body: { email: 'owner@shop.com', code } });
    expect(right.status).toBe(401);
  });

  it('a newer link invalidates the older one', async () => {
    await signIn('owner@shop.com');
    await call('/v1/auth/login-link', 'POST', { body: { email: 'owner@shop.com' } });
    await waitForEmails(1);
    const first = lastEmail();
    await call('/v1/auth/login-link', 'POST', { body: { email: 'owner@shop.com' } });
    await waitForEmails(2);
    const second = lastEmail();
    expect((await call('/v1/auth/verify', 'POST', { body: { token: first.token } })).status).toBe(401);
    expect((await call('/v1/auth/verify', 'POST', { body: { token: second.token } })).status).toBe(200);
  });

  it('rejects an expired link', async () => {
    await signIn('owner@shop.com');
    await call('/v1/auth/login-link', 'POST', { body: { email: 'owner@shop.com' } });
    await waitForEmails(1);
    const { token } = lastEmail();
    await db().run(`UPDATE login_tokens SET expires_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
    expect((await call('/v1/auth/verify', 'POST', { body: { token } })).status).toBe(401);
  });

  it('stores no usable secret in the database', async () => {
    await signIn('owner@shop.com');
    await call('/v1/auth/login-link', 'POST', { body: { email: 'owner@shop.com' } });
    await waitForEmails(1);
    const { code, token } = lastEmail();
    const rows = await db().query<{ token_hash: string; code_hash: string }>(`SELECT token_hash, code_hash FROM login_tokens`);
    for (const r of rows) {
      expect(r.token_hash).not.toContain(token);
      expect(r.code_hash).not.toContain(code);
    }
    // The stored value is the SHA-256 of the token, not the token.
    expect(rows.map((r) => r.token_hash)).toContain(await sha256Hex(token));
  });

  it('throttles link requests per address', async () => {
    await signIn('owner@shop.com');
    const out: number[] = [];
    for (let i = 0; i < 7; i++) out.push((await call('/v1/auth/login-link', 'POST', { body: { email: 'owner@shop.com' } })).status);
    expect(out.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(out[5]).toBe(429);
    await waitForEmails(5);
  });

  it('refuses malformed input', async () => {
    expect((await call('/v1/auth/login-link', 'POST', { body: { email: 'not-an-email' } })).status).toBe(400);
    expect((await call('/v1/auth/verify', 'POST', { body: {} })).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('sessions', () => {
  it('/me works with the bearer session and shows role and permissions', async () => {
    const { token } = await signIn('owner@shop.com');
    const me = await call('/v1/auth/me', 'GET', { token });
    expect(me.status).toBe(200);
    expect(me.json.kind).toBe('session');
    expect(me.json.role).toBe('owner');
    expect(me.json.permissions).toContain('users.manage');
  });

  it('rejects no credentials, garbage, and a public key', async () => {
    expect((await call('/v1/auth/me', 'GET')).status).toBe(401);
    expect((await call('/v1/auth/me', 'GET', { token: 'ses_garbage' })).status).toBe(401);
    const pk = generateApiKey('pk');
    await db().run(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES (?, ?, ?, 'public')`, [uuid(), await hashKey(pk), pk.slice(0, 8)]);
    expect((await call('/v1/auth/me', 'GET', { token: pk })).status).toBe(403);
  });

  it('logout revokes the session', async () => {
    const { token } = await signIn('owner@shop.com');
    expect((await call('/v1/auth/logout', 'POST', { token })).status).toBe(200);
    expect((await call('/v1/auth/me', 'GET', { token })).status).toBe(401);
  });

  it('logout-all closes every session of the user', async () => {
    const a = await signIn('owner@shop.com');
    const b = await signIn('owner@shop.com');
    expect((await call('/v1/auth/logout-all', 'POST', { token: a.token })).status).toBe(200);
    expect((await call('/v1/auth/me', 'GET', { token: b.token })).status).toBe(401);
  });

  it('ends at the absolute expiry', async () => {
    const { token } = await signIn('owner@shop.com');
    await db().run(`UPDATE sessions SET expires_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
    expect((await call('/v1/auth/me', 'GET', { token })).status).toBe(401);
  });

  it('ends after the idle period', async () => {
    const { token } = await signIn('owner@shop.com');
    await db().run(`UPDATE sessions SET last_seen_at = ?`, [new Date(Date.now() - 4 * 86_400_000).toISOString()]);
    expect((await call('/v1/auth/me', 'GET', { token })).status).toBe(401);
  });

  it('a new sign-in gives a new session token (no fixation)', async () => {
    const a = await signIn('owner@shop.com');
    const b = await signIn('owner@shop.com');
    expect(a.token).not.toBe(b.token);
  });

  it('the admin API key keeps working and reports itself as a key', async () => {
    const sk = generateApiKey('sk');
    await db().run(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES (?, ?, ?, 'admin')`, [uuid(), await hashKey(sk), sk.slice(0, 8)]);
    const me = await call('/v1/auth/me', 'GET', { token: sk });
    expect(me.json.kind).toBe('api_key');
    expect((await call('/v1/orders', 'GET', { token: sk })).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cookie mode', () => {
  async function cookieLogin() {
    const boot = await call('/v1/auth/bootstrap', 'POST', { body: { email: 'owner@shop.com' }, headers: SETUP });
    const v = await call('/v1/auth/verify', 'POST', { body: { token: boot.json.token, mode: 'cookie' }, origin: ORIGIN });
    return v;
  }
  const cookieOf = (res: Response) => {
    const sc = res.headers.get('set-cookie') ?? '';
    return sc.split(';')[0];
  };

  it('sets a __Host- HttpOnly Secure SameSite=Lax cookie and keeps the token out of the body', async () => {
    const v = await cookieLogin();
    expect(v.status).toBe(200);
    expect(v.json.session_token).toBeUndefined();
    const sc = v.res.headers.get('set-cookie') ?? '';
    expect(sc).toMatch(/^__Host-sid=ses_/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Domain=/i);
  });

  it('is refused from an origin that is not allowed, and does not spend the token', async () => {
    const boot = await call('/v1/auth/bootstrap', 'POST', { body: { email: 'owner@shop.com' }, headers: SETUP });
    const bad = await call('/v1/auth/verify', 'POST', { body: { token: boot.json.token, mode: 'cookie' }, origin: 'https://evil.example' });
    expect(bad.status).toBe(400);
    const ok = await call('/v1/auth/verify', 'POST', { body: { token: boot.json.token, mode: 'bearer' } });
    expect(ok.status).toBe(200);
  });

  it('authenticates reads by cookie', async () => {
    const v = await cookieLogin();
    const me = await call('/v1/auth/me', 'GET', { cookie: cookieOf(v.res), origin: ORIGIN });
    expect(me.status).toBe(200);
    expect(me.json.via).toBe('cookie');
    expect((await call('/v1/orders', 'GET', { cookie: cookieOf(v.res), origin: ORIGIN })).status).toBe(200);
  });

  it('blocks a state-changing request from another origin or with no Origin (CSRF)', async () => {
    const v = await cookieLogin();
    const cookie = cookieOf(v.res);
    const body = { password_login: true };
    expect((await call('/v1/auth/settings', 'PUT', { cookie, body, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/v1/auth/settings', 'PUT', { cookie, body })).status).toBe(403);
    expect((await call('/v1/auth/settings', 'PUT', { cookie, body, origin: ORIGIN })).status).toBe(200);
  });

  it('logout clears the cookie and ends the session', async () => {
    const v = await cookieLogin();
    const cookie = cookieOf(v.res);
    const out = await call('/v1/auth/logout', 'POST', { cookie, origin: ORIGIN });
    expect(out.status).toBe(200);
    expect(out.res.headers.get('set-cookie') ?? '').toMatch(/__Host-sid=;|Max-Age=0/i);
    expect((await call('/v1/auth/me', 'GET', { cookie, origin: ORIGIN })).status).toBe(401);
  });

  it('an Authorization header wins over a cookie', async () => {
    const v = await cookieLogin();
    const r = await call('/v1/auth/me', 'GET', { cookie: cookieOf(v.res), token: 'ses_not_a_real_one', origin: ORIGIN });
    expect(r.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('password sign-in (optional)', () => {
  it('is off by default', async () => {
    await signIn('owner@shop.com');
    const r = await call('/v1/auth/login', 'POST', { body: { email: 'owner@shop.com', password: 'whatever long password' } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('password_login_disabled');
    const cfg = await call('/v1/auth/config', 'GET');
    expect(cfg.json.methods).toEqual({ link: true, code: true, password: false });
  });

  it('signs in once enabled and a password has been set', async () => {
    const { token } = await signIn('owner@shop.com');
    expect((await call('/v1/auth/settings', 'PUT', { token, body: { password_login: true } })).json.password_login).toBe(true);
    expect((await call('/v1/auth/password', 'PUT', { token, body: { new_password: 'a long enough password' } })).status).toBe(200);

    const ok = await call('/v1/auth/login', 'POST', { body: { email: 'OWNER@shop.com', password: 'a long enough password' } });
    expect(ok.status).toBe(200);
    expect(ok.json.session_token).toMatch(/^ses_/);

    const bad = await call('/v1/auth/login', 'POST', { body: { email: 'owner@shop.com', password: 'a wrong long password' } });
    expect(bad.status).toBe(401);
    const unknown = await call('/v1/auth/login', 'POST', { body: { email: 'ghost@shop.com', password: 'a long enough password' } });
    expect(unknown.status).toBe(401);
    expect(unknown.json.error.message).toBe(bad.json.error.message);
  });

  it('needs the current password to change it, and closes other sessions', async () => {
    const a = await signIn('owner@shop.com');
    await call('/v1/auth/settings', 'PUT', { token: a.token, body: { password_login: true } });
    await call('/v1/auth/password', 'PUT', { token: a.token, body: { new_password: 'first long password' } });
    const b = await signIn('owner@shop.com');

    expect((await call('/v1/auth/password', 'PUT', { token: a.token, body: { new_password: 'second long password' } })).status).toBe(401);
    expect((await call('/v1/auth/password', 'PUT', { token: a.token, body: { current_password: 'first long password', new_password: 'short' } })).status).toBe(400);
    expect((await call('/v1/auth/password', 'PUT', { token: a.token, body: { current_password: 'first long password', new_password: 'second long password' } })).status).toBe(200);

    expect((await call('/v1/auth/me', 'GET', { token: a.token })).status).toBe(200);
    expect((await call('/v1/auth/me', 'GET', { token: b.token })).status).toBe(401);
  });

  it('re-hashes at the next login when the iteration setting changes', async () => {
    const { token } = await signIn('owner@shop.com');
    await call('/v1/auth/settings', 'PUT', { token, body: { password_login: true } });
    await call('/v1/auth/password', 'PUT', { token, body: { new_password: 'a long enough password' } });
    const before = (await db().query<{ password_hash: string }>(`SELECT password_hash FROM users`))[0].password_hash;
    expect(before).toContain('i=100000');

    const s = await call('/v1/auth/settings', 'PUT', { token, body: { iterations: 50_000 } });
    expect(s.json.iterations).toBe(50_000);
    expect((await call('/v1/auth/login', 'POST', { body: { email: 'owner@shop.com', password: 'a long enough password' } })).status).toBe(200);
    const after = (await db().query<{ password_hash: string }>(`SELECT password_hash FROM users`))[0].password_hash;
    expect(after).toContain('i=50000');
  });

  it('caps PBKDF2 iterations at what the runtime allows', async () => {
    const { token } = await signIn('owner@shop.com');
    const s = await call('/v1/auth/settings', 'PUT', { token, body: { iterations: 600_000 } });
    expect(s.json.iterations).toBe(100_000);
    expect(s.json.meets_owasp).toBe(false);
    expect(s.json.pepper_configured).toBe(true);
  });

  it('throttles guesses per account before hashing', async () => {
    const { token } = await signIn('owner@shop.com');
    await call('/v1/auth/settings', 'PUT', { token, body: { password_login: true } });
    const out: number[] = [];
    for (let i = 0; i < 10; i++) {
      out.push((await call('/v1/auth/login', 'POST', { body: { email: 'owner@shop.com', password: `wrong password ${i} xx` } })).status);
    }
    expect(out.slice(0, 8).every((s) => s === 401)).toBe(true);
    expect(out[8]).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('roles and users', () => {
  it('staff can work orders but not refund, discount or configure', async () => {
    const owner = await signIn('owner@shop.com');
    const staff = await createAndSignIn(owner.token, 'staff@shop.com', 'staff');

    expect((await call('/v1/orders', 'GET', { token: staff.token })).status).toBe(200);
    expect((await call('/v1/submissions', 'GET', { token: staff.token })).status).toBe(200);
    expect((await call('/v1/discounts', 'GET', { token: staff.token })).status).toBe(403);
    expect((await call('/v1/discounts', 'POST', { token: staff.token, body: {} })).status).toBe(403);
    expect((await call('/v1/orders/x/refund', 'POST', { token: staff.token, body: {} })).status).toBe(403);
    expect((await call('/v1/setup/stripe', 'POST', { token: staff.token, body: {} })).status).toBe(403);
    expect((await call('/v1/webhooks', 'GET', { token: staff.token })).status).toBe(403);
    expect((await call('/v1/auth/users', 'GET', { token: staff.token })).status).toBe(403);
    expect((await call('/v1/auth/settings', 'GET', { token: staff.token })).status).toBe(403);
    expect((await call('/v1/auth/audit', 'GET', { token: staff.token })).status).toBe(403);
  });

  it('a manager can refund and discount, but not manage users or settings', async () => {
    const owner = await signIn('owner@shop.com');
    const mgr = await createAndSignIn(owner.token, 'manager@shop.com', 'manager');
    expect((await call('/v1/discounts', 'GET', { token: mgr.token })).status).toBe(200);
    // Past the permission check; the order does not exist.
    expect((await call('/v1/orders/does-not-exist/refund', 'POST', { token: mgr.token, body: {} })).status).not.toBe(403);
    expect((await call('/v1/auth/users', 'GET', { token: mgr.token })).status).toBe(403);
    expect((await call('/v1/setup/stripe', 'POST', { token: mgr.token, body: {} })).status).toBe(403);
  });

  it('a role change applies to the very next request', async () => {
    const owner = await signIn('owner@shop.com');
    const mgr = await createAndSignIn(owner.token, 'manager@shop.com', 'manager');
    expect((await call('/v1/discounts', 'GET', { token: mgr.token })).status).toBe(200);
    expect((await call(`/v1/auth/users/${mgr.id}`, 'PATCH', { token: owner.token, body: { role: 'staff' } })).status).toBe(200);
    expect((await call('/v1/discounts', 'GET', { token: mgr.token })).status).toBe(403);
  });

  it('disabling a user ends their sessions', async () => {
    const owner = await signIn('owner@shop.com');
    const staff = await createAndSignIn(owner.token, 'staff@shop.com', 'staff');
    expect((await call(`/v1/auth/users/${staff.id}`, 'PATCH', { token: owner.token, body: { status: 'disabled' } })).status).toBe(200);
    expect((await call('/v1/orders', 'GET', { token: staff.token })).status).toBe(401);
    // ...and they cannot get a new link.
    const r = await call('/v1/auth/login-link', 'POST', { body: { email: 'staff@shop.com' } });
    expect(r.status).toBe(200);
    expect((await db().query(`SELECT 1 FROM login_tokens WHERE user_id = ?`, [staff.id])).length).toBe(1); // only the invite
  });

  it('never leaves the shop without an active owner', async () => {
    const owner = await signIn('owner@shop.com');
    const r1 = await call(`/v1/auth/users/${owner.user.id}`, 'PATCH', { token: owner.token, body: { role: 'staff' } });
    expect(r1.status).toBe(409);
    const r2 = await call(`/v1/auth/users/${owner.user.id}`, 'PATCH', { token: owner.token, body: { status: 'disabled' } });
    expect(r2.status).toBe(409);
    // With a second owner it is allowed.
    const b = await call('/v1/auth/users', 'POST', { token: owner.token, body: { email: 'second@shop.com', role: 'owner' } });
    expect(b.status).toBe(201);
    expect((await call(`/v1/auth/users/${owner.user.id}`, 'PATCH', { token: owner.token, body: { role: 'manager' } })).status).toBe(200);
  });

  it('rejects a duplicate address', async () => {
    const owner = await signIn('owner@shop.com');
    const r = await call('/v1/auth/users', 'POST', { token: owner.token, body: { email: 'OWNER@shop.com', role: 'staff' } });
    expect(r.status).toBe(409);
  });

  it('the agency account is invisible to the owner and cannot be touched or created by them', async () => {
    const agency = await signIn('dev@agency.com', 'agency');
    const owner = await signIn('owner@shop.com');

    const asOwner = await call('/v1/auth/users', 'GET', { token: owner.token });
    expect(asOwner.json.items.map((u: any) => u.email)).toEqual(['owner@shop.com']);
    const asAgency = await call('/v1/auth/users', 'GET', { token: agency.token });
    expect(asAgency.json.items.map((u: any) => u.email).sort()).toEqual(['dev@agency.com', 'owner@shop.com']);

    expect((await call(`/v1/auth/users/${agency.user.id}`, 'PATCH', { token: owner.token, body: { status: 'disabled' } })).status).toBe(404);
    expect((await call(`/v1/auth/users/${agency.user.id}/invite`, 'POST', { token: owner.token })).status).toBe(404);
    expect((await call('/v1/auth/users', 'POST', { token: owner.token, body: { email: 'x@y.com', role: 'agency' } })).status).toBe(403);
  });

  it('the agency role can reach everything an owner can', async () => {
    const agency = await signIn('dev@agency.com', 'agency');
    expect((await call('/v1/orders', 'GET', { token: agency.token })).status).toBe(200);
    expect((await call('/v1/auth/settings', 'GET', { token: agency.token })).status).toBe(200);
    expect((await call('/v1/webhooks', 'GET', { token: agency.token })).status).toBe(200);
  });

  it('records who did what in the audit log', async () => {
    const owner = await signIn('owner@shop.com');
    await createAndSignIn(owner.token, 'staff@shop.com', 'staff');
    const log = await call('/v1/auth/audit', 'GET', { token: owner.token });
    expect(log.status).toBe(200);
    const actions = log.json.items.map((i: any) => i.action);
    expect(actions).toContain('auth.login');
    expect(actions).toContain('user.created');
    expect(actions).toContain('auth.bootstrap_created');
  });

  it('hands the invite link back when no email provider is set up', async () => {
    const owner = await signIn('owner@shop.com');
    const r = await call('/v1/auth/users', 'POST', { token: owner.token, body: { email: 'staff@shop.com', role: 'staff' } });
    expect(r.json.invite_sent).toBe(false);
    expect(r.json.invite_url).toMatch(/#confirm=lt_/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('CORS', () => {
  const preflight = (path: string, origin: string) =>
    SELF.fetch(`http://localhost${path}`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });

  it('keeps public endpoints open without credentials', async () => {
    const r = await preflight('/v1/products', 'https://some-storefront.example');
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
    expect(r.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
  });

  it('echoes an allowed admin origin with credentials', async () => {
    const r = await preflight('/v1/orders', ORIGIN);
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(r.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does not serve /v1/auth/* cross-origin to anyone else', async () => {
    const r = await preflight('/v1/auth/login-link', 'https://evil.example');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const ok = await preflight('/v1/auth/login-link', ORIGIN);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('never combines a wildcard with credentials on real responses', async () => {
    const r = await SELF.fetch('http://localhost/', { headers: { Origin: 'https://evil.example' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
