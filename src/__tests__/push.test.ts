// =============================================================================
// Push notifications for the installed admin app. The encryption is checked by decrypting what
// would leave the server with the subscriber's own private key, exactly as a browser does.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, mockFetch } from './setup';
import { notifyAdmins, resetPushCache, unb64u, isPushEndpoint } from '../lib/push';
import { roleCanRequest } from '../auth/permissions';

const stub = () => env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any;
const db = () => getDb(stub());
let ip = 0; let adminKey = ''; let publicKey = ''; let pushed: { url: string; init: RequestInit }[] = []; let restore: () => void; let respond = 201;
const b64u = (b: ArrayBuffer | Uint8Array) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const SETUP = { 'X-Setup-Token': 'test-setup-token' };

async function call(path: string, o: { method?: string; json?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  return SELF.fetch(`http://localhost${path}`, {
    method: o.method ?? (o.json !== undefined ? 'POST' : 'GET'),
    headers: { ...(o.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), 'CF-Connecting-IP': `198.51.106.${(++ip % 250) + 1}`, ...(o.headers ?? {}) },
    ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}),
  });
}
const j = async (r: Response) => r.json() as Promise<any>;

async function signIn(email: string, role: 'owner' | 'agency' = 'owner') {
  const boot = await j(await call('/v1/auth/bootstrap', { json: { email, role }, headers: SETUP }));
  const v = await j(await call('/v1/auth/verify', { json: { token: boot.token, mode: 'bearer' } }));
  return { token: v.session_token as string, id: v.user.id as string };
}
async function addUser(ownerToken: string, email: string, role: 'manager' | 'staff') {
  const r = await j(await call('/v1/auth/users', { token: ownerToken, json: { email, role } }));
  const token = decodeURIComponent(String(r.invite_url).split('#confirm=')[1]);
  const v = await j(await call('/v1/auth/verify', { json: { token, mode: 'bearer' } }));
  return { token: v.session_token as string, id: r.user.id as string };
}

/** A browser's side of a push subscription: its own key pair and auth secret. */
async function device(name = 'a') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, pub, auth, endpoint: `https://fcm.googleapis.com/fcm/send/${name}-${Math.random().toString(36).slice(2)}`, body: () => ({ p256dh: b64u(pub), auth: b64u(auth) }) };
}
type Device = Awaited<ReturnType<typeof device>>;
const subscribe = (token: string, d: Device, locale: 'fr' | 'en' = 'fr') => call('/v1/push/subscribe', { token, json: { endpoint: d.endpoint, keys: d.body(), locale } });

const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']), n * 8));
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
/** What a browser does with a push body (RFC 8291 section 3.4). */
async function decrypt(d: Device, body: Uint8Array): Promise<any> {
  const salt = body.slice(0, 16); const idlen = body[20]; const asPub = body.slice(21, 21 + idlen); const ct = body.slice(21 + idlen);
  expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096); expect(idlen).toBe(65);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: await crypto.subtle.importKey('raw', asPub as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, d.pair.privateKey, 256));
  const prk = await hkdf(d.auth, shared, cat(new TextEncoder().encode('WebPush: info\0'), d.pub, asPub), 32);
  const cek = await hkdf(salt, prk, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt']), ct as BufferSource));
  expect(plain[plain.length - 1]).toBe(2);   // last-record padding delimiter
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}
const bodyOf = (p: { init: RequestInit }) => new Uint8Array(p.init.body as ArrayBuffer | Uint8Array);
const to = (d: Device) => pushed.filter((p) => p.url === d.endpoint);
const settle = async () => { await new Promise((r) => setTimeout(r, 150)); };
const fakeCtx = () => { const ps: Promise<unknown>[] = []; return { ctx: { waitUntil: (p: Promise<unknown>) => { ps.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext, done: () => Promise.allSettled(ps) }; };

beforeEach(async () => {
  const d = db();
  resetPushCache();
  await d.run(`DROP TABLE IF EXISTS push_subscriptions`);
  for (const t of ['sessions', 'login_tokens', 'identities', 'auth_throttle', 'users', 'api_keys', 'submissions']) await d.run(`DELETE FROM ${t}`);
  await d.run(`DELETE FROM config WHERE key IN ('auth', 'email', 'vapid', 'push_subject')`);
  const k = await seedApiKeys(d); adminKey = k.adminKey; publicKey = (k as any).publicKey;
  pushed = []; respond = 201;
  restore = mockFetch((url, init) => {
    if (url.includes('fcm.googleapis.com') || url.includes('push.services.mozilla.com')) { pushed.push({ url, init: init ?? {} }); return new Response(null, { status: respond }); }
    return new Response('{}', { status: 200 });
  });
});
afterEach(async () => { await settle(); restore(); });

describe('push: subscribing', () => {
  it('gives the public key to a signed-in person, and never to an API key or a stranger', async () => {
    const o = await signIn('owner@shop.test');
    const r = await j(await call('/v1/push/key', { token: o.token }));
    expect(unb64u(r.public_key)).toHaveLength(65);
    expect((await j(await call('/v1/push/key', { token: o.token }))).public_key).toBe(r.public_key);   // stable
    expect((await call('/v1/push/key', { token: adminKey })).status).toBe(403);
    expect((await call('/v1/push/key', { token: publicKey })).status).toBe(403);
    expect((await call('/v1/push/key')).status).toBe(401);
  });

  it('is open to every role (it only concerns the person’s own devices)', () => {
    for (const role of ['owner', 'manager', 'staff', 'agency'] as const) expect(roleCanRequest(role, 'POST', '/v1/push/subscribe').ok).toBe(true);
  });

  it('only accepts real browser push services', async () => {
    const o = await signIn('owner@shop.test'); const d = await device();
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://169.254.169.254/latest', 'https://fcm.googleapis.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x', 'not a url']) {
      expect((await call('/v1/push/subscribe', { token: o.token, json: { endpoint, keys: d.body() } })).status).toBe(400);
    }
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isPushEndpoint('https://wns2-par02p.notify.windows.com/?token=x')).toBe(true);
  });

  it('rejects malformed keys', async () => {
    const o = await signIn('owner@shop.test'); const d = await device();
    expect((await call('/v1/push/subscribe', { token: o.token, json: { endpoint: d.endpoint, keys: { p256dh: 'x'.repeat(90), auth: d.body().auth } } })).status).toBe(400);
    expect((await call('/v1/push/subscribe', { token: o.token, json: { endpoint: d.endpoint, keys: { p256dh: d.body().p256dh, auth: 'short' } } })).status).toBe(400);
    expect((await call('/v1/push/subscribe', { token: o.token, json: { endpoint: d.endpoint } })).status).toBe(400);
  });

  it('keeps one row per device, hands a device to the latest person, and unsubscribes', async () => {
    const o = await signIn('owner@shop.test'); const m = await addUser(o.token, 'mgr@shop.test', 'manager'); const d = await device();
    expect((await subscribe(o.token, d)).status).toBe(201);
    expect((await subscribe(o.token, d, 'en')).status).toBe(201);
    expect(await db().query(`SELECT locale FROM push_subscriptions`)).toEqual([{ locale: 'en' }]);
    expect((await subscribe(m.token, d)).status).toBe(201);
    expect(await db().query(`SELECT user_id FROM push_subscriptions`)).toEqual([{ user_id: m.id }]);
    // the previous owner cannot remove it any more; the current one can
    await call('/v1/push/subscribe', { token: o.token, method: 'DELETE', json: { endpoint: d.endpoint } });
    expect(await db().query(`SELECT 1 FROM push_subscriptions`)).toHaveLength(1);
    await call('/v1/push/subscribe', { token: m.token, method: 'DELETE', json: { endpoint: d.endpoint } });
    expect(await db().query(`SELECT 1 FROM push_subscriptions`)).toHaveLength(0);
  });
});

describe('push: what is sent', () => {
  it('sends an encrypted message only the subscriber can read, signed with the shop’s key', async () => {
    const o = await signIn('owner@shop.test'); const d = await device(); await subscribe(o.token, d, 'en');
    const r = await j(await call('/v1/push/test', { token: o.token, json: {} }));
    expect(r).toEqual({ devices: 1, sent: 1 });
    const p = to(d)[0]; const h = p.init.headers as Record<string, string>;
    expect(h['Content-Encoding']).toBe('aes128gcm'); expect(h.TTL).toBe('86400'); expect(h.Urgency).toBe('high');
    const msg = await decrypt(d, bodyOf(p));
    expect(msg).toMatchObject({ title: 'Notifications are on', url: '/#orders' });
    // the VAPID token verifies against the public key the browser subscribed with
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h.Authorization)!;
    expect(m).toBeTruthy();
    const key = (await j(await call('/v1/push/key', { token: o.token }))).public_key;
    expect(m[4]).toBe(key);
    const pub = await crypto.subtle.importKey('raw', unb64u(key) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(m[3]) as BufferSource, new TextEncoder().encode(`${m[1]}.${m[2]}`))).toBe(true);
    const claims = JSON.parse(new TextDecoder().decode(unb64u(m[2])));
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000); expect(claims.exp).toBeLessThanOrEqual(Date.now() / 1000 + 12 * 3600 + 5);
    expect(claims.sub).toMatch(/^(https:\/\/|mailto:)/);
  });

  it('uses a fresh salt and key for every message', async () => {
    const o = await signIn('owner@shop.test'); const d = await device(); await subscribe(o.token, d);
    await call('/v1/push/test', { token: o.token, json: {} }); await call('/v1/push/test', { token: o.token, json: {} });
    const [a, b] = to(d).map(bodyOf);
    expect(b64u(a.slice(0, 16))).not.toBe(b64u(b.slice(0, 16)));
    expect(b64u(a.slice(21, 86))).not.toBe(b64u(b.slice(21, 86)));
  });

  it('refuses a test when no device is subscribed', async () => {
    const o = await signIn('owner@shop.test');
    expect((await call('/v1/push/test', { token: o.token, json: {} })).status).toBe(400);
  });

  it('forgets a device the push service says is gone (410), keeps one that merely failed (500)', async () => {
    const o = await signIn('owner@shop.test'); const d = await device(); await subscribe(o.token, d);
    respond = 500; await call('/v1/push/test', { token: o.token, json: {} });
    expect(await db().query(`SELECT fail_count FROM push_subscriptions`)).toEqual([{ fail_count: 1 }]);
    respond = 410; await call('/v1/push/test', { token: o.token, json: {} });
    expect(await db().query(`SELECT 1 FROM push_subscriptions`)).toHaveLength(0);
  });

  it('never calls an address that is not a push service, even if one got into the table', async () => {
    const o = await signIn('owner@shop.test'); await subscribe(o.token, await device());
    await db().run(`UPDATE push_subscriptions SET endpoint = 'https://169.254.169.254/steal'`);
    await call('/v1/push/test', { token: o.token, json: {} });
    expect(pushed).toHaveLength(0);
    expect(await db().query(`SELECT 1 FROM push_subscriptions`)).toHaveLength(0);
  });
});

describe('push: who is told about what', () => {
  it('an order reaches owner and manager (in their language) with only its number and total', async () => {
    const o = await signIn('owner@shop.test'); const m = await addUser(o.token, 'mgr@shop.test', 'manager');
    const d1 = await device('o'); const d2 = await device('m'); await subscribe(o.token, d1, 'fr'); await subscribe(m.token, d2, 'en');
    const { ctx, done } = fakeCtx();
    notifyAdmins(stub(), ctx, { kind: 'order', number: 'ORD-1', total_cents: 450000, currency: 'XOF', cod: false });
    await done();
    const fr = await decrypt(d1, bodyOf(to(d1)[0])); const en = await decrypt(d2, bodyOf(to(d2)[0]));
    expect(fr.title).toBe('Nouvelle commande payée'); expect(fr.body).toContain('ORD-1'); expect(fr.body.replace(/\s/g, ' ')).toMatch(/450\s?000/);
    expect(en.title).toBe('New paid order'); expect(en.url).toBe('/#orders');
    expect(JSON.stringify([fr, en])).not.toMatch(/@|address|email/i);
  });

  it('a low-stock alert reaches everyone who may see inventory, in their language', async () => {
    const o = await signIn('owner@shop.test'); const d = await device(); await subscribe(o.token, d, 'en');
    const { ctx, done } = fakeCtx();
    notifyAdmins(stub(), ctx, { kind: 'stock', count: 3, first: 'Savon (2)' });
    await done();
    const msg = await decrypt(d, bodyOf(to(d)[0]));
    expect(msg.title).toBe('Low stock'); expect(msg.body).toBe('Savon (2) and 2 more'); expect(msg.url).toBe('/#inventory');
  });

  it('an order awaiting payment (pay on delivery) says so', async () => {
    const o = await signIn('owner@shop.test'); const d = await device(); await subscribe(o.token, d, 'en');
    const { ctx, done } = fakeCtx();
    notifyAdmins(stub(), ctx, { kind: 'order', number: 'ORD-2', total_cents: 1000, currency: 'EUR', cod: true, needs_review: true });
    await done();
    const msg = await decrypt(d, bodyOf(to(d)[0]));
    expect(msg.title).toBe('New order (payment pending)'); expect(msg.body).toContain('to review');
  });

  it('staff are not told about what their role cannot open; disabled people are never told', async () => {
    const o = await signIn('owner@shop.test'); const s = await addUser(o.token, 'staff@shop.test', 'staff'); const x = await addUser(o.token, 'gone@shop.test', 'manager');
    const dO = await device('o'); const dS = await device('s'); const dX = await device('x');
    await subscribe(o.token, dO); await subscribe(s.token, dS); await subscribe(x.token, dX);
    await db().run(`UPDATE users SET status = 'disabled' WHERE id = ?`, [x.id]);
    await db().run(`UPDATE users SET role = 'staff' WHERE id = ?`, [s.id]);
    const { ctx, done } = fakeCtx();
    notifyAdmins(stub(), ctx, { kind: 'order', number: 'ORD-3', total_cents: 1, currency: 'XOF', cod: false });
    await done();
    expect(to(dO)).toHaveLength(1);
    expect(to(dX)).toHaveLength(0);
    expect(to(dS)).toHaveLength(1);   // staff can open orders
  });

  it('a contact message reaches everyone who can open messages (all roles today)', async () => {
    const o = await signIn('owner@shop.test'); const s = await addUser(o.token, 'staff@shop.test', 'staff');
    const dO = await device('o'); const dS = await device('s'); await subscribe(o.token, dO); await subscribe(s.token, dS);
    expect(roleCanRequest('staff', 'GET', '/v1/submissions').ok).toBe(true);
    const { ctx, done } = fakeCtx();
    notifyAdmins(stub(), ctx, { kind: 'message', form: 'contact' });
    await done();
    expect(to(dO)).toHaveLength(1); expect(to(dS)).toHaveLength(1);
  });

  it('a message sent through the shop’s contact form notifies the owner', async () => {
    const o = await signIn('owner@shop.test'); const d = await device(); await subscribe(o.token, d, 'fr');
    const r = await call('/v1/submissions', { token: publicKey, json: { form: 'contact', name: 'Ama', email: 'ama@shop.test', message: 'Bonjour, une question sur le miel.' } });
    expect(r.status).toBe(201);
    await settle();
    const msg = await decrypt(d, bodyOf(to(d)[0]));
    expect(msg).toMatchObject({ title: 'Nouveau message', url: '/#messages' });
    expect(JSON.stringify(msg)).not.toContain('miel'); expect(JSON.stringify(msg)).not.toContain('Ama');
  });

  it('a failure in the push service never breaks the caller', async () => {
    const o = await signIn('owner@shop.test'); await subscribe(o.token, await device());
    restore(); restore = mockFetch(() => { throw new Error('network down'); });
    const { ctx, done } = fakeCtx();
    expect(() => notifyAdmins(stub(), ctx, { kind: 'order', number: 'ORD-4', total_cents: 1, currency: 'XOF', cod: false })).not.toThrow();
    await expect(done()).resolves.toBeDefined();
  });
});
