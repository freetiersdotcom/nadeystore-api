// =============================================================================
// Web Push for the admin app (installable PWA): a phone buzzes when an order or a message arrives.
// Standards only, built on WebCrypto so it runs on Workers: VAPID (RFC 8292) + aes128gcm (RFC 8291/8188).
// The payload is a short title + order number + total; no customer details are sent through the push service.
// =============================================================================
import type { Database } from '../db';
import { getDb } from '../db';
import { roleCan, isRole, type Permission } from '../auth/permissions';
import { openConfig, sealConfig } from './config-secrets';
import { uuid, now, type DOStub, type Env } from '../types';

const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ''; for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s: string): Uint8Array => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
};
const concat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

/** Only the browsers' own push services may be called: a signed-in user must not be able to aim the server at an arbitrary URL. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/];
export function isPushEndpoint(endpoint: string): boolean {
  try { const u = new URL(endpoint); return u.protocol === 'https:' && !u.username && !u.password && PUSH_HOSTS.some((r) => r.test(u.hostname)); } catch { return false; }
}

let ready = false;
export async function ensurePushTables(db: Database): Promise<void> {
  if (ready) return;
  await db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'fr', created_at TEXT NOT NULL, last_ok_at TEXT, fail_count INTEGER NOT NULL DEFAULT 0)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)`);
  ready = true;
}
/** Tests wipe tables between runs. */
export function resetPushCache() { ready = false; }

type Vapid = { publicKey: string; privateJwk: JsonWebKey };

/** The shop's VAPID key pair: created on first use and kept in the config table (encrypted when CONFIG_ENCRYPTION_KEY is set). */
export async function getVapid(db: Database): Promise<Vapid> {
  const [row] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'vapid'`);
  if (row?.value) return JSON.parse(await openConfig('vapid', row.value)) as Vapid;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const v: Vapid = { publicKey: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
  await db.run(`INSERT INTO config (key, value) VALUES ('vapid', ?) ON CONFLICT(key) DO NOTHING`, [await sealConfig('vapid', JSON.stringify(v))]);
  const [again] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'vapid'`);
  return JSON.parse(await openConfig('vapid', again.value)) as Vapid;
}

async function vapidHeader(v: Vapid, endpoint: string, subject: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, k, bytes * 8));
}

/** RFC 8291 message encryption for one subscription. Exported for tests. */
export async function encryptPayload(plain: Uint8Array, p256dh: string, authSecret: string): Promise<Uint8Array> {
  const ua = unb64u(p256dh); const auth = unb64u(authSecret);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const prk = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aes, concat(plain, new Uint8Array([2])) as BufferSource));
  const rs = new Uint8Array([0, 0, 0x10, 0]);   // record size 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

export type PushMessage = { title: string; body: string; url: string; tag?: string };
type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; locale: string };

/** The contact the push services see in the VAPID token: the admin's https address, remembered when a device subscribes. */
export const subjectFor = (env: Pick<Env, 'ADMIN_URL' | 'ADMIN_ORIGINS'>) => {
  const u = env.ADMIN_URL || (env.ADMIN_ORIGINS ?? '').split(',')[0]?.trim() || '';
  return /^https:\/\//.test(u) ? u : 'mailto:admin@example.com';
};
export async function rememberSubject(db: Database, env: Pick<Env, 'ADMIN_URL' | 'ADMIN_ORIGINS'>) {
  await db.run(`INSERT INTO config (key, value) VALUES ('push_subject', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [subjectFor(env)]);
}

/** Send one message; a subscription the push service says is gone (404/410) is deleted. Returns true when accepted. */
export async function sendPush(db: Database, v: Vapid, subject: string, sub: Sub, msg: PushMessage): Promise<boolean> {
  if (!isPushEndpoint(sub.endpoint)) { await db.run(`DELETE FROM push_subscriptions WHERE id = ?`, [sub.id]); return false; }
  try {
    const body = await encryptPayload(enc.encode(JSON.stringify(msg)), sub.p256dh, sub.auth);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: await vapidHeader(v, sub.endpoint, subject) },
      body: body as BodyInit,
    });
    if (res.status === 404 || res.status === 410) { await db.run(`DELETE FROM push_subscriptions WHERE id = ?`, [sub.id]); return false; }
    if (res.ok) { await db.run(`UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE id = ?`, [now(), sub.id]); return true; }
    await db.run(`UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?`, [sub.id]);
    // A subscription that keeps failing is dropped; the person can switch notifications on again.
    await db.run(`DELETE FROM push_subscriptions WHERE id = ? AND fail_count >= 10`, [sub.id]);
    return false;
  } catch { return false; }
}

const money = (cents: number, currency: string, lang: 'fr' | 'en') => {
  const zero = ['XOF', 'GNF', 'JPY', 'KRW', 'VND'].includes(currency.toUpperCase());
  try { return new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'fr-FR', { style: 'currency', currency, minimumFractionDigits: zero ? 0 : 2, maximumFractionDigits: zero ? 0 : 2 }).format(zero ? cents : cents / 100); }
  catch { return `${zero ? cents : cents / 100} ${currency}`; }
};

export type PushEvent =
  | { kind: 'order'; number: string; total_cents: number; currency: string; cod: boolean; needs_review?: boolean }
  | { kind: 'message'; form?: string }
  | { kind: 'stock'; count: number; first: string };

function messageFor(e: PushEvent, lang: 'fr' | 'en'): PushMessage {
  if (e.kind === 'order') {
    const total = money(e.total_cents, e.currency, lang);
    const title = lang === 'en' ? (e.cod ? 'New order (payment pending)' : 'New paid order') : (e.cod ? 'Nouvelle commande (paiement à venir)' : 'Nouvelle commande payée');
    return { title, body: `${e.number} · ${total}${e.needs_review ? (lang === 'en' ? ' · to review' : ' · à vérifier') : ''}`, url: '/#orders', tag: `order-${e.number}` };
  }
  if (e.kind === 'stock') {
    const more = e.count > 1 ? (lang === 'en' ? ` and ${e.count - 1} more` : ` et ${e.count - 1} autre(s)`) : '';
    return { title: lang === 'en' ? 'Low stock' : 'Stock bas', body: `${e.first}${more}`, url: '/#inventory', tag: 'stock' };
  }
  return { title: lang === 'en' ? 'New message' : 'Nouveau message', body: lang === 'en' ? 'Someone wrote to you through the shop.' : 'Quelqu’un vous a écrit depuis la boutique.', url: '/#messages', tag: 'message' };
}

/** Send a notification to every subscribed person who may see this kind of thing (awaitable: for cron jobs). */
export async function pushAdmins(db: Database, e: PushEvent): Promise<void> {
  await ensurePushTables(db);
  const subs = await db.query<Sub & { role: string }>(
    `SELECT s.*, u.role FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.status = 'active'`
  );
  const need: Permission = e.kind === 'order' ? 'orders.read' : e.kind === 'stock' ? 'inventory.read' : 'messages.read';
  const targets = subs.filter((s) => isRole(s.role) && roleCan(s.role, need));
  if (!targets.length) return;
  const v = await getVapid(db);
  const [sj] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'push_subject'`); const subject = sj?.value || 'mailto:admin@example.com';
  await Promise.allSettled(targets.map((s) => sendPush(db, v, subject, s, messageFor(e, s.locale === 'en' ? 'en' : 'fr'))));
}

/** Tell every subscribed person who may see this kind of thing. Never throws and never delays the caller (runs after the response). */
export function notifyAdmins(stub: DOStub, ctx: ExecutionContext, e: PushEvent): void {
  const work = pushAdmins(getDb(stub), e).catch((err) => console.error('[push] failed', err));
  try { ctx.waitUntil(work); } catch { /* no execution context (tests calling directly) */ }
}

export { uuid };
