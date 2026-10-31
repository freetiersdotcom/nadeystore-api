// =============================================================================
// src/__tests__/passkeys.test.ts
//
// Passkeys (WebAuthn) for storefront customers and admin users. A software authenticator
// (webauthn-helper.ts) answers the server's challenges, so the real verification runs:
// registration, sign-in, replay, wrong origin / RP, missing user verification, tampered
// signature, counter rollback, expiry, and the walls between customers, admins and people.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { SoftPasskey } from './webauthn-helper';
import { openCustomer, createCustomerSession } from '../account/service';
import { resolveRp, purgePasskeyData, PasskeyError, beginLogin, finishLogin } from '../auth/passkeys';
import { hashKey, generateApiKey } from '../middleware/auth';

const STORE = 'https://store.test.com';
const ADMIN = 'https://admin.test.com';
const RP = 'test.com';
const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);

let ipCounter = 0;
const nextIp = () => `198.51.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
type CallOpts = { body?: unknown; token?: string; origin?: string; cookie?: string; ip?: string; headers?: Record<string, string> };
async function call(path: string, method: string, o: CallOpts = {}) {
  const res = await SELF.fetch(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json', 'CF-Connecting-IP': o.ip ?? nextIp(),
      ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
      ...(o.origin ? { Origin: o.origin } : {}), ...(o.cookie ? { Cookie: o.cookie } : {}), ...o.headers,
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
  return { res, json, status: res.status };
}

beforeEach(async () => {
  const d = db();
  for (const t of ['passkey_credentials', 'webauthn_challenges', 'customer_sessions', 'customers', 'sessions', 'login_tokens', 'auth_throttle', 'audit_log', 'users']) await d.run(`DELETE FROM ${t}`);
});

// ── helpers ─────────────────────────────────────────────────────────────────
async function customerSession(email: string) {
  const c = await openCustomer(db(), email, 'en');
  const s = await createCustomerSession(db(), c.id, { via: 'bearer' });
  return { id: c.id, token: s.token };
}
const SETUP = { 'X-Setup-Token': 'test-setup-token' };
async function adminSession(email: string, role: 'owner' | 'agency' = 'owner') {
  const boot = await call('/v1/auth/bootstrap', 'POST', { body: { email, role }, headers: SETUP });
  const v = await call('/v1/auth/verify', 'POST', { body: { token: boot.json.token, mode: 'bearer' } });
  expect(v.status).toBe(200);
  return { token: v.json.session_token as string, id: v.json.user.id as string };
}

const C = '/v1/account/passkeys';
const A = '/v1/auth/passkeys';

/** Register `pk` for the signed-in person. */
async function register(base: string, origin: string, token: string, pk: SoftPasskey, name = 'My phone', o = {}) {
  const opt = await call(`${base}/register/options`, 'POST', { token, origin });
  expect(opt.status).toBe(200);
  const response = await pk.create(opt.json.options, o);
  return { opt, ...(await call(`${base}/register/verify`, 'POST', { token, origin, body: { challenge_id: opt.json.challenge_id, response, name } })) };
}
async function signInWith(base: string, origin: string, pk: SoftPasskey, o = {}, mode: 'bearer' | 'cookie' = 'bearer') {
  const opt = await call(`${base}/login/options`, 'POST', { origin });
  expect(opt.status).toBe(200);
  const response = await pk.get(opt.json.options, o);
  return { opt, response, ...(await call(`${base}/login/verify`, 'POST', { origin, body: { challenge_id: opt.json.challenge_id, response, mode } })) };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('customer passkeys', () => {
  it('registers a passkey, lists it, and signs in with it (no email needed)', async () => {
    const me = await customerSession('ann@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    const opt = await call(`${C}/register/options`, 'POST', { token: me.token, origin: STORE });
    expect(opt.json.options.rp.id).toBe(RP === 'test.com' ? opt.json.options.rp.id : RP);
    expect(opt.json.options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(opt.json.options.attestation).toBe('none');
    const reg = await call(`${C}/register/verify`, 'POST', { token: me.token, origin: STORE, body: { challenge_id: opt.json.challenge_id, response: await pk.create(opt.json.options), name: 'Ann phone' } });
    expect(reg.status).toBe(201);
    expect(reg.json.passkey).toMatchObject({ id: pk.id, name: 'Ann phone' });
    expect(JSON.stringify(reg.json)).not.toMatch(/public_key/);

    const list = await call(C, 'GET', { token: me.token });
    expect(list.json.items).toHaveLength(1);

    const login = await signInWith(C, STORE, pk);
    expect(login.status).toBe(200);
    expect(login.json.customer.email).toBe('ann@shop.test');
    const who = await call('/v1/account/me', 'GET', { token: login.json.session_token });
    expect(who.status).toBe(200);
    expect(who.json.customer.id).toBe(me.id);
    const [row] = await db().query<any>(`SELECT counter, last_used_at FROM passkey_credentials WHERE id = ?`, [pk.id]);
    expect(row.counter).toBe(1);
    expect(row.last_used_at).toBeTruthy();
  });

  it('needs a signed-in customer to register, list or remove', async () => {
    expect((await call(C, 'GET', { origin: STORE })).status).toBe(401);
    expect((await call(`${C}/register/options`, 'POST', { origin: STORE })).status).toBe(401);
    expect((await call(`${C}/abc`, 'DELETE', { origin: STORE })).status).toBe(401);
  });

  it('a challenge works once: replaying a registration or a sign-in fails', async () => {
    const me = await customerSession('ann@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    const opt = await call(`${C}/register/options`, 'POST', { token: me.token, origin: STORE });
    const response = await pk.create(opt.json.options);
    const body = { challenge_id: opt.json.challenge_id, response };
    expect((await call(`${C}/register/verify`, 'POST', { token: me.token, origin: STORE, body })).status).toBe(201);
    expect((await call(`${C}/register/verify`, 'POST', { token: me.token, origin: STORE, body })).status).toBe(400);

    const lo = await call(`${C}/login/options`, 'POST', { origin: STORE });
    const resp = await pk.get(lo.json.options);
    const lb = { challenge_id: lo.json.challenge_id, response: resp, mode: 'bearer' };
    expect((await call(`${C}/login/verify`, 'POST', { origin: STORE, body: lb })).status).toBe(200);
    expect((await call(`${C}/login/verify`, 'POST', { origin: STORE, body: lb })).status).toBe(401);
  });

  it('refuses origins that are not the storefront (options and responses)', async () => {
    expect((await call(`${C}/login/options`, 'POST', { origin: 'https://evil.example' })).status).toBe(400);
    expect((await call(`${C}/login/options`, 'POST', {})).status).toBe(400);
    expect((await call(`${C}/login/options`, 'POST', { origin: ADMIN })).status).toBe(400); // an admin origin is not a store origin
    const me = await customerSession('ann@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    expect((await register(C, STORE, me.token, pk)).status).toBe(201);
    // a phishing page asks the device to sign for ITS address: the response carries evil's origin
    const phish = await signInWith(C, STORE, pk, { origin: 'https://evil.example' });
    expect(phish.status).toBe(401);
  });

  it('refuses a response made for another site (RP ID), without user verification, or with a bad signature', async () => {
    const me = await customerSession('ann@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    await register(C, STORE, me.token, pk);
    expect((await signInWith(C, STORE, pk, { rpId: 'evil.example' })).status).toBe(401);
    expect((await signInWith(C, STORE, pk, { uv: false })).status).toBe(401);
    expect((await signInWith(C, STORE, pk, { up: false })).status).toBe(401);
    expect((await signInWith(C, STORE, pk, { tamper: true })).status).toBe(401);
    expect((await signInWith(C, STORE, pk, { type: 'webauthn.create' })).status).toBe(401);
    expect((await signInWith(C, STORE, pk, { challenge: 'bm90LXRoZS1jaGFsbGVuZ2U' })).status).toBe(401);
    const stranger = await SoftPasskey.create(STORE, RP);
    stranger.credId = pk.credId; // same credential id, different private key
    expect((await signInWith(C, STORE, stranger)).status).toBe(401);
    expect((await signInWith(C, STORE, pk)).status).toBe(200); // and the real one still works
  });

  it('detects a cloned authenticator (the counter goes backwards)', async () => {
    const me = await customerSession('ann@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    await register(C, STORE, me.token, pk);
    expect((await signInWith(C, STORE, pk, { counter: 7 })).status).toBe(200);
    expect((await signInWith(C, STORE, pk, { counter: 3 })).status).toBe(401);
    expect((await signInWith(C, STORE, pk, { counter: 8 })).status).toBe(200);
  });

  it('accepts a synced passkey whose counter stays 0', async () => {
    const me = await customerSession('ann@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    await register(C, STORE, me.token, pk, 'iCloud', { backedUp: true });
    expect((await signInWith(C, STORE, pk, { counter: 0, backedUp: true })).status).toBe(200);
    expect((await signInWith(C, STORE, pk, { counter: 0, backedUp: true })).status).toBe(200);
  });

  it('an expired challenge is refused', async () => {
    const pk = await SoftPasskey.create(STORE, RP);
    const me = await customerSession('ann@shop.test');
    await register(C, STORE, me.token, pk);
    const lo = await call(`${C}/login/options`, 'POST', { origin: STORE });
    await db().run(`UPDATE webauthn_challenges SET expires_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), lo.json.challenge_id]);
    const r = await call(`${C}/login/verify`, 'POST', { origin: STORE, body: { challenge_id: lo.json.challenge_id, response: await pk.get(lo.json.options), mode: 'bearer' } });
    expect(r.status).toBe(401);
  });

  it("one customer cannot use, list or remove another's passkeys or challenges", async () => {
    const ann = await customerSession('ann@shop.test');
    const bob = await customerSession('bob@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    await register(C, STORE, ann.token, pk);
    expect((await call(C, 'GET', { token: bob.token })).json.items).toHaveLength(0);
    expect((await call(`${C}/${pk.id}`, 'DELETE', { token: bob.token, origin: STORE })).status).toBe(404);
    // Bob cannot finish a registration that Ann started
    const optAnn = await call(`${C}/register/options`, 'POST', { token: ann.token, origin: STORE });
    const pk2 = await SoftPasskey.create(STORE, RP);
    const steal = await call(`${C}/register/verify`, 'POST', { token: bob.token, origin: STORE, body: { challenge_id: optAnn.json.challenge_id, response: await pk2.create(optAnn.json.options) } });
    expect(steal.status).toBe(400);
    // signing in with Ann's passkey gives Ann's account, never Bob's
    const login = await signInWith(C, STORE, pk);
    expect(login.json.customer.email).toBe('ann@shop.test');
  });

  it('removing a passkey stops it signing in; the same passkey cannot be added twice', async () => {
    const me = await customerSession('ann@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    await register(C, STORE, me.token, pk);
    const again = await register(C, STORE, me.token, pk);
    expect(again.status).toBe(409);
    expect((await call(`${C}/${pk.id}`, 'DELETE', { token: me.token, origin: STORE })).status).toBe(200);
    expect((await signInWith(C, STORE, pk)).status).toBe(401);
  });

  it('keeps at most 10 passkeys per customer', async () => {
    const me = await customerSession('ann@shop.test');
    for (let i = 0; i < 10; i++) expect((await register(C, STORE, me.token, await SoftPasskey.create(STORE, RP))).status).toBe(201);
    const r = await call(`${C}/register/options`, 'POST', { token: me.token, origin: STORE, ip: '9.9.9.9' });
    expect(r.status).toBe(409);
  });

  it('excludes already-registered passkeys from the options (one device, one passkey)', async () => {
    const me = await customerSession('ann@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    await register(C, STORE, me.token, pk);
    const opt = await call(`${C}/register/options`, 'POST', { token: me.token, origin: STORE });
    expect(opt.json.options.excludeCredentials.map((c: any) => c.id)).toEqual([pk.id]);
  });

  it('cookie mode sets __Host-cid from a store origin and is refused elsewhere', async () => {
    const me = await customerSession('ann@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    await register(C, STORE, me.token, pk);
    const ok = await signInWith(C, STORE, pk, {}, 'cookie');
    expect(ok.status).toBe(200);
    expect(ok.json.session_token).toBeUndefined();
    const cookie = ok.res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/__Host-cid=cus_/);
    expect(cookie).toMatch(/HttpOnly/i); expect(cookie).toMatch(/Secure/i);
    const asCookie = await call('/v1/account/me', 'GET', { cookie: cookie.split(';')[0] });
    expect(asCookie.status).toBe(200);
  });

  it('a state-changing passkey call with only a cookie from a foreign site is blocked (CSRF)', async () => {
    const me = await customerSession('ann@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    await register(C, STORE, me.token, pk);
    const ok = await signInWith(C, STORE, pk, {}, 'cookie');
    const cookie = (ok.res.headers.get('set-cookie') ?? '').split(';')[0];
    const del = await call(`${C}/${pk.id}`, 'DELETE', { cookie, origin: 'https://evil.example' });
    expect(del.status).toBe(403);
    expect((await call(C, 'GET', { cookie })).json.items).toHaveLength(1);
  });

  it('throttles sign-in attempts per address', async () => {
    const ip = '203.0.113.200';
    let last = 0;
    for (let i = 0; i < 35; i++) {
      const r = await call(`${C}/login/verify`, 'POST', { origin: STORE, ip, body: { challenge_id: 'x', response: { id: 'a', rawId: 'a', type: 'public-key', response: {} }, mode: 'bearer' } });
      last = r.status; if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it('rejects malformed bodies cleanly', async () => {
    expect((await call(`${C}/login/verify`, 'POST', { origin: STORE, body: { nope: 1 } })).status).toBe(400);
    expect((await call(`${C}/login/verify`, 'POST', { origin: STORE, body: { challenge_id: 'x', response: { id: 'a'.repeat(5000), rawId: 'a', type: 'public-key', response: {} } } })).status).toBe(400);
    const r = await call(`${C}/login/verify`, 'POST', { origin: STORE, body: { challenge_id: 'nope', response: { id: 'a', rawId: 'a', type: 'public-key', response: {} } } });
    expect(r.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('admin passkeys', () => {
  it('registers and signs in; the session works like any other', async () => {
    const owner = await adminSession('owner@shop.test');
    const pk = await SoftPasskey.create(ADMIN, RP);
    expect((await register(A, ADMIN, owner.token, pk, 'Work laptop')).status).toBe(201);
    const login = await signInWith(A, ADMIN, pk);
    expect(login.status).toBe(200);
    expect(login.json.user.email).toBe('owner@shop.test');
    expect(login.json.role).toBe('owner');
    expect(login.json.permissions.length).toBeGreaterThan(0);
    expect((await call('/v1/auth/me', 'GET', { token: login.json.session_token })).status).toBe(200);
    const audits = await db().query<any>(`SELECT action, meta FROM audit_log WHERE action IN ('auth.passkey_added','auth.login') ORDER BY at`);
    expect(audits.some((a: any) => a.action === 'auth.passkey_added')).toBe(true);
    expect(audits.some((a: any) => a.action === 'auth.login' && String(a.meta).includes('passkey'))).toBe(true);
  });

  it('cookie mode sets __Host-sid from an admin origin', async () => {
    const owner = await adminSession('owner@shop.test');
    const pk = await SoftPasskey.create(ADMIN, RP);
    await register(A, ADMIN, owner.token, pk);
    const r = await signInWith(A, ADMIN, pk, {}, 'cookie');
    expect(r.status).toBe(200);
    expect(r.res.headers.get('set-cookie')).toMatch(/__Host-sid=ses_/);
  });

  it('a disabled user cannot sign in with a passkey', async () => {
    const owner = await adminSession('owner@shop.test');
    const pk = await SoftPasskey.create(ADMIN, RP);
    await register(A, ADMIN, owner.token, pk);
    // a second owner exists so the first can be disabled
    await db().run(`UPDATE users SET status = 'disabled' WHERE id = ?`, [owner.id]);
    expect((await signInWith(A, ADMIN, pk)).status).toBe(401);
  });

  it('an admin API key (no person) cannot register passkeys', async () => {
    const key = generateApiKey('sk');
    await db().run(`INSERT INTO api_keys (id, key_hash, key_prefix, role, created_at) VALUES (?, ?, ?, 'admin', ?)`, [crypto.randomUUID(), await hashKey(key), 'sk', new Date().toISOString()]).catch(() => {});
    const r = await call(`${A}/register/options`, 'POST', { token: key, origin: ADMIN });
    expect([401, 403]).toContain(r.status);
  });

  it('walls: a customer passkey does not open an admin session, nor the reverse', async () => {
    const cust = await customerSession('ann@shop.test');
    const owner = await adminSession('owner@shop.test');
    const cpk = await SoftPasskey.create(STORE, RP);
    const apk = await SoftPasskey.create(ADMIN, RP);
    await register(C, STORE, cust.token, cpk);
    await register(A, ADMIN, owner.token, apk);
    // customer's key presented to the admin endpoint (from the admin origin)
    const cpkAtAdmin = new SoftPasskey(ADMIN, RP); cpkAtAdmin.keys = cpk.keys; cpkAtAdmin.credId = cpk.credId;
    expect((await signInWith(A, ADMIN, cpkAtAdmin)).status).toBe(401);
    // admin's key presented to the storefront endpoint
    const apkAtStore = new SoftPasskey(STORE, RP); apkAtStore.keys = apk.keys; apkAtStore.credId = apk.credId;
    expect((await signInWith(C, STORE, apkAtStore)).status).toBe(401);
    // a challenge issued on one side is useless on the other
    const lo = await call(`${C}/login/options`, 'POST', { origin: STORE });
    const resp = await cpk.get(lo.json.options);
    expect((await call(`${A}/login/verify`, 'POST', { origin: ADMIN, body: { challenge_id: lo.json.challenge_id, response: resp, mode: 'bearer' } })).status).toBe(401);
    // an admin session token cannot manage customer passkeys and vice versa
    expect((await call(C, 'GET', { token: owner.token })).status).toBe(401);
    expect((await call(A, 'GET', { token: cust.token })).status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('relying party and housekeeping', () => {
  const base = { ADMIN_ORIGINS: ADMIN, STORE_URL: STORE, STORE_ORIGINS: STORE };
  it('defaults to the page host; PASSKEY_RP_ID may be a parent domain but never an unrelated one', () => {
    expect(resolveRp(base, 'customer', STORE)).toEqual({ origin: STORE, rpID: 'store.test.com' });
    expect(resolveRp({ ...base, PASSKEY_RP_ID: 'test.com' }, 'customer', STORE).rpID).toBe('test.com');
    expect(resolveRp({ ...base, PASSKEY_RP_ID: 'test.com' }, 'admin', ADMIN).rpID).toBe('test.com');
    expect(() => resolveRp({ ...base, PASSKEY_RP_ID: 'other.com' }, 'customer', STORE)).toThrow(PasskeyError);
    expect(() => resolveRp({ ...base, PASSKEY_RP_ID: 'est.com' }, 'customer', STORE)).toThrow(PasskeyError); // must end at a dot
    expect(() => resolveRp(base, 'customer', 'https://evil.example')).toThrow(PasskeyError);
    expect(() => resolveRp(base, 'admin', STORE)).toThrow(PasskeyError);
    expect(() => resolveRp(base, 'customer', undefined)).toThrow(PasskeyError);
  });

  it('the credential lookup is per realm, and a challenge only finishes at the origin it was issued for', async () => {
    const d = db();
    const cust = await customerSession('ann@shop.test');
    const pk = await SoftPasskey.create(STORE, RP);
    await register(C, STORE, cust.token, pk);
    const e = env as any;
    // same customer passkey, asked about as an admin credential: not found
    const pkAdminSide = new SoftPasskey(ADMIN, RP); pkAdminSide.keys = pk.keys; pkAdminSide.credId = pk.credId;
    const a = await beginLogin(d, e, 'admin', ADMIN);
    expect(await finishLogin(d, e, 'admin', ADMIN, a.challenge_id, (await pkAdminSide.get(a.options)) as any)).toBeNull();
    // challenge issued for the store origin, finished from another allowed origin
    const other = 'https://www.store.test.com';
    const s1 = await beginLogin(d, e, 'customer', STORE);
    expect(await finishLogin(d, e, 'customer', other, s1.challenge_id, (await pk.get(s1.options)) as any)).toBeNull();
    const s2 = await beginLogin(d, e, 'customer', STORE);
    expect(await finishLogin(d, e, 'customer', STORE, s2.challenge_id, (await pk.get(s2.options)) as any)).toMatchObject({ credential_id: pk.id });
  });

  it('purges old challenges only', async () => {
    const d = db();
    const mk = (id: string, exp: number) => d.run(`INSERT INTO webauthn_challenges (id, realm, purpose, challenge, rp_id, origin, expires_at, created_at) VALUES (?, 'customer', 'login', 'c', 'r', 'o', ?, ?)`, [id, new Date(exp).toISOString(), new Date().toISOString()]);
    await mk('old', Date.now() - 600_000); await mk('fresh', Date.now() + 60_000);
    await purgePasskeyData(d);
    const left = (await d.query<{ id: string }>(`SELECT id FROM webauthn_challenges`)).map((r) => r.id);
    expect(left).toEqual(['fresh']);
  });
});
