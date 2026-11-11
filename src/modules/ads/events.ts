// Server-side conversion events (Meta Conversions API, TikTok Events API) for orders that arrived through a campaign.
//
// Why: browsers block pixels (ad blockers, Safari), so ad platforms miss sales. Sending the paid order from the server
// as well fixes that; the SAME event id (the order id) in the browser and here lets the platform count it once.
//
// Privacy rules built in:
//  - only orders whose visitor accepted measurement cookies (they have an ad_attribution row) are ever sent;
//  - email and phone are hashed (SHA-256) before leaving; nothing else personal is sent;
//  - the visitor's IP and browser string kept for matching are erased once the order is delivered to every platform;
//  - nothing is sent unless a platform has BOTH a pixel id and an access token.
import type { Database } from '../../db';
import { openConfig, sealConfig } from '../../lib/config-secrets';
import { minorFactor } from '../../lib/currency';
import { now } from '../../types';

export type Platform = 'meta' | 'tiktok';
export type PlatformSettings = { pixel_id: string; access_token: string; test_code: string };
export type PixelSettings = Record<Platform, PlatformSettings>;
const empty = (): PlatformSettings => ({ pixel_id: '', access_token: '', test_code: '' });
const KEY = 'ads_pixels';
const MAX_TRIES = 5;
const MAX_AGE_DAYS = 7; // both platforms refuse older events

export async function getPixelSettings(db: Database): Promise<PixelSettings> {
  const [r] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = ?`, [KEY]);
  const out: PixelSettings = { meta: empty(), tiktok: empty() };
  if (!r?.value) return out;
  try {
    const j = JSON.parse(await openConfig(KEY, r.value));
    for (const p of ['meta', 'tiktok'] as const) for (const k of ['pixel_id', 'access_token', 'test_code'] as const) out[p][k] = typeof j?.[p]?.[k] === 'string' ? j[p][k].trim() : '';
  } catch { /* undecryptable or corrupt: behave as not configured */ }
  return out;
}

export async function savePixelSettings(db: Database, s: PixelSettings): Promise<void> {
  await db.run(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [KEY, await sealConfig(KEY, JSON.stringify(s))]);
}

export const ready = (p: PlatformSettings) => !!p.pixel_id && !!p.access_token;

// ── hashing ────────────────────────────────────────────────────────────────
export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const normEmail = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();
/** Digits only, with country code (Meta). TikTok wants the same number with a leading "+". Returns '' when it does not look like a number. */
export function normPhone(p: string | null | undefined): string {
  const d = (p ?? '').replace(/[^\d]/g, '');
  return d.length >= 8 && d.length <= 15 ? d : '';
}

// ── payloads (pure; the only place that knows each platform's format) ─────────
export type EventCtx = {
  orderId: string; currency: string; totalCents: number; paidAtMs: number; items: Array<{ sku: string; qty: number; unit_price_cents: number }>;
  email: string; phone: string; ip: string; ua: string; fbp: string; ttp: string; clickIdType: string; clickId: string; clickAtMs: number; url: string; referrer: string;
};
const major = (cents: number, currency: string) => cents / minorFactor(currency);
const compact = <T extends Record<string, any>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))) as T;

export async function metaEvent(c: EventCtx) {
  return compact({
    event_name: 'Purchase', event_time: Math.floor(c.paidAtMs / 1000), event_id: c.orderId, action_source: 'website', event_source_url: c.url,
    user_data: compact({
      em: c.email ? [await sha256(c.email)] : [], ph: c.phone ? [await sha256(c.phone)] : [],
      client_ip_address: c.ip, client_user_agent: c.ua, fbp: c.fbp,
      fbc: c.clickIdType === 'fbclid' && c.clickId ? `fb.1.${c.clickAtMs}.${c.clickId}` : '',
    }),
    custom_data: { currency: c.currency.toUpperCase(), value: major(c.totalCents, c.currency), order_id: c.orderId, content_type: 'product', content_ids: c.items.map((i) => i.sku), num_items: c.items.reduce((n, i) => n + i.qty, 0),
      contents: c.items.map((i) => ({ id: i.sku, quantity: i.qty, item_price: major(i.unit_price_cents, c.currency) })) },
  });
}

export async function tiktokEvent(c: EventCtx) {
  return compact({
    event: 'CompletePayment', event_time: Math.floor(c.paidAtMs / 1000), event_id: c.orderId,
    user: compact({ email: c.email ? await sha256(c.email) : '', phone: c.phone ? await sha256('+' + c.phone) : '', ttclid: c.clickIdType === 'ttclid' ? c.clickId : '', ttp: c.ttp, ip: c.ip, user_agent: c.ua }),
    page: compact({ url: c.url, referrer: c.referrer }),
    properties: { currency: c.currency.toUpperCase(), value: major(c.totalCents, c.currency), content_type: 'product', contents: c.items.map((i) => ({ content_id: i.sku, quantity: i.qty, price: major(i.unit_price_cents, c.currency) })) },
  });
}

type Sent = { ok: boolean; status: number; body: string };
async function post(url: string, init: RequestInit): Promise<Sent> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 2000) };
  } catch (e: any) { return { ok: false, status: 0, body: String(e?.message ?? e).slice(0, 300) }; }
}

export async function sendMeta(s: PlatformSettings, ev: any, testCode?: string): Promise<Sent> {
  const code = testCode ?? s.test_code;
  const r = await post(`https://graph.facebook.com/v21.0/${encodeURIComponent(s.pixel_id)}/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [ev], access_token: s.access_token, ...(code ? { test_event_code: code } : {}) }),
  });
  return r;
}
export async function sendTiktok(s: PlatformSettings, ev: any, testCode?: string): Promise<Sent> {
  const code = testCode ?? s.test_code;
  const r = await post('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Access-Token': s.access_token },
    body: JSON.stringify({ event_source: 'web', event_source_id: s.pixel_id, ...(code ? { test_event_code: code } : {}), data: [ev] }),
  });
  // TikTok answers HTTP 200 even for rejected events: the real verdict is the body's code (0 = OK).
  if (r.ok) { try { const j = JSON.parse(r.body); if (typeof j.code === 'number' && j.code !== 0) return { ...r, ok: false }; } catch { /* keep */ } }
  return r;
}
const send = (p: Platform, s: PlatformSettings, ev: any, testCode?: string) => (p === 'meta' ? sendMeta(s, ev, testCode) : sendTiktok(s, ev, testCode));
const build = (p: Platform, c: EventCtx) => (p === 'meta' ? metaEvent(c) : tiktokEvent(c));

/** Sends the Purchase of every paid, campaign-attributed order that has not reached a platform yet. Idempotent; a missed call is harmless. */
export async function sendPending(db: Database, opts: { storeBaseUrl?: string } = {}): Promise<{ sent: number; failed: number }> {
  const cfg = await getPixelSettings(db);
  const platforms = (['meta', 'tiktok'] as const).filter((p) => ready(cfg[p]));
  if (!platforms.length) return { sent: 0, failed: 0 };
  const since = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString();
  const sinceSql = since.slice(0, 10) + ' ' + since.slice(11, 19);
  const orders = await db.query<any>(
    `SELECT o.id, o.currency, o.total_cents, o.paid_at, o.customer_email, COALESCE(NULLIF(o.shipping_phone, ''), cu.phone) AS phone, o.cart_id,
            a.fbp, a.ttp, a.click_id_type, a.click_id, a.landing, a.referrer, a.ip, a.ua, a.created_at AS clicked_at
       FROM orders o JOIN ad_attribution a ON a.cart_id = o.cart_id LEFT JOIN customers cu ON cu.id = o.customer_id
      WHERE o.paid_at IS NOT NULL AND o.status NOT IN ('canceled', 'refunded', 'pending') AND o.total_cents > 0 AND (o.paid_at >= ? OR o.paid_at >= ?)
      ORDER BY o.paid_at LIMIT 200`, [since, sinceSql]);
  let sent = 0, failed = 0;
  for (const o of orders) {
    const done = new Map((await db.query<{ platform: string; status: string; tries: number }>(`SELECT platform, status, tries FROM ad_events WHERE order_id = ?`, [o.id])).map((r) => [r.platform, r]));
    const todo = platforms.filter((p) => { const d = done.get(p); return !d || (d.status !== 'sent' && d.tries < MAX_TRIES); });
    if (todo.length) {
      const items = await db.query<any>(`SELECT sku, qty, unit_price_cents FROM order_items WHERE order_id = ?`, [o.id]);
      const toMs = (t: string) => { const v = Date.parse(t.includes('T') ? t : t.replace(' ', 'T') + 'Z'); return Number.isFinite(v) ? v : Date.now(); };
      const ctx: EventCtx = {
        orderId: o.id, currency: o.currency, totalCents: o.total_cents, paidAtMs: toMs(o.paid_at), items, email: normEmail(o.customer_email), phone: normPhone(o.phone),
        ip: o.ip ?? '', ua: o.ua ?? '', fbp: o.fbp, ttp: o.ttp, clickIdType: o.click_id_type, clickId: o.click_id, clickAtMs: toMs(o.clicked_at),
        url: /^https?:\/\//.test(o.landing) ? o.landing : (opts.storeBaseUrl ?? ''), referrer: o.referrer,
      };
      for (const p of todo) {
        const r = await send(p, cfg[p], await build(p, ctx));
        const tries = (done.get(p)?.tries ?? 0) + 1;
        await db.run(
          `INSERT INTO ad_events (order_id, platform, status, tries, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(order_id, platform) DO UPDATE SET status = excluded.status, tries = excluded.tries, detail = excluded.detail, updated_at = excluded.updated_at`,
          [o.id, p, r.ok ? 'sent' : 'failed', tries, r.ok ? null : `${r.status} ${r.body}`.slice(0, 300), now()]);
        done.set(p, { platform: p, status: r.ok ? 'sent' : 'failed', tries });
        r.ok ? sent++ : failed++;
      }
    }
    // Delivered everywhere (or given up): the IP and browser string are no longer needed.
    if (platforms.every((p) => { const d = done.get(p); return d && (d.status === 'sent' || d.tries >= MAX_TRIES); })) await db.run(`UPDATE ad_attribution SET ip = NULL, ua = NULL WHERE cart_id = ?`, [o.cart_id]);
  }
  return { sent, failed };
}

/** A harmless synthetic purchase sent with the platform's TEST code, so the client can see it in Events Manager. Refuses without a test code. */
export async function sendTest(db: Database, p: Platform): Promise<Sent> {
  const s = (await getPixelSettings(db))[p];
  if (!ready(s)) return { ok: false, status: 0, body: 'Enter the pixel id and the access token first.' };
  if (!s.test_code) return { ok: false, status: 0, body: 'Enter a test event code first (from Events Manager), so this does not count as a real sale.' };
  const ev = await build(p, { orderId: `test-${Date.now()}`, currency: 'XOF', totalCents: 1000, paidAtMs: Date.now(), items: [{ sku: 'TEST', qty: 1, unit_price_cents: 1000 }], email: 'test@example.com', phone: '', ip: '', ua: 'Mozilla/5.0 (test)', fbp: '', ttp: '', clickIdType: '', clickId: '', clickAtMs: Date.now(), url: 'https://example.com/', referrer: '' });
  return send(p, s, ev);
}
