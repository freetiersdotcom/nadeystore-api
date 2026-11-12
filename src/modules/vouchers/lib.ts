import type { Database } from '../../db';
import { now } from '../../types';
import { getEmailProvider } from '../../lib/email/index';
import { isWalkIn } from '../../lib/walk-in';

export type CodeRow = { seq: number; sku: string; username: string; password: string; status: 'available' | 'sold' | 'void'; batch: string | null; order_id: string | null; order_item_id: string | null; slot: number | null; created_at: string; sold_at: string | null };

export const USER_RE = /^[A-Za-z0-9._@:+-]{1,64}$/;
export const PASS_RE = /^[\x21-\x7E]{0,64}$/;
export const MAX_LINES = 5000;

export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Reading a list of codes ──────────────────────────────────────────────────────────────────────
export type ParsedCode = { line: number; username: string; password: string; profile?: string; comment?: string };
export type ParseProblem = { line: number; text: string; reason: string; profile?: string };
export type ParseReport = { codes: ParsedCode[]; problems: ParseProblem[]; /** how many codes per Mikhmon "Profile" when the file has that column */ profiles?: Record<string, number> };

const clip = (s: string) => (s.length > 40 ? s.slice(0, 40) + '…' : s);
const USER_HEAD = /^(username|user|login|name|code)$/i;
// Header cells that mean "this is a table with its own columns" (a plain username,password header keeps the simple reading).
const KNOWN_HEAD = ['profile', 'comment', 'time limit', 'data limit', 'uptime', 'bytes in', 'bytes out'];

/** One CSV line into cells: quotes may hold the separator, "" is a quote. */
export function csvCells(line: string, sep: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"' && cur === '') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/**
 * Two kinds of input, both all-or-nothing and fully checked:
 *  - plain lines of `username` or `username,password` (comma, semicolon, tab or space; passwords have no spaces);
 *    a first line saying "username"/"user"/"login" with no other columns is a header and is skipped;
 *  - a CSV with a header row (the Mikhmon "Export users" file: Username,Password,Profile,Time Limit,Data Limit,Comment).
 *    Columns are found by name, the others are ignored; Profile and Comment are kept so the screen can pick one profile
 *    and name the batch.
 */
export function parseCodes(text: string): ParseReport {
  const codes: ParsedCode[] = []; const problems: ParseProblem[] = []; const seen = new Map<string, number>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  let used = 0; let cols: { sep: string; user: number; pass: number; profile: number; comment: number } | null = null;
  lines.forEach((raw, i) => {
    const line = i + 1; const t = raw.trim();
    if (!t) return;
    if (used === 0) {
      const sep = [',', ';', '\t'].find((x) => t.includes(x));
      if (sep) {
        const cells = csvCells(t, sep); const low = cells.map((x) => x.toLowerCase());
        const user = cells.findIndex((x) => USER_HEAD.test(x));
        if (user >= 0 && low.some((x) => KNOWN_HEAD.includes(x))) {
          cols = { sep, user, pass: low.findIndex((x) => ['password', 'pass', 'pwd', 'mot de passe'].includes(x)), profile: low.indexOf('profile'), comment: low.indexOf('comment') };
          used++; return;
        }
      }
      if (/^(username|user|login|name|code)\b/i.test(t) && /[,;\t ]/.test(t)) { used++; return; }
    }
    used++;
    if (used > MAX_LINES) { if (used === MAX_LINES + 1) problems.push({ line, text: '', reason: `More than ${MAX_LINES} lines: split the file.` }); return; }
    let username: string; let password = ''; let profile: string | undefined; let comment: string | undefined;
    if (cols) {
      const c = csvCells(t, cols.sep);
      username = c[cols.user] ?? ''; password = cols.pass >= 0 ? c[cols.pass] ?? '' : '';
      profile = cols.profile >= 0 ? c[cols.profile] || undefined : undefined; comment = cols.comment >= 0 ? c[cols.comment] || undefined : undefined;
    } else {
      const parts = t.split(/[,;\t ]+/).filter((x, k) => !(k > 1 && x === ''));
      if (parts.length > 2) { problems.push({ line, text: clip(t), reason: 'Too many columns (expected username and optional password). A Mikhmon export needs its header line (Username,Password,Profile…).' }); return; }
      [username, password = ''] = parts;
    }
    if (!USER_RE.test(username)) { problems.push({ line, text: clip(username), reason: 'Invalid username (letters, digits and . _ @ : + - only, up to 64).', profile }); return; }
    if (!PASS_RE.test(password)) { problems.push({ line, text: clip(username), reason: 'Invalid password (visible characters only, no spaces, up to 64).', profile }); return; }
    const key = username.toLowerCase();
    if (seen.has(key)) { problems.push({ line, text: clip(username), reason: `Appears twice in the file (first on line ${seen.get(key)}).`, profile }); return; }
    seen.set(key, line);
    codes.push({ line, username, password, ...(profile ? { profile } : {}), ...(comment ? { comment } : {}) });
  });
  const profiles: Record<string, number> = {};
  for (const c of codes) if (c.profile) profiles[c.profile] = (profiles[c.profile] ?? 0) + 1;
  return { codes, problems, ...(Object.keys(profiles).length ? { profiles } : {}) };
}

// ── Delivering codes to paid orders ──────────────────────────────────────────────────────────────
type Pending = { item_id: string; order_id: string; sku: string; qty: number };

/**
 * Give every fully paid order line its codes (one per unit), once, in the order the sales happened; then make sure
 * each such order has a private link and, when everything is delivered and the buyer left an address, send the e-mail.
 * Safe to call at any moment and from several requests at once: the unique (order line, slot) index stops duplicates.
 */
export async function reconcile(db: Database, orderId?: string): Promise<void> {
  const only = orderId ? ' AND oi.order_id = ?' : '';
  const todo = await db.query<Pending>(
    `SELECT oi.id AS item_id, oi.order_id, oi.sku, oi.qty
       FROM order_items oi
       JOIN voucher_plans p ON p.sku = oi.sku
       JOIN orders o ON o.id = oi.order_id
      WHERE o.status NOT IN ('canceled', 'refunded') AND COALESCE(o.amount_paid_cents, 0) >= o.total_cents AND o.total_cents > 0
        AND (SELECT COUNT(*) FROM voucher_codes c WHERE c.order_item_id = oi.id) < oi.qty${only}
      ORDER BY o.created_at, oi.id LIMIT 300`,
    orderId ? [orderId] : []
  );
  for (const it of todo) {
    const have = new Set((await db.query<{ slot: number }>(`SELECT slot FROM voucher_codes WHERE order_item_id = ?`, [it.item_id])).map((r) => r.slot));
    for (let slot = 0; slot < it.qty; slot++) {
      if (have.has(slot)) continue;
      try {
        // One statement picks the oldest free code and takes it, so two orders can never get the same code.
        await db.run(
          `UPDATE OR IGNORE voucher_codes SET status = 'sold', order_id = ?, order_item_id = ?, slot = ?, sold_at = ?
            WHERE seq = (SELECT seq FROM voucher_codes WHERE sku = ? AND status = 'available' ORDER BY seq LIMIT 1)`,
          [it.order_id, it.item_id, slot, now(), it.sku]
        );
      } catch { /* the slot was filled by a parallel request: fine */ }
    }
  }
  // Private links, and e-mails for orders that are now complete.
  const orders = await db.query<{ order_id: string }>(
    `SELECT DISTINCT oi.order_id FROM order_items oi JOIN voucher_plans p ON p.sku = oi.sku JOIN orders o ON o.id = oi.order_id
      WHERE o.status NOT IN ('canceled', 'refunded') AND COALESCE(o.amount_paid_cents, 0) >= o.total_cents AND o.total_cents > 0
        AND oi.order_id NOT IN (SELECT order_id FROM voucher_orders WHERE emailed_at IS NOT NULL OR email_tries >= 3)${only} LIMIT 100`,
    orderId ? [orderId] : []
  );
  for (const { order_id } of orders) {
    await db.run(`INSERT OR IGNORE INTO voucher_orders (order_id, token, created_at) VALUES (?, ?, ?)`, [order_id, newToken(), now()]);
    await maybeEmail(db, order_id);
  }
}

export async function missingFor(db: Database, orderId: string): Promise<number> {
  const [r] = await db.query<{ n: number }>(
    `SELECT COALESCE(SUM(oi.qty - (SELECT COUNT(*) FROM voucher_codes c WHERE c.order_item_id = oi.id)), 0) AS n
       FROM order_items oi JOIN voucher_plans p ON p.sku = oi.sku WHERE oi.order_id = ?`, [orderId]);
  return r?.n ?? 0;
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function maybeEmail(db: Database, orderId: string): Promise<void> {
  const [vo] = await db.query<{ token: string; emailed_at: string | null; email_tries: number }>(`SELECT * FROM voucher_orders WHERE order_id = ?`, [orderId]);
  if (!vo || vo.emailed_at || vo.email_tries >= 3) return;
  const [o] = await db.query<{ number: string; customer_email: string; locale: string | null }>(`SELECT number, customer_email, locale FROM orders WHERE id = ?`, [orderId]);
  if (!o || !o.customer_email || isWalkIn(o.customer_email) || /\.invalid$/i.test(o.customer_email)) return;   // nobody to write to
  if (await missingFor(db, orderId) > 0) return;                                                               // wait until everything is delivered
  const provider = await getEmailProvider(db);
  if (!provider) return;
  await db.run(`UPDATE voucher_orders SET email_tries = email_tries + 1 WHERE order_id = ?`, [orderId]);
  const codes = await db.query<CodeRow & { instructions_fr: string | null; instructions_en: string | null }>(
    `SELECT c.*, p.instructions_fr, p.instructions_en FROM voucher_codes c JOIN voucher_plans p ON p.sku = c.sku WHERE c.order_id = ? ORDER BY c.seq`, [orderId]);
  const [st] = await db.query<{ origin: string | null }>(`SELECT origin FROM voucher_settings WHERE id = 1`);
  const lang = (o.locale ?? 'fr').slice(0, 2) === 'en' ? 'en' : 'fr';
  const link = st?.origin ? `${st.origin}/m/vouchers/o/${vo.token}` : '';
  const T = lang === 'en'
    ? { subject: `Your access code${codes.length > 1 ? 's' : ''} — order ${o.number}`, hello: 'Hello,', body: 'Thank you for your purchase. Here is what you need to connect:', user: 'Username', pass: 'Password', page: 'Open this page to see them again' }
    : { subject: `Votre code d’accès${codes.length > 1 ? '' : ''} — commande ${o.number}`, hello: 'Bonjour,', body: 'Merci pour votre achat. Voici de quoi vous connecter :', user: 'Identifiant', pass: 'Mot de passe', page: 'Ouvrez cette page pour les retrouver' };
  const rows = codes.map((c) => `<p style="font-family:ui-monospace,monospace;font-size:16px;background:#f4f1e8;padding:10px 12px;border-radius:8px">${esc(T.user)}: <b>${esc(c.username)}</b>${c.password ? `<br>${esc(T.pass)}: <b>${esc(c.password)}</b>` : ''}</p>`).join('');
  const ins = [...new Set(codes.map((c) => (lang === 'en' ? c.instructions_en || c.instructions_fr : c.instructions_fr || c.instructions_en)).filter(Boolean))].map((t) => `<p style="white-space:pre-wrap">${esc(t)}</p>`).join('');
  try {
    await provider.send({
      to: o.customer_email, subject: T.subject,
      html: `<div style="font-family:system-ui,sans-serif;max-width:520px"><p>${T.hello}</p><p>${T.body}</p>${rows}${ins}${link ? `<p><a href="${esc(link)}">${esc(T.page)}</a></p>` : ''}</div>`,
      text: `${T.hello}\n${T.body}\n\n${codes.map((c) => `${T.user}: ${c.username}${c.password ? `\n${T.pass}: ${c.password}` : ''}`).join('\n\n')}\n${link ? `\n${link}` : ''}`,
    });
    await db.run(`UPDATE voucher_orders SET emailed_at = ? WHERE order_id = ?`, [now(), orderId]);
  } catch (e) { console.error('[vouchers] e-mail failed', e); }
}

/** The address the customer page lives at, remembered from the first request the module sees (hooks have no request). */
export async function rememberOrigin(db: Database, origin: string): Promise<void> {
  await db.run(`UPDATE voucher_settings SET origin = ? WHERE id = 1 AND COALESCE(origin, '') != ?`, [origin, origin]);
}

// ── Reading deliveries ───────────────────────────────────────────────────────────────────────────
export type Delivery = {
  order_id: string; number: string; created_at: string; order_status: string; customer_email: string; customer_phone: string | null; token: string | null; emailed: boolean;
  items: { sku: string; title: string; qty: number; codes: { seq: number; username: string; password: string }[]; waiting: number }[];
};

export async function deliveryOf(db: Database, orderId: string): Promise<Delivery | null> {
  const [o] = await db.query<any>(`SELECT id, number, created_at, status, customer_email, shipping_phone FROM orders WHERE id = ?`, [orderId]);
  if (!o) return null;
  const items = await db.query<{ id: string; sku: string; title: string; qty: number }>(
    `SELECT oi.id, oi.sku, oi.title, oi.qty FROM order_items oi JOIN voucher_plans p ON p.sku = oi.sku WHERE oi.order_id = ? ORDER BY oi.id`, [orderId]);
  if (!items.length) return null;
  const codes = await db.query<CodeRow>(`SELECT * FROM voucher_codes WHERE order_id = ? ORDER BY slot, seq`, [orderId]);
  const [vo] = await db.query<{ token: string; emailed_at: string | null }>(`SELECT token, emailed_at FROM voucher_orders WHERE order_id = ?`, [orderId]);
  return {
    order_id: o.id, number: o.number, created_at: o.created_at, order_status: o.status, customer_email: o.customer_email, customer_phone: o.shipping_phone ?? null,
    token: vo?.token ?? null, emailed: !!vo?.emailed_at,
    items: items.map((it) => {
      const mine = codes.filter((c) => c.order_item_id === it.id).map((c) => ({ seq: c.seq, username: c.username, password: c.password }));
      return { sku: it.sku, title: it.title, qty: it.qty, codes: mine, waiting: Math.max(0, it.qty - mine.length) };
    }),
  };
}
