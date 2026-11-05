import type { Database } from '../../db';
import { now } from '../../types';
import { getEmailProvider } from '../../lib/email/index';
import { isWalkIn } from '../../lib/walk-in';

export type Settings = { origin: string | null; step1_hours: number; step2_hours: number; discount_code: string | null; cooldown_days: number; max_age_days: number };
export type Snap = { sku: string; title: string; qty: number; unit_price_cents: number };
export type RecRow = { cart_id: string; token: string; email: string; locale: string | null; currency: string; items_json: string; total_cents: number; cart_at: string; step: number; tries: number; first_sent_at: string | null; last_sent_at: string | null; resumed_at: string | null; closed: string | null };

const ZERO = new Set(['XOF', 'XAF', 'GNF', 'JPY', 'KRW', 'VND']);
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const MAX_TRIES = 3;
export const newToken = (): string => { const b = new Uint8Array(18); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

/** SQLite's datetime('now') gives "YYYY-MM-DD HH:MM:SS" (UTC); the API writes ISO. Read both. */
export const ms = (s: string): number => { const t = Date.parse(/T|Z/.test(s) ? s : s.replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? t : 0; };
export const money = (cents: number, cur: string, lang: string) => {
  try { return new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'fr-FR', { style: 'currency', currency: cur, maximumFractionDigits: ZERO.has(cur) ? 0 : 2 }).format(ZERO.has(cur) ? cents : cents / 100); }
  catch { return `${ZERO.has(cur) ? cents : (cents / 100).toFixed(2)} ${cur}`; }
};
export const usable = (email: string | null | undefined) => !!email && !isWalkIn(email) && !/\.invalid$/i.test(email) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

export async function getSettings(db: Database): Promise<Settings> {
  const [s] = await db.query<Settings>(`SELECT origin, step1_hours, step2_hours, discount_code, cooldown_days, max_age_days FROM recovery_settings WHERE id = 1`);
  return s;
}
export async function rememberOrigin(db: Database, origin: string): Promise<void> {
  await db.run(`UPDATE recovery_settings SET origin = ? WHERE id = 1 AND COALESCE(origin, '') != ?`, [origin, origin]);
}

/** Copy the contents of carts that have items and no order, before the core cleans them up. */
export async function snapshot(db: Database, st: Settings): Promise<void> {
  const carts = await db.query<{ id: string; customer_email: string; locale: string | null; currency: string; created_at: string }>(
    `SELECT c.id, c.customer_email, c.locale, c.currency, c.created_at FROM carts c
      WHERE c.created_at > datetime('now', ?) AND EXISTS (SELECT 1 FROM cart_items i WHERE i.cart_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.cart_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM recovery_carts r WHERE r.cart_id = c.id AND r.step > 0)
      ORDER BY c.created_at DESC LIMIT 200`, [`-${st.max_age_days} days`]);
  for (const c of carts) {
    if (!usable(c.customer_email)) continue;
    const items = await db.query<Snap>(`SELECT sku, title, qty, unit_price_cents FROM cart_items WHERE cart_id = ?`, [c.id]);
    if (!items.length) continue;
    const total = items.reduce((n, i) => n + i.qty * i.unit_price_cents, 0);
    await db.run(
      `INSERT INTO recovery_carts (cart_id, token, email, locale, currency, items_json, total_cents, cart_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cart_id) DO UPDATE SET items_json = excluded.items_json, total_cents = excluded.total_cents WHERE closed IS NULL AND step = 0`,
      [c.id, newToken(), c.customer_email.toLowerCase(), c.locale, c.currency, JSON.stringify(items), total, c.created_at]);
  }
}

/** Why a cart must not be reminded (null = fine). Anything but 'cooldown' is final. */
async function blocker(db: Database, r: RecRow, st: Settings): Promise<string | null> {
  if (!usable(r.email)) return 'invalid';
  const [opt] = await db.query(`SELECT 1 FROM recovery_optout WHERE email = ?`, [r.email]);
  if (opt) return 'optout';
  if (Date.now() - ms(r.cart_at) > st.max_age_days * 86_400_000) return 'old';
  const [bought] = await db.query(
    `SELECT 1 FROM orders WHERE status != 'canceled' AND (cart_id = ? OR (lower(customer_email) = ? AND created_at >= ?)) LIMIT 1`, [r.cart_id, r.email, r.cart_at]);
  if (bought) return 'converted';
  return null;
}

const T = {
  fr: {
    s1: (n: string) => `Vous avez oublié quelque chose chez ${n}`, s2: (n: string) => `Votre panier chez ${n} vous attend encore`,
    hello: 'Bonjour,', b1: 'Vous avez laissé des articles dans votre panier. Nous les avons gardés pour vous :', b2: 'Votre panier est toujours là, au cas où. Si vous avez eu une question ou un souci au paiement, répondez simplement à cet e-mail.',
    total: 'Total', cta: 'Reprendre mon panier', code: (c: string) => `Un petit geste : utilisez le code ${c} au moment du paiement.`, stop: 'Ne plus recevoir ces rappels', why: 'Vous recevez ce message car vous avez commencé une commande sur notre boutique.',
  },
  en: {
    s1: (n: string) => `You left something behind at ${n}`, s2: (n: string) => `Your ${n} cart is still waiting`,
    hello: 'Hello,', b1: 'You left items in your cart. We kept them for you:', b2: 'Your cart is still there, just in case. If you had a question or a problem paying, simply reply to this e-mail.',
    total: 'Total', cta: 'Resume my cart', code: (c: string) => `A small thank-you: use code ${c} at checkout.`, stop: 'Stop these reminders', why: 'You are receiving this because you started an order on our shop.',
  },
};

export function buildEmail(o: { lang: 'fr' | 'en'; storeName: string; items: Snap[]; currency: string; total: number; resumeUrl: string; stopUrl: string; step: number; code: string | null }) {
  const t = T[o.lang]; const subject = (o.step >= 2 ? t.s2 : t.s1)(o.storeName);
  const rows = o.items.map((i) => `<tr><td style="padding:4px 12px 4px 0">${esc(i.title)}${i.qty > 1 ? ` × ${i.qty}` : ''}</td><td style="text-align:right;white-space:nowrap">${esc(money(i.unit_price_cents * i.qty, o.currency, o.lang))}</td></tr>`).join('');
  const code = o.step >= 2 && o.code ? `<p style="background:#f4f1e8;padding:10px 12px;border-radius:8px">${esc(t.code(o.code))}</p>` : '';
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px"><p>${t.hello}</p><p>${o.step >= 2 ? t.b2 : t.b1}</p><table style="width:100%;border-collapse:collapse">${rows}<tr><td style="padding-top:8px"><b>${t.total}</b></td><td style="text-align:right;padding-top:8px"><b>${esc(money(o.total, o.currency, o.lang))}</b></td></tr></table>${code}<p><a href="${esc(o.resumeUrl)}" style="display:inline-block;background:#0F6B4B;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">${t.cta}</a></p><p style="color:#777;font-size:12px">${t.why}<br><a href="${esc(o.stopUrl)}" style="color:#777">${t.stop}</a></p></div>`;
  const text = `${t.hello}\n\n${o.step >= 2 ? t.b2 : t.b1}\n\n${o.items.map((i) => `- ${i.title}${i.qty > 1 ? ` x${i.qty}` : ''}`).join('\n')}\n${t.total}: ${money(o.total, o.currency, o.lang)}\n${o.step >= 2 && o.code ? `\n${t.code(o.code)}\n` : ''}\n${t.cta}: ${o.resumeUrl}\n\n${t.stop}: ${o.stopUrl}`;
  return { subject, html, text };
}

export const resumeUrl = (base: string, lang: 'fr' | 'en', token: string) => `${base.replace(/\/$/, '')}/${lang}/${lang === 'fr' ? 'panier' : 'cart'}?resume=${encodeURIComponent(token)}`;
export const stopUrl = (origin: string, token: string, lang: 'fr' | 'en') => `${origin}/m/recovery/stop/${encodeURIComponent(token)}?lang=${lang}`;

/** Snapshot, then send the reminders that are due. Safe to run any number of times. */
export async function runRecovery(db: Database, ctx: { storeBaseUrl: string; storeName: string }, opts: { limit?: number } = {}): Promise<{ sent: number }> {
  const st = await getSettings(db);
  await snapshot(db, st);
  const origin = st.origin;
  const hours = [st.step1_hours, st.step2_hours].filter((h) => h > 0);
  const due = await db.query<RecRow>(`SELECT * FROM recovery_carts WHERE closed IS NULL AND step < ? AND tries < ? ORDER BY cart_at LIMIT 300`, [hours.length, MAX_TRIES]);
  let sent = 0; const limit = opts.limit ?? 40;
  let provider: Awaited<ReturnType<typeof getEmailProvider>> | undefined;
  for (const r of due) {
    if (sent >= limit) break;
    const wait = hours[r.step] * 3_600_000;
    const from = r.step === 0 ? ms(r.cart_at) : ms(r.first_sent_at ?? r.cart_at);
    if (Date.now() < from + wait) continue;
    const why = await blocker(db, r, st);
    if (why) { await db.run(`UPDATE recovery_carts SET closed = ? WHERE cart_id = ?`, [why, r.cart_id]); continue; }
    if (!origin) continue;                       // no address for the opt-out link yet: wait rather than send without it
    const [recent] = await db.query(`SELECT 1 FROM recovery_carts WHERE email = ? AND cart_id != ? AND last_sent_at > ? LIMIT 1`, [r.email, r.cart_id, new Date(Date.now() - st.cooldown_days * 86_400_000).toISOString()]);
    if (recent) continue;                         // another cart of theirs was reminded recently: try again later
    if (provider === undefined) provider = await getEmailProvider(db);
    if (!provider) break;
    const lang: 'fr' | 'en' = (r.locale ?? 'fr').slice(0, 2) === 'en' ? 'en' : 'fr';
    const mail = buildEmail({ lang, storeName: ctx.storeName, items: JSON.parse(r.items_json), currency: r.currency, total: r.total_cents, resumeUrl: resumeUrl(ctx.storeBaseUrl, lang, r.token), stopUrl: stopUrl(origin, r.token, lang), step: r.step + 1, code: st.discount_code });
    await db.run(`UPDATE recovery_carts SET tries = tries + 1 WHERE cart_id = ?`, [r.cart_id]);
    try {
      await provider.send({ to: r.email, subject: mail.subject, html: mail.html, text: mail.text });
      const t = now();
      await db.run(`UPDATE recovery_carts SET step = step + 1, tries = 0, last_sent_at = ?, first_sent_at = COALESCE(first_sent_at, ?) WHERE cart_id = ?`, [t, t, r.cart_id]);
      sent++;
    } catch (e) { console.error('[recovery] e-mail failed', e); }
  }
  return { sent };
}

export type Row = RecRow & { state: 'waiting' | 'reminded' | 'recovered' | 'optout' | 'closed'; orders_after: number };
export async function listRows(db: Database, limit = 100): Promise<Row[]> {
  const rows = await db.query<RecRow & { paid_after: number }>(
    `SELECT r.*, (SELECT COUNT(*) FROM orders o WHERE o.status != 'canceled' AND r.first_sent_at IS NOT NULL AND (o.cart_id = r.cart_id OR lower(o.customer_email) = r.email) AND o.created_at >= r.first_sent_at AND COALESCE(o.amount_paid_cents, 0) >= o.total_cents AND o.total_cents > 0) AS paid_after
       FROM recovery_carts r ORDER BY r.cart_at DESC LIMIT ${Math.min(500, limit)}`);
  return rows.map((r) => ({ ...r, orders_after: r.paid_after,
    state: r.closed === 'optout' ? 'optout' : r.paid_after > 0 ? 'recovered' : r.closed ? 'closed' : r.step > 0 ? 'reminded' : 'waiting' }));
}
