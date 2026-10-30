// =============================================================================
// src/__tests__/auth-keys.test.ts
//
// API keys managed from the admin, OAuth scope enforcement, IP-keyed durable
// rate limiting, FedaPay fail-closed re-verification, encrypted provider keys.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { hashKey } from '../middleware/auth';
import { mockFetch } from './setup';
import { sha256Hex } from '../auth/crypto';
import { oauthScopeFor } from '../auth/permissions';
import { keyStatus } from '../auth/keys';
import { openConfig, sealConfig, setConfigKey, isSealed, parseConfig } from '../lib/config-secrets';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let ipCounter = 0;
const nextIp = () => `198.51.100.${(++ipCounter % 250) + 1}`;

type CallOpts = { body?: unknown; token?: string; ip?: string; headers?: Record<string, string>; raw?: string };
async function call(path: string, method: string, o: CallOpts = {}) {
  const res = await SELF.fetch(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': o.ip ?? nextIp(),
      ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
      ...o.headers,
    },
    ...(o.raw !== undefined ? { body: o.raw } : o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, json, status: res.status };
}

const SETUP = { 'X-Setup-Token': 'test-setup-token' };

async function signIn(email: string, role: 'owner' | 'agency' = 'owner') {
  const boot = await call('/v1/auth/bootstrap', 'POST', { body: { email, role }, headers: SETUP });
  const v = await call('/v1/auth/verify', 'POST', { body: { token: boot.json.token, mode: 'bearer' } });
  expect(v.status).toBe(200);
  return v.json.session_token as string;
}

async function createAndSignIn(ownerToken: string, email: string, role: 'manager' | 'staff') {
  const r = await call('/v1/auth/users', 'POST', { token: ownerToken, body: { email, role } });
  const token = decodeURIComponent(String(r.json.invite_url).split('#confirm=')[1]);
  const v = await call('/v1/auth/verify', 'POST', { body: { token, mode: 'bearer' } });
  return v.json.session_token as string;
}

beforeEach(async () => {
  const d = db();
  for (const t of ['sessions', 'login_tokens', 'identities', 'auth_throttle', 'audit_log', 'users', 'api_keys', 'oauth_tokens']) {
    await d.run(`DELETE FROM ${t}`);
  }
  await d.run(`DELETE FROM config WHERE key IN ('auth', 'email', 'stripe', 'fedapay')`);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('API keys: create, list, use, revoke', () => {
  it('creates a key, shows the secret once and stores only its hash', async () => {
    const owner = await signIn('owner@shop.test');
    const r = await call('/v1/auth/keys', 'POST', { token: owner, body: { role: 'admin', label: 'Zapier' } });
    expect(r.status).toBe(201);
    const secret: string = r.json.secret;
    expect(secret).toMatch(/^sk_[0-9a-f]{48}$/);
    expect(r.json.key.label).toBe('Zapier');
    expect(r.json.key.last4).toBe(secret.slice(-4));
    expect(r.json.key.status).toBe('active');

    const rows = await db().query<any>(`SELECT * FROM api_keys`);
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(await sha256Hex(secret));
    expect(JSON.stringify(rows[0])).not.toContain(secret);

    const list = await call('/v1/auth/keys', 'GET', { token: owner });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain(secret);
    expect(list.json.items[0].key_prefix).toBe('sk_');
  });

  it('a created admin key reaches admin routes; a public key does not', async () => {
    const owner = await signIn('owner@shop.test');
    const admin = (await call('/v1/auth/keys', 'POST', { token: owner, body: { role: 'admin' } })).json.secret;
    const pub = (await call('/v1/auth/keys', 'POST', { token: owner, body: { role: 'public' } })).json.secret;
    expect(pub).toMatch(/^pk_/);
    expect((await call('/v1/orders', 'GET', { token: admin })).status).toBe(200);
    expect((await call('/v1/orders', 'GET', { token: pub })).status).toBe(403);
  });

  it('revoking stops the key at once and is recorded in the audit log', async () => {
    const owner = await signIn('owner@shop.test');
    const k = (await call('/v1/auth/keys', 'POST', { token: owner, body: { role: 'admin' } })).json;
    expect((await call('/v1/orders', 'GET', { token: k.secret })).status).toBe(200);
    const del = await call(`/v1/auth/keys/${k.key.id}`, 'DELETE', { token: owner });
    expect(del.status).toBe(200);
    expect(del.json.key.status).toBe('revoked');
    expect((await call('/v1/orders', 'GET', { token: k.secret })).status).toBe(401);
    const audit = await call('/v1/auth/audit', 'GET', { token: owner });
    const actions = audit.json.items.map((i: any) => i.action);
    expect(actions).toContain('key.created');
    expect(actions).toContain('key.revoked');
  });

  it('rotate with no grace period replaces the key immediately', async () => {
    const owner = await signIn('owner@shop.test');
    const k = (await call('/v1/auth/keys', 'POST', { token: owner, body: { role: 'admin', label: 'CI' } })).json;
    const r = await call(`/v1/auth/keys/${k.key.id}/rotate`, 'POST', { token: owner, body: {} });
    expect(r.status).toBe(200);
    expect(r.json.key.label).toBe('CI');
    expect(r.json.old.status).toBe('revoked');
    expect((await call('/v1/orders', 'GET', { token: k.secret })).status).toBe(401);
    expect((await call('/v1/orders', 'GET', { token: r.json.secret })).status).toBe(200);
  });

  it('rotate with a grace period keeps the old key working until it expires', async () => {
    const owner = await signIn('owner@shop.test');
    const k = (await call('/v1/auth/keys', 'POST', { token: owner, body: { role: 'admin' } })).json;
    const r = await call(`/v1/auth/keys/${k.key.id}/rotate`, 'POST', { token: owner, body: { grace_hours: 24 } });
    expect(r.json.old.status).toBe('expiring');
    expect((await call('/v1/orders', 'GET', { token: k.secret })).status).toBe(200);
    expect((await call('/v1/orders', 'GET', { token: r.json.secret })).status).toBe(200);
    // time passes
    await db().run(`UPDATE api_keys SET expires_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), k.key.id]);
    expect((await call('/v1/orders', 'GET', { token: k.secret })).status).toBe(401);
    expect((await call('/v1/orders', 'GET', { token: r.json.secret })).status).toBe(200);
    // a key that is no longer active cannot be rotated again
    const again = await call(`/v1/auth/keys/${k.key.id}/rotate`, 'POST', { token: owner, body: {} });
    expect(again.status).toBe(409);
  });

  it('keys created by the original setup (no label, no extra columns) still work and are listed', async () => {
    const secret = 'sk_' + 'a'.repeat(48);
    await db().run(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES (?, ?, 'sk_', 'admin')`, [crypto.randomUUID(), await hashKey(secret)]);
    expect((await call('/v1/orders', 'GET', { token: secret })).status).toBe(200);
    const owner = await signIn('owner@shop.test');
    const list = await call('/v1/auth/keys', 'GET', { token: owner });
    expect(list.json.items).toHaveLength(1);
    expect(list.json.items[0].label).toBeNull();
    expect(list.json.items[0].status).toBe('active');
    const [row] = await db().query<any>(`SELECT last_used_at FROM api_keys`);
    expect(row.last_used_at).toBeTruthy();
  });

  it('only a signed-in owner/agency can manage keys', async () => {
    const owner = await signIn('owner@shop.test');
    const manager = await createAndSignIn(owner, 'm@shop.test', 'manager');
    const staff = await createAndSignIn(owner, 's@shop.test', 'staff');
    const adminKey = (await call('/v1/auth/keys', 'POST', { token: owner, body: { role: 'admin' } })).json.secret;
    for (const t of [manager, staff]) {
      expect((await call('/v1/auth/keys', 'GET', { token: t })).status).toBe(403);
      expect((await call('/v1/auth/keys', 'POST', { token: t, body: { role: 'admin' } })).status).toBe(403);
    }
    // an admin key cannot mint more keys (a leaked key must not be able to make itself permanent)
    expect((await call('/v1/auth/keys', 'POST', { token: adminKey, body: { role: 'admin' } })).status).toBe(403);
    expect((await call('/v1/auth/keys', 'GET', { token: adminKey })).status).toBe(403);
    expect((await call('/v1/auth/keys', 'GET', {})).status).toBe(401);
  });

  it('caps the number of active keys', async () => {
    const owner = await signIn('owner@shop.test');
    for (let i = 0; i < 20; i++) {
      await db().run(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES (?, ?, 'pk_', 'public')`, [crypto.randomUUID(), `h${i}`]);
    }
    const r = await call('/v1/auth/keys', 'POST', { token: owner, body: { role: 'public' } });
    expect(r.status).toBe(409);
  });

  it('validates input', async () => {
    const owner = await signIn('owner@shop.test');
    expect((await call('/v1/auth/keys', 'POST', { token: owner, body: { role: 'root' } })).status).toBe(400);
    expect((await call('/v1/auth/keys', 'POST', { token: owner, body: {} })).status).toBe(400);
    expect((await call('/v1/auth/keys/nope/rotate', 'POST', { token: owner, body: {} })).status).toBe(404);
    expect((await call('/v1/auth/keys/nope', 'DELETE', { token: owner })).status).toBe(404);
    const k = (await call('/v1/auth/keys', 'POST', { token: owner, body: { role: 'admin' } })).json;
    expect((await call(`/v1/auth/keys/${k.key.id}/rotate`, 'POST', { token: owner, body: { grace_hours: 99999 } })).status).toBe(400);
  });

  it('keyStatus reads the dates', () => {
    expect(keyStatus({ revoked_at: null, expires_at: null })).toBe('active');
    expect(keyStatus({ revoked_at: '2020-01-01T00:00:00Z', expires_at: null })).toBe('revoked');
    expect(keyStatus({ revoked_at: null, expires_at: new Date(Date.now() + 5000).toISOString() })).toBe('expiring');
    expect(keyStatus({ revoked_at: null, expires_at: new Date(Date.now() - 5000).toISOString() })).toBe('expired');
  });

  it('lost admin key: the setup token re-opens an account that can issue new keys', async () => {
    const owner1 = await signIn('owner@shop.test');
    const lost = (await call('/v1/auth/keys', 'POST', { token: owner1, body: { role: 'admin' } })).json;
    await call(`/v1/auth/keys/${lost.key.id}`, 'DELETE', { token: owner1 });
    await db().run(`DELETE FROM sessions`);
    expect((await call('/v1/auth/me', 'GET', { token: owner1 })).status).toBe(401);
    const owner2 = await signIn('owner@shop.test');
    const fresh = await call('/v1/auth/keys', 'POST', { token: owner2, body: { role: 'admin' } });
    expect(fresh.status).toBe(201);
    expect((await call('/v1/orders', 'GET', { token: fresh.json.secret })).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('OAuth scopes are enforced', () => {
  async function oauthToken(scope: string) {
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const cid = crypto.randomUUID();
    await db().run(`INSERT INTO customers (id, email) VALUES (?, ?)`, [cid, `c${cid.slice(0, 6)}@x.test`]);
    await db().run(
      `INSERT INTO oauth_tokens (id, client_id, customer_id, access_token_hash, refresh_token_hash, scope, access_expires_at, refresh_expires_at)
       VALUES (?, 'agent', ?, ?, 'r', ?, ?, ?)`,
      [crypto.randomUUID(), cid, await hashKey(token), scope, new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 86400_000).toISOString()]
    );
    return token;
  }

  it('the scope map is deny-by-default', () => {
    expect(oauthScopeFor('GET', '/v1/products')).toBe('');
    expect(oauthScopeFor('POST', '/v1/products')).toBeNull();
    expect(oauthScopeFor('POST', '/v1/carts/abc/items')).toBe('ucp:scopes:checkout_session');
    expect(oauthScopeFor('GET', '/v1/orders/1')).toBe('ucp:scopes:order');
    expect(oauthScopeFor('POST', '/v1/orders/1/refund')).toBeNull();
    expect(oauthScopeFor('GET', '/v1/customers')).toBeNull();
    expect(oauthScopeFor('GET', '/v1/auth/users')).toBeNull();
    expect(oauthScopeFor('GET', '/v1/setup/email')).toBeNull();
  });

  it('a token without the needed scope is refused, with the scope named', async () => {
    const t = await oauthToken('openid profile');
    const r = await call('/v1/orders', 'GET', { token: t });
    expect(r.status).toBe(403);
    expect(r.json.error.message).toContain('ucp:scopes:order');
    const c = await call('/v1/carts/abc', 'GET', { token: t });
    expect(c.status).toBe(403);
    expect(c.json.error.message).toContain('ucp:scopes:checkout_session');
  });

  it('routes outside the map are closed to OAuth tokens even with every scope', async () => {
    const t = await oauthToken('ucp:scopes:checkout_session ucp:scopes:order ucp:scopes:identity');
    for (const [m, p] of [['GET', '/v1/customers'], ['GET', '/v1/discounts'], ['POST', '/v1/products'], ['GET', '/v1/submissions'], ['GET', '/v1/auth/keys']] as const) {
      const r = await call(p, m, { token: t });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json.error.message, `${m} ${p}`).toContain('not available to OAuth');
    }
  });

  it('a token with the scope passes the scope check (the route’s own admin check still applies)', async () => {
    const t = await oauthToken('ucp:scopes:order');
    const r = await call('/v1/orders', 'GET', { token: t });
    expect(r.status).toBe(403);
    expect(r.json.error.message).toBe('Admin access required');
    expect((await call('/v1/products', 'GET', { token: t })).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('rate limiting', () => {
  it('cannot be dodged by sending a different token each time', async () => {
    const ip = '192.0.2.77';
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) {
      const r = await call('/v1/submissions', 'POST', { token: `pk_${i}${'0'.repeat(46)}`, ip, body: { x: 1 } });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  });

  it('is counted per client, not for the whole shop', async () => {
    for (let i = 0; i < 11; i++) await call('/v1/submissions', 'POST', { ip: '192.0.2.88', body: {} });
    const blocked = await call('/v1/submissions', 'POST', { ip: '192.0.2.88', body: {} });
    expect(blocked.status).toBe(429);
    expect(blocked.res.headers.get('Retry-After')).toBeTruthy();
    const other = await call('/v1/submissions', 'POST', { ip: '192.0.2.89', body: {} });
    expect(other.status).not.toBe(429);
  });

  it('the durable counter lives in the database (survives isolates)', async () => {
    const ip = '192.0.2.90';
    for (let i = 0; i < 3; i++) await call('/v1/submissions', 'POST', { ip, body: {} });
    const [row] = await db().query<any>(`SELECT count FROM auth_throttle WHERE key = ?`, [`rl:/v1/submissions:${ip}`]);
    expect(row.count).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FedaPay re-verification fails closed', () => {
  async function sendApproved(txId: number) {
    const secret = 'whsec_test';
    await db().run(
      `INSERT INTO config (key, value) VALUES ('fedapay', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify({ secret_key: 'sk_sandbox_x', webhook_secret: secret, sandbox: true })]
    );
    await db().run(`DELETE FROM events WHERE stripe_event_id LIKE 'fedapay_evt_%'`);
    await db().run(`INSERT OR IGNORE INTO fedapay_transactions (transaction_id, cart_id) VALUES (?, ?)`, [txId, 'cart-failclosed']);
    const body = JSON.stringify({ name: 'transaction.approved', entity: { id: txId, custom_metadata: { cart_id: 'cart-failclosed' } } });
    const t = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)));
    const sig = `t=${t},s=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    return call('/v1/webhooks/fedapay', 'POST', { raw: body, headers: { 'x-fedapay-signature': sig } });
  }
  const events = () => db().query<any>(`SELECT * FROM events WHERE stripe_event_id LIKE 'fedapay_evt_%'`);

  it('asks FedaPay to retry (503) and records nothing when the confirmation call fails', async () => {
    const restore = mockFetch(async () => new Response('boom', { status: 500 }));
    try {
      const r = await sendApproved(9001);
      expect(r.status).toBe(503);
      expect(await events()).toHaveLength(0);
    } finally { restore(); }
  });

  it('asks for a retry when FedaPay cannot be reached at all', async () => {
    const restore = mockFetch(async () => { throw new Error('network down'); });
    try {
      const r = await sendApproved(9002);
      expect(r.status).toBe(503);
      expect(await events()).toHaveLength(0);
    } finally { restore(); }
  });

  it('records the event but creates nothing when FedaPay says the transaction is not approved', async () => {
    const restore = mockFetch(async () => new Response(JSON.stringify({ 'v1/transaction': { id: 9003, status: 'pending' } }), { status: 200 }));
    try {
      const r = await sendApproved(9003);
      expect(r.status).toBe(200);
      expect(await events()).toHaveLength(1);
    } finally { restore(); }
  });

  it('proceeds when FedaPay confirms approval', async () => {
    const restore = mockFetch(async () => new Response(JSON.stringify({ 'v1/transaction': { id: 9004, status: 'approved' } }), { status: 200 }));
    try {
      const r = await sendApproved(9004);
      expect(r.status).toBe(200);
      expect(await events()).toHaveLength(1);
    } finally { restore(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('provider keys are encrypted at rest', () => {
  it('round-trips, binds the ciphertext to its row and detects tampering', async () => {
    setConfigKey('unit-test-secret-unit-test-secret');
    const json = JSON.stringify({ secret_key: 'sk_live_abc' });
    const sealed = await sealConfig('stripe', json);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('sk_live_abc');
    expect(await openConfig('stripe', sealed)).toBe(json);
    await expect(openConfig('email', sealed)).rejects.toThrow(/could not be decrypted/);
    const [iv, ct] = sealed.slice('enc:v1:'.length).split(':');
    const flipped = `enc:v1:${iv}:${ct.slice(0, -2)}${ct.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect(openConfig('stripe', flipped)).rejects.toThrow();
    // two seals of the same value differ (random IV)
    expect(await sealConfig('stripe', json)).not.toBe(sealed);
    // another secret cannot read it
    setConfigKey('a-different-secret-a-different-secret');
    await expect(openConfig('stripe', sealed)).rejects.toThrow();
    setConfigKey(env.CONFIG_ENCRYPTION_KEY);
  });

  it('is a no-op without a key, and a sealed row without the key is an error, not garbage', async () => {
    setConfigKey(undefined);
    expect(await sealConfig('stripe', '{"a":1}')).toBe('{"a":1}');
    expect(await parseConfig('stripe', '{"a":1}')).toEqual({ a: 1 });
    setConfigKey('k-k-k-k-k-k-k-k-k-k-k-k-k-k-k-k');
    const sealed = await sealConfig('stripe', '{"a":1}');
    setConfigKey(undefined);
    await expect(openConfig('stripe', sealed)).rejects.toThrow(/CONFIG_ENCRYPTION_KEY is not set/);
    setConfigKey(env.CONFIG_ENCRYPTION_KEY);
  });

  it('Setup routes store encrypted values and still read them back', async () => {
    const owner = await signIn('owner@shop.test');
    const restore = mockFetch(async () => new Response('{}', { status: 200 }));
    try {
      const r = await call('/v1/setup/fedapay', 'POST', { token: owner, body: { secret_key: 'sk_sandbox_zzz', webhook_secret: 'wh_zzz', sandbox: true } });
      expect(r.status).toBe(200);
    } finally { restore(); }
    const [row] = await db().query<any>(`SELECT value FROM config WHERE key = 'fedapay'`);
    expect(isSealed(row.value)).toBe(true);
    expect(row.value).not.toContain('sk_sandbox_zzz');
    const status = await call('/v1/setup/fedapay', 'GET', { token: owner });
    expect(status.json).toMatchObject({ configured: true, sandbox: true, has_secret_key: true, has_webhook_secret: true });
  });

  it('existing plain rows keep working and can be sealed in one go', async () => {
    const owner = await signIn('owner@shop.test');
    await db().run(`INSERT INTO config (key, value) VALUES ('fedapay', ?)`, [JSON.stringify({ secret_key: 'sk_old', webhook_secret: 'w', sandbox: false })]);
    expect((await call('/v1/setup/fedapay', 'GET', { token: owner })).json.configured).toBe(true);

    const before = await call('/v1/auth/setup-status', 'GET', { token: owner });
    expect(before.json.encryption).toEqual({ enabled: true, plain_rows: ['fedapay'] });

    const sealed = await call('/v1/auth/secrets/seal', 'POST', { token: owner });
    expect(sealed.json.sealed).toEqual(['fedapay']);
    const [row] = await db().query<any>(`SELECT value FROM config WHERE key = 'fedapay'`);
    expect(isSealed(row.value)).toBe(true);
    expect((await call('/v1/setup/fedapay', 'GET', { token: owner })).json.has_secret_key).toBe(true);
    expect((await call('/v1/auth/setup-status', 'GET', { token: owner })).json.encryption.plain_rows).toEqual([]);
    expect((await call('/v1/auth/secrets/seal', 'POST', { token: owner })).json.sealed).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('setup status', () => {
  it('summarises what is configured, without secrets', async () => {
    const owner = await signIn('owner@shop.test');
    await call('/v1/auth/keys', 'POST', { token: owner, body: { role: 'public', label: 'Storefront' } });
    const r = await call('/v1/auth/setup-status', 'GET', { token: owner });
    expect(r.status).toBe(200);
    expect(r.json.owner_exists).toBe(true);
    expect(r.json.email.configured).toBe(false);
    expect(r.json.environment).toMatchObject({ setup_token: true, password_pepper: true, admin_origins: true, cookie_ready: true });
    expect(r.json.keys).toEqual({ admin: 0, public: 1, legacy: 0 });
    const manager = await createAndSignIn(owner, 'm@shop.test', 'manager');
    expect((await call('/v1/auth/setup-status', 'GET', { token: manager })).status).toBe(403);
  });
});
