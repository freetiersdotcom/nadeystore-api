// Milestone payments. A schedule is a list of stages whose amounts add up to the order total.
// There is no separate "stage payment": the customer pays through the order's normal pay link, and money
// received fills the stages in order (first stage first). So a stage is
//   paid     when the order's payments cover it,
//   due      when the merchant has requested it and it is not covered yet,
//   upcoming otherwise.
// Stages the payments already cover are locked; the rest can be edited until paid (the customer is told).
import type { Database } from '../../db';
import { ApiError, now, uuid } from '../../types';
import { ensurePayToken } from '../../lib/plans';
import { payUrl } from '../../lib/email/planNotice';
import { getEmailProvider } from '../../lib/email/index';
import { isWalkIn } from '../../lib/walk-in';
import { isZeroDecimal } from '../../lib/currency';

export type StageRow = { id: string; order_id: string; pos: number; label: string; amount_cents: number; expected_on: string | null; requested_at: string | null };
export type Stage = StageRow & { status: 'paid' | 'due' | 'upcoming'; paid_cents: number; remaining_cents: number };
export type StageInput = { label: string; amount_cents?: number; percent?: number; expected_on?: string | null };

export const MAX_STAGES = 12;
const lang = (l: string | null | undefined): 'fr' | 'en' => ((l ?? 'fr').slice(0, 2) === 'en' ? 'en' : 'fr');
export const usable = (e: string | null | undefined) => !!e && !isWalkIn(e) && !/\.invalid$/i.test(e) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function money(cents: number, cur: string, l: 'fr' | 'en') {
  const zero = isZeroDecimal(cur);
  try { return new Intl.NumberFormat(l === 'en' ? 'en-GB' : 'fr-FR', { style: 'currency', currency: cur, minimumFractionDigits: zero ? 0 : 2, maximumFractionDigits: zero ? 0 : 2 }).format(zero ? cents : cents / 100); } catch { return `${cents} ${cur}`; }
}
const dateOf = (iso: string, l: 'fr' | 'en') => new Intl.DateTimeFormat(l === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso));

/** Money received is poured into the stages in order. */
export function withState(rows: StageRow[], paidCents: number): Stage[] {
  let left = Math.max(0, paidCents);
  return rows.slice().sort((a, b) => a.pos - b.pos).map((r) => {
    const got = Math.min(left, r.amount_cents); left -= got;
    const paid = got >= r.amount_cents;
    return { ...r, paid_cents: got, remaining_cents: r.amount_cents - got, status: paid ? 'paid' : r.requested_at ? 'due' : 'upcoming' } as Stage;
  });
}

/** Turn what the merchant typed into fixed amounts that add up to the order total. A percentage is frozen into an amount here. */
export function buildStages(totalCents: number, input: StageInput[]): { label: string; amount_cents: number; expected_on: string | null }[] {
  if (input.length < 2 || input.length > MAX_STAGES) throw ApiError.invalidRequest(`A schedule needs between 2 and ${MAX_STAGES} stages.`);
  const out = input.map((s, i) => {
    const label = s.label.trim(); if (!label) throw ApiError.invalidRequest(`Stage ${i + 1} needs a name.`);
    if ((s.amount_cents == null) === (s.percent == null)) throw ApiError.invalidRequest(`Stage ${i + 1}: give either an amount or a percentage.`);
    if (s.expected_on && !/^\d{4}-\d{2}-\d{2}$/.test(s.expected_on)) throw ApiError.invalidRequest(`Stage ${i + 1}: the date must be YYYY-MM-DD.`);
    const amount = s.amount_cents != null ? s.amount_cents : Math.round((totalCents * (s.percent as number)) / 100);
    return { label, amount_cents: amount, expected_on: s.expected_on || null, pct: s.percent != null };
  });
  // The last stage absorbs rounding when it is a percentage.
  const last = out[out.length - 1];
  if (last.pct) last.amount_cents = totalCents - out.slice(0, -1).reduce((a, s) => a + s.amount_cents, 0);
  if (out.some((s) => !Number.isInteger(s.amount_cents) || s.amount_cents <= 0)) throw ApiError.invalidRequest('Every stage must be more than zero.');
  const sum = out.reduce((a, s) => a + s.amount_cents, 0);
  if (sum !== totalCents) throw ApiError.invalidRequest(`The stages add up to ${sum} but the order total is ${totalCents}.`);
  return out.map(({ label, amount_cents, expected_on }) => ({ label, amount_cents, expected_on }));
}

export async function getOrder(db: Database, orderId: string): Promise<any> {
  const [o] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!o) throw ApiError.notFound('Order not found');
  return o;
}
export const stagesOf = (db: Database, orderId: string) => db.query<StageRow>(`SELECT * FROM ms_stages WHERE order_id = ? ORDER BY pos`, [orderId]);

export async function view(db: Database, order: any) {
  const [sch] = await db.query<any>(`SELECT * FROM ms_schedules WHERE order_id = ?`, [order.id]);
  if (!sch) return null;
  const stages = withState(await stagesOf(db, order.id), Number(order.amount_paid_cents ?? 0));
  const due = stages.find((s) => s.status === 'due');
  return { order_id: order.id, order_number: order.number, status: order.status, currency: order.currency, total_cents: Number(order.total_cents), paid_cents: Number(order.amount_paid_cents ?? 0), note: sch.note ?? null, stages, due_now_cents: order.status === 'canceled' || order.status === 'refunded' ? 0 : due ? due.remaining_cents : 0, next_pos: stages.find((s) => s.status !== 'paid')?.pos ?? null };
}

/** Create the schedule, or change it. Paid stages are locked (same amount, same position); the rest may change. */
export async function saveSchedule(db: Database, ctx: Ctx, orderId: string, input: StageInput[], note: string | null): Promise<{ created: boolean; notified: boolean }> {
  const order = await getOrder(db, orderId);
  if (order.status === 'canceled' || order.status === 'refunded') throw ApiError.invalidRequest(`The order is ${order.status}.`);
  if (order.status !== 'pending' && Number(order.amount_paid_cents ?? 0) < Number(order.total_cents)) throw ApiError.invalidRequest('Only an order that is still waiting for payment can have a schedule.');
  if (Number(order.amount_paid_cents ?? 0) >= Number(order.total_cents)) throw ApiError.invalidRequest('This order is already fully paid.');
  const next = buildStages(Number(order.total_cents), input);
  const [had] = await db.query<any>(`SELECT order_id FROM ms_schedules WHERE order_id = ?`, [orderId]);
  const old = withState(await stagesOf(db, orderId), Number(order.amount_paid_cents ?? 0));
  const locked = old.filter((s) => s.status === 'paid');
  // Money already received also fills the first stages of a brand new schedule; those stages are then paid, which is fine.
  for (const s of locked) {
    const n = next[s.pos - 1];
    if (!n || n.amount_cents !== s.amount_cents) throw ApiError.conflict(`Stage ${s.pos} ("${s.label}") is already paid and cannot change.`);
  }
  const ts = now();
  await db.run(`DELETE FROM ms_stages WHERE order_id = ?`, [orderId]);
  for (let i = 0; i < next.length; i++) {
    const o = old.find((x) => x.pos === i + 1);
    // A requested stage keeps its request when nothing about its amount changed.
    const requested = o && o.amount_cents === next[i].amount_cents ? o.requested_at : null;
    await db.run(`INSERT INTO ms_stages (id, order_id, pos, label, amount_cents, expected_on, requested_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [uuid(), orderId, i + 1, next[i].label, next[i].amount_cents, next[i].expected_on, requested, ts]);
  }
  await db.run(`INSERT INTO ms_schedules (order_id, note, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`, [orderId, note, ts, ts]);
  // Changing a schedule the customer may already know about: tell them.
  let notified = false;
  if (had && (locked.length > 0 || old.some((s) => s.requested_at))) notified = await sendMail(db, ctx, order, 'changed');
  return { created: !had, notified };
}

export async function removeSchedule(db: Database, orderId: string): Promise<void> {
  await db.run(`DELETE FROM ms_stages WHERE order_id = ?`, [orderId]);
  await db.run(`DELETE FROM ms_schedules WHERE order_id = ?`, [orderId]);
}

/** Ask for the next unpaid stage: it becomes "due" and the customer gets the schedule with its pay link. */
export async function requestStage(db: Database, ctx: Ctx, orderId: string, send = true): Promise<{ pos: number; amount_cents: number; pay_url: string; emailed: boolean }> {
  const order = await getOrder(db, orderId);
  if (order.status === 'canceled' || order.status === 'refunded') throw ApiError.invalidRequest(`The order is ${order.status}.`);
  const v = await view(db, order);
  if (!v) throw ApiError.notFound('This order has no schedule');
  const stage = v.stages.find((s) => s.status !== 'paid');
  if (!stage) throw ApiError.invalidRequest('Every stage is already paid.');
  if (stage.status === 'upcoming') await db.run(`UPDATE ms_stages SET requested_at = ? WHERE id = ?`, [now(), stage.id]);
  const token = await ensurePayToken(db, order);
  const url = payUrl(ctx.storeBaseUrl, order.locale, token);
  const emailed = send ? await sendMail(db, ctx, await getOrder(db, orderId), 'request') : false;
  return { pos: stage.pos, amount_cents: stage.remaining_cents, pay_url: url, emailed };
}

export type Ctx = { storeBaseUrl: string; storeName: string };
const T = {
  fr: {
    request: { subject: (n: string, o: string) => `${n} : paiement de l’étape « ${o} »`, head: 'Une étape de paiement est à régler', body: (label: string, amt: string, num: string) => `L’étape « ${label} » de votre commande ${num} est atteinte : ${amt} à régler.` },
    changed: { subject: (n: string) => `${n} : calendrier de paiement modifié`, head: 'Votre calendrier de paiement a changé', body: (_l: string, _a: string, num: string) => `Le calendrier de paiement de votre commande ${num} a été modifié. Voici la version à jour.` },
    cols: { stage: 'Étape', amount: 'Montant', state: 'État', expected: 'Prévue' }, state: { paid: 'Payée', due: 'À régler', upcoming: 'À venir' }, pay: 'Payer cette étape', later: 'Vous recevrez un lien de paiement à chaque étape atteinte.', total: 'Total',
  },
  en: {
    request: { subject: (n: string, o: string) => `${n}: payment for “${o}”`, head: 'A payment stage is due', body: (label: string, amt: string, num: string) => `The stage “${label}” of your order ${num} has been reached: ${amt} is due.` },
    changed: { subject: (n: string) => `${n}: payment schedule updated`, head: 'Your payment schedule changed', body: (_l: string, _a: string, num: string) => `The payment schedule of your order ${num} was updated. Here is the current version.` },
    cols: { stage: 'Stage', amount: 'Amount', state: 'Status', expected: 'Expected' }, state: { paid: 'Paid', due: 'Due now', upcoming: 'Upcoming' }, pay: 'Pay this stage', later: 'You will receive a payment link when each stage is reached.', total: 'Total',
  },
};
export function scheduleHtml(v: NonNullable<Awaited<ReturnType<typeof view>>>, l: 'fr' | 'en'): string {
  const t = T[l];
  const rows = v.stages.map((s) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee">${s.pos}. ${esc(s.label)}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${esc(money(s.amount_cents, v.currency, l))}</td><td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(t.state[s.status])}${s.expected_on && s.status !== 'paid' ? `<br><span style="color:#888;font-size:12px">${esc(t.cols.expected)} ${esc(dateOf(s.expected_on, l))}</span>` : ''}</td></tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="text-align:left;color:#666"><th style="padding:6px 8px">${esc(t.cols.stage)}</th><th style="padding:6px 8px;text-align:right">${esc(t.cols.amount)}</th><th style="padding:6px 8px">${esc(t.cols.state)}</th></tr>${rows}<tr><td style="padding:6px 8px"><strong>${esc(t.total)}</strong></td><td style="padding:6px 8px;text-align:right"><strong>${esc(money(v.total_cents, v.currency, l))}</strong></td><td></td></tr></table>`;
}
export function scheduleText(v: NonNullable<Awaited<ReturnType<typeof view>>>, l: 'fr' | 'en'): string {
  const t = T[l];
  return v.stages.map((s) => `${s.pos}. ${s.label} — ${money(s.amount_cents, v.currency, l)} — ${t.state[s.status]}${s.expected_on && s.status !== 'paid' ? ` (${dateOf(s.expected_on, l)})` : ''}`).join('\n');
}
async function sendMail(db: Database, ctx: Ctx, order: any, kind: 'request' | 'changed'): Promise<boolean> {
  if (!usable(order.customer_email)) return false;
  try {
    const provider = await getEmailProvider(db); if (!provider) return false;
    const v = await view(db, order); if (!v) return false;
    const l = lang(order.locale); const t = T[l]; const k = t[kind];
    const stage = v.stages.find((s) => s.status === 'due') ?? v.stages.find((s) => s.status !== 'paid');
    const url = kind === 'request' && order.pay_token ? payUrl(ctx.storeBaseUrl, l, order.pay_token) : null;
    const body = kind === 'request' ? t.request.body(stage?.label ?? '', money(stage?.remaining_cents ?? 0, v.currency, l), order.number) : t.changed.body('', '', order.number);
    const subject = kind === 'request' ? t.request.subject(ctx.storeName, stage?.label ?? '') : t.changed.subject(ctx.storeName);
    const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:16px;color:#2B2B2B"><h2 style="margin:0 0 12px">${esc(k.head)}</h2><p>${esc(body)}</p>${scheduleHtml(v, l)}${url ? `<p><a href="${esc(url)}" style="display:inline-block;background:#0F6B4B;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px">${esc(t.pay)}</a></p>` : ''}<p style="font-size:13px;color:#666">${esc(t.later)}</p><p style="font-size:12px;color:#999">${esc(ctx.storeName)}</p></div>`;
    const text = `${k.head}\n\n${body}\n\n${scheduleText(v, l)}\n${url ? `\n${t.pay}: ${url}\n` : ''}\n${t.later}\n${ctx.storeName}`;
    await provider.send({ to: order.customer_email, subject, html, text });
    return true;
  } catch (e) { console.error('[milestones] e-mail failed', e); return false; }
}
