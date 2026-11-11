// Subscriptions: a plan on top of an existing product variant ("every month, 12 000 F"). Each cycle becomes an ordinary order
// that the customer pays through the usual pay link, because mobile money (FedaPay) cannot be charged automatically.
//
//   active ──(renewal order created `lead_days` before the due date, pay link e-mailed)──▶ paid ──▶ cycle counted
//      │  unpaid `grace_days` after the due date → the order is cancelled (stock back) and the subscription pauses
//      ├─ pause / resume / skip / cancel (customer from the private link, or the merchant)
//      └─ ended: the plan's number of cycles is paid
//
// Dates: due date n = start + n × interval (months clamp to the month's end), so a subscription started on the 31st does not drift.
import type { Database } from '../../db';
import { ApiError, now, uuid, type DOStub } from '../../types';
import { createOrderFromCart } from '../../lib/orders';
import { releaseOfflineOrder } from '../../routes/orders';
import { cancelOrderAppointments } from '../../lib/appointments';
import { ensurePayToken } from '../../lib/plans';
import { payUrl } from '../../lib/email/planNotice';
import { getEmailProvider } from '../../lib/email/index';
import { isWalkIn } from '../../lib/walk-in';
import { isZeroDecimal } from '../../lib/currency';
import type { ScheduledCtx } from '../types';

export type Unit = 'week' | 'month';
export type Settings = { lead_days: number; remind_days: number; grace_days: number; origin: string | null };
export type Plan = { id: string; sku: string; name: string; unit: Unit; every_n: number; price_cents: number; max_cycles: number | null; active: number; created_at: string };
export type Sub = {
  id: string; token: string; plan_id: string | null; sku: string; title: string; qty: number; unit_price_cents: number; currency: string;
  email: string; name: string | null; phone: string | null; locale: string; ship_to: string | null; shipping_cents: number; shipping_label: string | null;
  status: 'active' | 'paused' | 'canceled' | 'ended'; pause_reason: string | null; unit: Unit; every_n: number; max_cycles: number | null;
  start_at: string; period: number; billed: number; cycles_done: number; next_due_at: string; waiting_stock: number; source_order_id: string | null; note: string | null; created_at: string; updated_at: string;
};
const DAY = 86_400_000;
export const newToken = (): string => { const b = new Uint8Array(18); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const ms = (s: string): number => { const t = Date.parse(/T|Z/.test(s) ? s : s.replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? t : 0; };
const lang = (l: string | null | undefined): 'fr' | 'en' => ((l ?? 'fr').slice(0, 2) === 'en' ? 'en' : 'fr');
export const usable = (e: string | null | undefined) => !!e && !isWalkIn(e) && !/\.invalid$/i.test(e) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// ── dates ────────────────────────────────────────────────────────────────────
export function addPeriods(startIso: string, unit: Unit, every: number, n: number): string {
  const d = new Date(startIso);
  if (unit === 'week') { d.setUTCDate(d.getUTCDate() + 7 * every * n); return d.toISOString(); }
  const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + every * n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}
const dueOf = (s: Pick<Sub, 'start_at' | 'unit' | 'every_n' | 'period'>) => addPeriods(s.start_at, s.unit, s.every_n, s.period);

// ── settings ─────────────────────────────────────────────────────────────────
export async function getSettings(db: Database): Promise<Settings> {
  const [s] = await db.query<Settings>(`SELECT lead_days, remind_days, grace_days, origin FROM sub_settings WHERE id = 1`);
  return s ?? { lead_days: 3, remind_days: 1, grace_days: 3, origin: null };
}
export async function rememberOrigin(db: Database, origin: string): Promise<void> {
  await db.run(`UPDATE sub_settings SET origin = ? WHERE id = 1 AND COALESCE(origin, '') != ?`, [origin, origin]);
}
export const manageUrl = (origin: string | null, token: string, l: 'fr' | 'en') => (origin ? `${origin}/m/subs/manage/${encodeURIComponent(token)}?lang=${l}` : null);

// ── creating ─────────────────────────────────────────────────────────────────
export type NewSub = {
  plan: Plan; email: string; name?: string | null; phone?: string | null; locale?: string; qty: number; unit_price_cents?: number; currency: string; title: string;
  ship_to?: unknown | null; shipping_cents?: number; shipping_label?: string | null; startMs?: number; source_order_id?: string | null; firstCyclePaid?: boolean; note?: string | null;
};
export async function createSubscription(db: Database, n: NewSub): Promise<{ id: string; token: string }> {
  const id = uuid(); const token = newToken(); const start = new Date(n.startMs ?? Date.now()).toISOString(); const paid = n.firstCyclePaid ? 1 : 0;
  const s = { start_at: start, unit: n.plan.unit, every_n: n.plan.every_n, period: paid };
  await db.run(
    `INSERT INTO subscriptions (id, token, plan_id, sku, title, qty, unit_price_cents, currency, email, name, phone, locale, ship_to, shipping_cents, shipping_label,
       status, unit, every_n, max_cycles, start_at, period, billed, cycles_done, next_due_at, source_order_id, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, token, n.plan.id, n.plan.sku, n.title, n.qty, n.unit_price_cents ?? n.plan.price_cents, n.currency, n.email.trim().toLowerCase(), n.name ?? null, n.phone ?? null, lang(n.locale),
     n.ship_to ? JSON.stringify(n.ship_to) : null, Math.max(0, n.shipping_cents ?? 0), n.shipping_label ?? null, n.plan.unit, n.plan.every_n, n.plan.max_cycles,
     start, paid, paid, paid, dueOf(s), n.source_order_id ?? null, n.note ?? null, now(), now()]);
  if (n.source_order_id) await db.run(`INSERT OR IGNORE INTO sub_orders (order_id, sub_id, cycle, due_at, counted, closed, created_at) VALUES (?, ?, 1, ?, 1, 'paid', ?)`, [n.source_order_id, id, start, now()]);
  return { id, token };
}

/** Carts that were attached to a plan on the storefront: once their order is paid, the subscription starts. */
async function startFromPaidCarts(db: Database): Promise<number> {
  const rows = await db.query<any>(
    `SELECT c.cart_id, c.plan_id, o.id AS order_id, o.paid_at, o.customer_email, o.shipping_name, o.shipping_phone, o.ship_to, o.shipping_cents, o.shipping_label, o.locale, o.currency
       FROM sub_carts c JOIN orders o ON o.cart_id = c.cart_id
      WHERE o.paid_at IS NOT NULL AND o.status NOT IN ('canceled', 'refunded', 'pending')
        AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.source_order_id = o.id)`);
  let made = 0;
  for (const r of rows) {
    const [plan] = await db.query<Plan>(`SELECT * FROM sub_plans WHERE id = ?`, [r.plan_id]);
    const [line] = await db.query<any>(`SELECT sku, title, qty, unit_price_cents FROM order_items WHERE order_id = ? AND sku = ?`, [r.order_id, plan?.sku ?? '']);
    if (!plan || !line) { await db.run(`DELETE FROM sub_carts WHERE cart_id = ?`, [r.cart_id]); continue; }
    let ship: unknown = null; try { ship = r.ship_to ? JSON.parse(r.ship_to) : null; } catch { /* keep null */ }
    await createSubscription(db, { plan, email: r.customer_email, name: r.shipping_name, phone: r.shipping_phone, locale: r.locale, qty: line.qty, unit_price_cents: line.unit_price_cents, currency: r.currency, title: line.title,
      ship_to: ship, shipping_cents: r.shipping_cents, shipping_label: r.shipping_label, startMs: ms(r.paid_at), source_order_id: r.order_id, firstCyclePaid: true });
    made++;
  }
  return made;
}

// ── renewal orders ───────────────────────────────────────────────────────────
const physical = async (db: Database, sku: string) => { const [v] = await db.query<any>(`SELECT product_type, status FROM variants WHERE sku = ?`, [sku]); return v as { product_type: string | null; status: string } | undefined; };

/** Creates the order of the next cycle (pending, stock taken) and e-mails the pay link. Returns why it could not, if it could not. */
export async function createRenewal(db: Database, ctx: ScheduledCtx, sub: Sub): Promise<{ order_id: string } | { skipped: 'stock' | 'unavailable' | 'no_context' | 'ended' | 'busy' }> {
  if (!ctx.stub || !ctx.exec) return { skipped: 'no_context' };
  if (sub.max_cycles != null && sub.billed >= sub.max_cycles) return { skipped: 'ended' };
  const [open] = await db.query(`SELECT 1 FROM sub_orders WHERE sub_id = ? AND closed IS NULL LIMIT 1`, [sub.id]);
  if (open) return { skipped: 'busy' };
  const v = await physical(db, sub.sku);
  if (!v || v.status !== 'active') return { skipped: 'unavailable' };
  const isPhysical = (v.product_type ?? 'physical') === 'physical';
  if (isPhysical) {
    const [inv] = await db.query<{ on_hand: number; reserved: number }>(`SELECT on_hand, reserved FROM inventory WHERE sku = ?`, [sub.sku]);
    if ((inv?.on_hand ?? 0) - (inv?.reserved ?? 0) < sub.qty) { await db.run(`UPDATE subscriptions SET waiting_stock = 1, updated_at = ? WHERE id = ?`, [now(), sub.id]); return { skipped: 'stock' }; }
  }
  const cartId = uuid();
  await db.run(
    `INSERT INTO carts (id, status, customer_email, currency, ship_to, shipping_name, locale, expires_at, shipping_cents, shipping_label, contact_phone)
     VALUES (?, 'checked_out', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cartId, sub.email, sub.currency, sub.ship_to, sub.name, sub.locale, new Date(Date.now() + 3600_000).toISOString(), sub.shipping_cents, sub.shipping_label, sub.phone]);
  await db.run(`INSERT INTO cart_items (id, cart_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`, [uuid(), cartId, sub.sku, sub.title, sub.qty, sub.unit_price_cents]);
  if (isPhysical) await db.run(`UPDATE inventory SET reserved = reserved + ?, updated_at = ? WHERE sku = ?`, [sub.qty, now(), sub.sku]);
  let result;
  try {
    result = await createOrderFromCart(db, ctx.stub as DOStub, ctx.exec, cartId, { provider: 'subscription', providerRef: sub.id, storeBaseUrl: ctx.storeBaseUrl, storeName: ctx.storeName, paymentMethod: 'manual', skipEmail: true });
  } catch (e) {
    const [existing] = await db.query(`SELECT id FROM orders WHERE cart_id = ? LIMIT 1`, [cartId]);
    if (!existing && isPhysical) await db.run(`UPDATE inventory SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE sku = ?`, [sub.qty, now(), sub.sku]);
    throw e;
  }
  if (!result) throw ApiError.invalidRequest('Could not create the renewal order.');
  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [result.orderId]);
  await ensurePayToken(db, order);
  const due = sub.next_due_at; const cycle = sub.billed + 1;
  await db.run(`INSERT INTO sub_orders (order_id, sub_id, cycle, due_at, counted, created_at) VALUES (?, ?, ?, ?, 0, ?)`, [order.id, sub.id, cycle, due, now()]);
  const period = sub.period + 1;
  await db.run(`UPDATE subscriptions SET billed = billed + 1, period = ?, next_due_at = ?, waiting_stock = 0, updated_at = ? WHERE id = ?`, [period, dueOf({ ...sub, period }), now(), sub.id]);
  await notify(db, ctx, sub, 'renewal', { orderId: order.id, due });
  return { order_id: order.id };
}

/** Cancels the renewal orders of this subscription that nobody paid yet (stock goes back). Returns how many. */
export async function closeOpenOrders(db: Database, subId: string, why: string): Promise<number> {
  const rows = await db.query<any>(`SELECT o.* FROM sub_orders so JOIN orders o ON o.id = so.order_id WHERE so.sub_id = ? AND so.closed IS NULL`, [subId]);
  let n = 0;
  for (const o of rows) {
    if (Number(o.amount_paid_cents ?? 0) >= Number(o.total_cents) || o.status !== 'pending') continue;   // paid (or being handled): leave it alone
    await releaseOfflineOrder(db as any, o);
    await db.run(`UPDATE orders SET status = 'canceled' WHERE id = ? AND status = 'pending'`, [o.id]);
    await cancelOrderAppointments(db, o.id);
    await db.run(`UPDATE sub_orders SET closed = ? WHERE order_id = ?`, [why, o.id]); n++;
  }
  return n;
}

// ── customer / merchant actions ──────────────────────────────────────────────
export type Action = 'pause' | 'resume' | 'skip' | 'cancel';
export async function act(db: Database, sub: Sub, action: Action): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = now();
  if (sub.status === 'canceled' || sub.status === 'ended') return { ok: false, error: 'This subscription is over.' };
  if (action === 'pause') {
    if (sub.status === 'paused') return { ok: true };
    await closeOpenOrders(db, sub.id, 'paused');
    await db.run(`UPDATE subscriptions SET status = 'paused', pause_reason = 'customer', updated_at = ? WHERE id = ?`, [t, sub.id]); return { ok: true };
  }
  if (action === 'cancel') {
    await closeOpenOrders(db, sub.id, 'canceled');
    await db.run(`UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE id = ?`, [t, sub.id]); return { ok: true };
  }
  if (action === 'resume') {
    if (sub.status !== 'paused') return { ok: true };
    // New rhythm from today: the first renewal comes right away.
    await db.run(`UPDATE subscriptions SET status = 'active', pause_reason = NULL, start_at = ?, period = 0, next_due_at = ?, waiting_stock = 0, updated_at = ? WHERE id = ?`, [new Date().toISOString(), new Date().toISOString(), t, sub.id]); return { ok: true };
  }
  // skip: the next shipment does not happen. If its order already exists and is unpaid, that order is the one dropped.
  if (sub.status !== 'active') return { ok: false, error: 'Resume the subscription first.' };
  const [paidOpen] = await db.query<any>(`SELECT o.id FROM sub_orders so JOIN orders o ON o.id = so.order_id WHERE so.sub_id = ? AND so.closed IS NULL AND COALESCE(o.amount_paid_cents, 0) >= o.total_cents`, [sub.id]);
  if (paidOpen) return { ok: false, error: 'The next order is already paid and being prepared.' };
  const dropped = await closeOpenOrders(db, sub.id, 'skipped');
  if (dropped === 0) {
    const period = sub.period + 1;
    await db.run(`UPDATE subscriptions SET period = ?, next_due_at = ?, updated_at = ? WHERE id = ?`, [period, dueOf({ ...sub, period }), t, sub.id]);
  }
  return { ok: true };
}

// ── e-mails ──────────────────────────────────────────────────────────────────
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function money(cents: number, cur: string, l: 'fr' | 'en') {
  const zero = isZeroDecimal(cur);
  try { return new Intl.NumberFormat(l === 'en' ? 'en-GB' : 'fr-FR', { style: 'currency', currency: cur, minimumFractionDigits: zero ? 0 : 2, maximumFractionDigits: zero ? 0 : 2 }).format(zero ? cents : cents / 100); } catch { return `${cents} ${cur}`; }
}
const dateOf = (iso: string, l: 'fr' | 'en') => new Intl.DateTimeFormat(l === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso));

const T = {
  fr: {
    renewal: { subject: (n: string) => `${n} : votre prochaine commande est prête`, head: 'Votre prochaine commande est prête', body: (item: string, tot: string, due: string) => `${item} — ${tot}, pour le ${due}. Vos articles sont réservés ; réglez en ligne pour que nous les préparions.`, pay: 'Payer maintenant' },
    reminder: { subject: (n: string) => `${n} : rappel de paiement`, head: 'Rappel de paiement', body: (item: string, tot: string, due: string) => `${item} — ${tot}, à régler avant le ${due}. Sans paiement, la commande sera annulée et votre abonnement mis en pause.`, pay: 'Payer maintenant' },
    paused: { subject: (n: string) => `${n} : abonnement en pause`, head: 'Votre abonnement est en pause', body: (item: string) => `Faute de paiement, la commande de « ${item} » a été annulée et l’abonnement mis en pause. Vous pouvez le reprendre quand vous voulez.`, pay: 'Gérer mon abonnement' },
    manage: 'Mettre en pause, sauter une commande ou arrêter l’abonnement', foot: 'Abonnement', ref: 'Commande',
  },
  en: {
    renewal: { subject: (n: string) => `${n}: your next order is ready`, head: 'Your next order is ready', body: (item: string, tot: string, due: string) => `${item} — ${tot}, for ${due}. Your items are reserved; pay online so we can prepare them.`, pay: 'Pay now' },
    reminder: { subject: (n: string) => `${n}: payment reminder`, head: 'Payment reminder', body: (item: string, tot: string, due: string) => `${item} — ${tot}, to pay before ${due}. Without payment the order will be cancelled and your subscription paused.`, pay: 'Pay now' },
    paused: { subject: (n: string) => `${n}: subscription paused`, head: 'Your subscription is paused', body: (item: string) => `As it was not paid, the order for “${item}” was cancelled and the subscription paused. You can resume whenever you like.`, pay: 'Manage my subscription' },
    manage: 'Pause, skip an order or stop the subscription', foot: 'Subscription', ref: 'Order',
  },
};
export function buildMail(kind: 'renewal' | 'reminder' | 'paused', o: { l: 'fr' | 'en'; storeName: string; item: string; total: string; due: string; pay: string | null; manage: string | null }) {
  const t = T[o.l]; const k = t[kind];
  const body = kind === 'paused' ? (k as typeof t.paused).body(o.item) : (k as typeof t.renewal).body(o.item, o.total, o.due);
  const link = kind === 'paused' ? o.manage : o.pay;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:16px;color:#2B2B2B"><h2 style="margin:0 0 12px">${esc(k.head)}</h2><p>${esc(body)}</p>${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#0F6B4B;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px">${esc(k.pay)}</a></p>` : ''}${o.manage && kind !== 'paused' ? `<p style="font-size:13px;color:#666"><a href="${esc(o.manage)}">${esc(t.manage)}</a></p>` : ''}<p style="font-size:12px;color:#999">${esc(o.storeName)}</p></div>`;
  const text = `${k.head}\n\n${body}\n${link ? `\n${k.pay}: ${link}\n` : ''}${o.manage && kind !== 'paused' ? `\n${t.manage}: ${o.manage}\n` : ''}\n${o.storeName}`;
  return { subject: k.subject(o.storeName), html, text };
}
async function notify(db: Database, ctx: ScheduledCtx, sub: Sub, kind: 'renewal' | 'reminder' | 'paused', x: { orderId?: string; due: string }): Promise<void> {
  if (!usable(sub.email)) return;
  try {
    const provider = await getEmailProvider(db); if (!provider) return;
    const l = lang(sub.locale); const st = await getSettings(db);
    let pay: string | null = null; let total = sub.unit_price_cents * sub.qty + sub.shipping_cents;
    if (x.orderId) { const [o] = await db.query<any>(`SELECT pay_token, total_cents FROM orders WHERE id = ?`, [x.orderId]); if (o) { pay = o.pay_token ? payUrl(ctx.storeBaseUrl, l, o.pay_token) : null; total = Number(o.total_cents); } }
    const mail = buildMail(kind, { l, storeName: ctx.storeName, item: `${sub.qty > 1 ? sub.qty + ' × ' : ''}${sub.title}`, total: money(total, sub.currency, l), due: dateOf(x.due, l), pay, manage: manageUrl(st.origin, sub.token, l) });
    await provider.send({ to: sub.email, subject: mail.subject, html: mail.html, text: mail.text });
  } catch (e) { console.error('[subs] e-mail failed', e); }
}

// ── the periodic work ────────────────────────────────────────────────────────
export async function tick(db: Database, ctx: ScheduledCtx): Promise<{ started: number; counted: number; renewed: number; reminded: number; paused: number; waiting: number }> {
  const out = { started: 0, counted: 0, renewed: 0, reminded: 0, paused: 0, waiting: 0 };
  const st = await getSettings(db);
  out.started = await startFromPaidCarts(db);

  // Paid renewals count; the last one ends the subscription.
  const paid = await db.query<any>(`SELECT so.order_id, so.sub_id FROM sub_orders so JOIN orders o ON o.id = so.order_id WHERE so.counted = 0 AND so.closed IS NULL AND o.status NOT IN ('canceled', 'refunded') AND o.total_cents > 0 AND COALESCE(o.amount_paid_cents, 0) >= o.total_cents`);
  for (const p of paid) {
    await db.run(`UPDATE sub_orders SET counted = 1, closed = 'paid' WHERE order_id = ?`, [p.order_id]);
    await db.run(`UPDATE subscriptions SET cycles_done = cycles_done + 1, updated_at = ? WHERE id = ?`, [now(), p.sub_id]);
    await db.run(`UPDATE subscriptions SET status = 'ended' WHERE id = ? AND max_cycles IS NOT NULL AND cycles_done >= max_cycles AND status = 'active'`, [p.sub_id]);
    out.counted++;
  }
  // Orders someone cancelled or refunded by hand are no longer open for this subscription.
  await db.run(`UPDATE sub_orders SET closed = 'canceled' WHERE closed IS NULL AND counted = 0 AND order_id IN (SELECT id FROM orders WHERE status IN ('canceled', 'refunded'))`);

  const open = await db.query<any>(`SELECT so.order_id, so.due_at, so.reminded_at, s.* FROM sub_orders so JOIN subscriptions s ON s.id = so.sub_id WHERE so.closed IS NULL AND so.counted = 0`);
  for (const r of open) {
    const dueMs = ms(r.due_at); const sub = r as Sub;
    if (Date.now() > dueMs + st.grace_days * DAY) {
      await closeOpenOrders(db, sub.id, 'unpaid');
      await db.run(`UPDATE subscriptions SET status = 'paused', pause_reason = 'unpaid', updated_at = ? WHERE id = ? AND status = 'active'`, [now(), sub.id]);
      await notify(db, ctx, sub, 'paused', { due: r.due_at }); out.paused++;
    } else if (!r.reminded_at && st.remind_days > 0 && Date.now() >= dueMs - st.remind_days * DAY) {
      await db.run(`UPDATE sub_orders SET reminded_at = ? WHERE order_id = ?`, [now(), r.order_id]);
      await notify(db, ctx, sub, 'reminder', { orderId: r.order_id, due: r.due_at }); out.reminded++;
    }
  }

  const due = await db.query<Sub>(`SELECT * FROM subscriptions WHERE status = 'active' AND next_due_at <= ? ORDER BY next_due_at LIMIT 100`, [new Date(Date.now() + st.lead_days * DAY).toISOString()]);
  for (const s of due) {
    if (s.max_cycles != null && s.billed >= s.max_cycles) continue;
    try { const r = await createRenewal(db, ctx, s); if ('order_id' in r) out.renewed++; else if (r.skipped === 'stock') out.waiting++; else if (r.skipped === 'unavailable') await db.run(`UPDATE subscriptions SET status = 'paused', pause_reason = 'unavailable', updated_at = ? WHERE id = ?`, [now(), s.id]); }
    catch (e) { console.error('[subs] renewal failed', s.id, e); }
  }
  return out;
}
