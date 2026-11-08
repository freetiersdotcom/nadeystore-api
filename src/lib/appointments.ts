import type { Database } from '../db';
import { ApiError, uuid, now } from '../types';
import { getEmailProvider } from './email/index';
import { renderApptEmail, type ApptEmailKind } from './email/apptNotice';

// =============================================================================
// Appointments for service products
//
//  - A service product becomes bookable when it has a row in booking_services (weekly hours,
//    lead time, horizon, buffer, step, and a duration per variant). Services without a row keep
//    the old behaviour: the order is flagged 'to_schedule' and the merchant calls the customer.
//  - Providers (booking_resources): one 'default' provider exists from the start, so a single coach needs
//    no setup. Each provider has its own agenda (a person is never booked twice) and optional own weekly
//    hours; a service can be limited to some providers (none chosen = all active ones). A customer who
//    does not choose is given the least busy free provider of that day.
//  - The customer picks a slot in the cart; at checkout the slot is HELD (a few minutes, extended
//    once payment starts). createOrderFromCart turns the hold into a booking, whatever the payment
//    provider or method (online, deposit, pay on delivery).
//  - All instants are stored as UTC ISO strings (always toISOString(), so string comparison works).
//    Weekly hours are expressed in the service's own timezone (default Africa/Porto-Novo).
// =============================================================================

export const DEFAULT_TZ = 'Africa/Porto-Novo';
export const HOLD_MINUTES = 30;          // hold while the customer fills in the cart / starts payment
export const PAYMENT_HOLD_MINUTES = 90;  // extended once the provider checkout starts
export const REMINDER_WINDOW_H = 30;     // daily cron: remind when the session starts within this many hours
export const MAX_RANGE_DAYS = 45;

export interface Rule { dow: number; start: string; end: string }   // dow 0 = Sunday … 6 = Saturday, "HH:MM"
export interface BookingConfig {
  product_id: string;
  enabled: boolean;
  tz: string;
  rules: Rule[];
  lead_hours: number;
  horizon_days: number;
  buffer_min: number;
  step_min: number;
  default_duration_min: number;
  durations: Record<string, number>;   // sku -> minutes
}

// ───────────────────────── time zones ─────────────────────────

function partsIn(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

/** local − UTC, in ms, at that instant */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = partsIn(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time in tz -> UTC ms. Returns null when that wall time does not exist (DST gap). */
export function zonedToUtcMs(y: number, mo: number, d: number, hh: number, mm: number, tz: string): number | null {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  let ms = guess - tzOffsetMs(guess, tz);
  ms = guess - tzOffsetMs(ms, tz);
  const p = partsIn(ms, tz);
  return p.hour === hh && p.minute === mm && p.day === d ? ms : null;
}

export function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const hm = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 24 && mi < 60 && h * 60 + mi <= 1440 ? h * 60 + mi : null;
};

export function cleanRules(input: unknown): Rule[] {
  if (!Array.isArray(input)) return [];
  const out: Rule[] = [];
  for (const r of input) {
    const dow = Number(r?.dow), a = hm(String(r?.start ?? '')), b = hm(String(r?.end ?? ''));
    if (Number.isInteger(dow) && dow >= 0 && dow <= 6 && a != null && b != null && b > a) {
      out.push({ dow, start: String(r.start).padStart(5, '0'), end: String(r.end).padStart(5, '0') });
    }
  }
  return out;
}

// ───────────────────────── slot generation (pure) ─────────────────────────

export interface Candidate { startMs: number; endMs: number }

/** Every start the weekly hours allow in [fromMs, toMs], honouring lead time and horizon. */
export function generateCandidates(cfg: BookingConfig, durationMin: number, fromMs: number, toMs: number, nowMs: number): Candidate[] {
  const out: Candidate[] = [];
  const earliest = Math.max(fromMs, nowMs + cfg.lead_hours * 3600_000);
  const latest = Math.min(toMs, nowMs + cfg.horizon_days * 86400_000);
  if (latest < earliest || cfg.rules.length === 0 || durationMin <= 0) return out;
  const step = Math.max(cfg.step_min, 5);
  // walk shop-local calendar days, starting one day early to be safe around midnight
  const p0 = partsIn(earliest - 86400_000, cfg.tz);
  let day = Date.UTC(p0.year, p0.month - 1, p0.day);
  const lastDay = Date.UTC(...(() => { const p = partsIn(latest + 86400_000, cfg.tz); return [p.year, p.month - 1, p.day] as [number, number, number]; })());
  for (; day <= lastDay; day += 86400_000) {
    const dt = new Date(day);
    const dow = dt.getUTCDay();
    for (const r of cfg.rules) {
      if (r.dow !== dow) continue;
      const a = hm(r.start)!, b = hm(r.end)!;
      for (let t = a; t + durationMin <= b; t += step) {
        const s = zonedToUtcMs(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), Math.floor(t / 60), t % 60, cfg.tz);
        if (s == null || s < earliest || s > latest) continue;
        out.push({ startMs: s, endMs: s + durationMin * 60_000 });
      }
    }
  }
  return out.sort((x, y) => x.startMs - y.startMs).filter((c, i, arr) => i === 0 || c.startMs !== arr[i - 1].startMs);
}

// ───────────────────────── config ─────────────────────────

export async function getBookingConfig(db: Database, productId: string): Promise<BookingConfig | null> {
  const [r] = await db.query<any>(`SELECT * FROM booking_services WHERE product_id = ?`, [productId]);
  if (!r) return null;
  let rules: Rule[] = [], durations: Record<string, number> = {};
  try { rules = cleanRules(JSON.parse(r.rules ?? '[]')); } catch { /* none */ }
  try { durations = JSON.parse(r.durations ?? '{}') ?? {}; } catch { /* none */ }
  return {
    product_id: productId, enabled: !!r.enabled, tz: r.tz || DEFAULT_TZ, rules,
    lead_hours: Number(r.lead_hours ?? 24), horizon_days: Number(r.horizon_days ?? 60),
    buffer_min: Number(r.buffer_min ?? 0), step_min: Number(r.step_min ?? 30),
    default_duration_min: Number(r.default_duration_min ?? 60), durations,
  };
}

export interface BookableSku { sku: string; title: string; product_id: string; cfg: BookingConfig; duration_min: number }

/** The booking setup of a service SKU, or null when it is not bookable (not a service, or no/disabled config). */
export async function bookableSku(db: Database, sku: string): Promise<BookableSku | null> {
  const [v] = await db.query<any>(
    `SELECT v.sku, v.product_id, v.product_type, p.title AS product_title, v.title AS variant_title
     FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ? LIMIT 1`, [sku]);
  if (!v || v.product_type !== 'service') return null;
  const cfg = await getBookingConfig(db, v.product_id);
  if (!cfg || !cfg.enabled) return null;
  const d = Number(cfg.durations[sku] ?? cfg.default_duration_min);
  return { sku, title: v.product_title, product_id: v.product_id, cfg, duration_min: d > 0 ? d : cfg.default_duration_min };
}

// ───────────────────────── availability ─────────────────────────

export const RESOURCE = 'default';
const iso = (ms: number) => new Date(ms).toISOString();

export interface Provider { id: string; name: string; active: boolean; position: number; tz: string | null; rules: Rule[] }

function toProvider(r: any): Provider {
  let rules: Rule[] = [];
  try { rules = cleanRules(JSON.parse(r.rules ?? '[]')); } catch { /* none */ }
  return { id: r.id, name: r.name, active: !!r.active, position: Number(r.position ?? 0), tz: r.tz ?? null, rules };
}

export async function listProviders(db: Database): Promise<Provider[]> {
  const rows = await db.query<any>(`SELECT * FROM booking_resources ORDER BY position, name`);
  return rows.map(toProvider);
}

/** Active providers that may perform this service: the ones assigned to it, or all active ones when none is assigned. */
export async function providersFor(db: Database, productId: string): Promise<Provider[]> {
  const rows = await db.query<any>(
    `SELECT r.* FROM booking_resources r WHERE r.active = 1
       AND (NOT EXISTS (SELECT 1 FROM booking_service_resources s WHERE s.product_id = ?)
            OR EXISTS (SELECT 1 FROM booking_service_resources s WHERE s.product_id = ? AND s.resource_id = r.id))
     ORDER BY r.position, r.name`, [productId, productId]);
  return rows.map(toProvider);
}

/** Is [startMs, endMs] inside the provider's own weekly hours? No hours set = always on (the service hours still apply). */
export function withinHours(p: Provider, serviceTz: string, startMs: number, endMs: number): boolean {
  if (p.rules.length === 0) return true;
  const w = partsIn(startMs, p.tz || serviceTz);
  const dow = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  const startMin = w.hour * 60 + w.minute, dur = Math.round((endMs - startMs) / 60000);
  return p.rules.some((r) => r.dow === dow && hm(r.start)! <= startMin && startMin + dur <= hm(r.end)!);
}

interface Busy { startMs: number; endMs: number }

async function busyByProvider(db: Database, productId: string, ids: string[], fromMs: number, toMs: number, bufferMin: number): Promise<Map<string, Busy[]>> {
  const out = new Map<string, Busy[]>(ids.map((i) => [i, []]));
  if (ids.length === 0) return out;
  const lo = iso(fromMs - bufferMin * 60_000 - 86400_000), hi = iso(toMs + bufferMin * 60_000 + 86400_000);
  const nowIso = now();
  const appts = await db.query<any>(
    `SELECT resource_id, starts_at, ends_at FROM appointments
     WHERE resource_id IN (${ids.map(() => '?').join(',')}) AND (status = 'booked' OR (status = 'held' AND hold_expires_at > ?))
       AND starts_at < ? AND ends_at > ?`, [...ids, nowIso, hi, lo]);
  const blocks = await db.query<any>(
    `SELECT resource_id, starts_at, ends_at FROM booking_blocks WHERE (product_id IS NULL OR product_id = ?) AND starts_at < ? AND ends_at > ?`,
    [productId, hi, lo]);
  const span = (r: any): Busy => ({ startMs: Date.parse(r.starts_at), endMs: Date.parse(r.ends_at) });
  for (const a of appts) out.get(a.resource_id)?.push(span(a));
  for (const k of blocks) for (const id of ids) if (k.resource_id == null || k.resource_id === id) out.get(id)!.push(span(k));
  return out;
}

export async function listSlots(db: Database, b: BookableSku, fromMs: number, days: number, nowMs = Date.now(), providerId?: string | null) {
  const toMs = fromMs + Math.min(Math.max(days, 1), MAX_RANGE_DAYS) * 86400_000;
  const cands = generateCandidates(b.cfg, b.duration_min, fromMs, toMs, nowMs);
  let providers = await providersFor(db, b.product_id);
  if (providerId && providerId !== 'any') providers = providers.filter((p) => p.id === providerId);
  const busy = await busyByProvider(db, b.product_id, providers.map((p) => p.id), fromMs, toMs, b.cfg.buffer_min);
  const buf = b.cfg.buffer_min * 60_000;
  return cands.map((c) => {
    const free = providers.filter((p) => withinHours(p, b.cfg.tz, c.startMs, c.endMs)
      && !busy.get(p.id)!.some((x) => x.startMs < c.endMs + buf && x.endMs > c.startMs - buf)).map((p) => p.id);
    return { start: iso(c.startMs), end: iso(c.endMs), available: free.length > 0, resource_ids: free };
  });
}

// ───────────────────────── holds ─────────────────────────

const OVERLAP_SQL = `NOT EXISTS (
    SELECT 1 FROM appointments a WHERE a.resource_id = ? AND a.id <> ?
      AND (a.status = 'booked' OR (a.status = 'held' AND a.hold_expires_at > ?))
      AND a.starts_at < ? AND a.ends_at > ?)
  AND NOT EXISTS (
    SELECT 1 FROM booking_blocks k WHERE (k.product_id IS NULL OR k.product_id = ?) AND (k.resource_id IS NULL OR k.resource_id = ?) AND k.starts_at < ? AND k.ends_at > ?)`;

function overlapParams(id: string, productId: string, resourceId: string, startMs: number, endMs: number, bufMin: number) {
  const hi = iso(endMs + bufMin * 60_000), lo = iso(startMs - bufMin * 60_000);
  return [resourceId, id, now(), hi, lo, productId, resourceId, hi, lo];
}

/** Hold a slot for a cart. Atomic: the overlap check and the insert are one statement. */
export async function holdSlot(db: Database, cartId: string, sku: string, startIso: string, customerTz?: string | null, providerId?: string | null) {
  const b = await bookableSku(db, sku);
  if (!b) throw ApiError.invalidRequest('This service cannot be booked online.');
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) throw ApiError.invalidRequest('Invalid start time.');
  const [cart] = await db.query<any>(`SELECT id, status FROM carts WHERE id = ?`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');
  if (cart.status !== 'open') throw ApiError.conflict('Cart is not open');
  const [line] = await db.query<any>(`SELECT qty FROM cart_items WHERE cart_id = ? AND sku = ?`, [cartId, sku]);
  if (!line) throw ApiError.invalidRequest('This service is not in the cart.');
  if (Number(line.qty) !== 1) throw ApiError.invalidRequest('Book one session at a time (quantity must be 1).');

  const ok = generateCandidates(b.cfg, b.duration_min, startMs, startMs, Date.now()).some((c) => c.startMs === startMs);
  if (!ok) throw ApiError.invalidRequest('This time is not bookable.', { code: 'slot_unavailable' });
  const endMs = startMs + b.duration_min * 60_000;

  let providers = (await providersFor(db, b.product_id)).filter((p) => withinHours(p, b.cfg.tz, startMs, endMs));
  if (providerId && providerId !== 'any') {
    providers = providers.filter((p) => p.id === providerId);
    if (providers.length === 0) throw ApiError.invalidRequest('This provider is not available for this service at this time.', { code: 'slot_unavailable' });
  }
  if (providers.length === 0) throw ApiError.invalidRequest('This time is not bookable.', { code: 'slot_unavailable' });
  // "any available": the provider with the fewest sessions that day goes first (ties: list order)
  if (providers.length > 1) {
    const day = iso(Math.floor(startMs / 86400_000) * 86400_000), dayEnd = iso(Math.floor(startMs / 86400_000) * 86400_000 + 86400_000);
    const load = new Map<string, number>();
    for (const p of providers) {
      const [n] = await db.query<any>(
        `SELECT COUNT(*) AS n FROM appointments WHERE resource_id = ? AND starts_at >= ? AND starts_at < ? AND (status = 'booked' OR (status = 'held' AND hold_expires_at > ?))`,
        [p.id, day, dayEnd, now()]);
      load.set(p.id, Number(n?.n ?? 0));
    }
    providers.sort((x, y) => (load.get(x.id)! - load.get(y.id)!) || (x.position - y.position));
  }

  await db.run(`UPDATE appointments SET status = 'canceled', canceled_at = ? WHERE cart_id = ? AND sku = ? AND status = 'held'`, [now(), cartId, sku]);
  const id = uuid();
  for (const p of providers) {
    const r = await db.run(
      `INSERT INTO appointments (id, resource_id, product_id, sku, title, cart_id, status, starts_at, ends_at, customer_tz, hold_expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ? WHERE ${OVERLAP_SQL}`,
      [id, p.id, b.product_id, sku, b.title, cartId, iso(startMs), iso(endMs), customerTz ?? null,
       iso(Date.now() + HOLD_MINUTES * 60_000), now(), ...overlapParams(id, b.product_id, p.id, startMs, endMs, b.cfg.buffer_min)]);
    if (r.changes > 0) return { id, start: iso(startMs), end: iso(endMs), hold_expires_at: iso(Date.now() + HOLD_MINUTES * 60_000), resource_id: p.id, provider: p.name };
  }
  throw new ApiError('slot_taken', 409, 'This time was just taken. Please choose another.');
}

export async function releaseHold(db: Database, cartId: string, sku?: string) {
  await db.run(
    `UPDATE appointments SET status = 'canceled', canceled_at = ? WHERE cart_id = ? AND status = 'held' ${sku ? 'AND sku = ?' : ''}`,
    sku ? [now(), cartId, sku] : [now(), cartId]);
}

/**
 * Checkout gate (called from prepareCheckout): every bookable service line must carry a live hold.
 * Extends the holds so they survive the payment page.
 */
export async function assertBookingsReady(db: Database, cartId: string, items: Array<{ sku: string; qty: number }>) {
  for (const it of items) {
    const b = await bookableSku(db, it.sku);
    if (!b) continue;
    if (it.qty !== 1) throw new ApiError('invalid_request', 400, 'Book one session at a time.', { sku: it.sku, code: 'qty' });
    const [h] = await db.query<any>(
      `SELECT id FROM appointments WHERE cart_id = ? AND sku = ? AND status = 'held' AND hold_expires_at > ?`, [cartId, it.sku, now()]);
    if (!h) throw new ApiError('slot_required', 409, 'Please choose a time slot for this service.', { sku: it.sku });
  }
  await db.run(
    `UPDATE appointments SET hold_expires_at = ? WHERE cart_id = ? AND status = 'held' AND hold_expires_at > ?`,
    [iso(Date.now() + PAYMENT_HOLD_MINUTES * 60_000), cartId, now()]);
}

// ───────────────────────── booking at order creation ─────────────────────────

export interface BookedAppt { id: string; title: string; sku: string; starts_at: string; ends_at: string; customer_tz: string | null }

/** Turns the cart's holds into bookings. A hold that expired and whose slot was taken meanwhile is reported as lost. */
export async function confirmBookings(db: Database, cartId: string, orderId: string): Promise<{ booked: BookedAppt[]; lost: BookedAppt[] }> {
  const rows = await db.query<any>(`SELECT * FROM appointments WHERE cart_id = ? AND status = 'held'`, [cartId]);
  const booked: BookedAppt[] = [], lost: BookedAppt[] = [];
  for (const a of rows) {
    const cfg = await getBookingConfig(db, a.product_id);
    const buf = cfg?.buffer_min ?? 0;
    const r = await db.run(
      `UPDATE appointments SET status = 'booked', order_id = ?, hold_expires_at = NULL
       WHERE id = ? AND status = 'held'
         AND (hold_expires_at > ? OR (${OVERLAP_SQL}))`,
      [orderId, a.id, now(), ...overlapParams(a.id, a.product_id, a.resource_id, Date.parse(a.starts_at), Date.parse(a.ends_at), buf)]);
    const view: BookedAppt = { id: a.id, title: a.title, sku: a.sku, starts_at: a.starts_at, ends_at: a.ends_at, customer_tz: a.customer_tz };
    if (r.changes > 0) booked.push(view);
    else {
      await db.run(`UPDATE appointments SET status = 'canceled', canceled_at = ?, order_id = ? WHERE id = ?`, [now(), orderId, a.id]);
      lost.push(view);
    }
  }
  return { booked, lost };
}

export async function cancelOrderAppointments(db: Database, orderId: string) {
  await db.run(`UPDATE appointments SET status = 'canceled', canceled_at = ? WHERE order_id = ? AND status = 'booked'`, [now(), orderId]);
}

// ───────────────────────── emails ─────────────────────────

export interface ApptNoticeCtx { storeName: string; storeBaseUrl: string }

export async function sendApptEmail(db: Database, appt: any, kind: ApptEmailKind, ctx: ApptNoticeCtx, previousStart?: string) {
  try {
    const provider = await getEmailProvider(db);
    if (!provider) return;
    const [o] = await db.query<any>(`SELECT number, customer_email, locale FROM orders WHERE id = ?`, [appt.order_id]);
    if (!o) return;
    const cfg = await getBookingConfig(db, appt.product_id);
    const mail = renderApptEmail(kind, {
      store_name: ctx.storeName, order_number: o.number, title: appt.title,
      starts_at: appt.starts_at, ends_at: appt.ends_at, tz: cfg?.tz ?? DEFAULT_TZ, customer_tz: appt.customer_tz,
      previous_start: previousStart,
    }, o.locale === 'en' ? 'en' : 'fr');
    await provider.send({ to: o.customer_email, ...mail });
  } catch (e: any) {
    console.error(`[appointments] email '${kind}' failed: ${e.message}`);
  }
}

/** Daily cron: remind about upcoming sessions, drop stale holds. Idempotent. */
export async function sweepAppointments(db: Database, ctx: ApptNoticeCtx) {
  await db.run(`DELETE FROM appointments WHERE status = 'held' AND hold_expires_at < ?`, [iso(Date.now() - 2 * 86400_000)]);
  const rows = await db.query<any>(
    `SELECT a.* FROM appointments a JOIN orders o ON o.id = a.order_id
     WHERE a.status = 'booked' AND a.reminder_sent_at IS NULL AND a.starts_at > ? AND a.starts_at <= ? AND o.status <> 'canceled'`,
    [now(), iso(Date.now() + REMINDER_WINDOW_H * 3600_000)]);
  let reminded = 0;
  for (const a of rows) {
    const claim = await db.run(`UPDATE appointments SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL`, [now(), a.id]);
    if (claim.changes === 0) continue;
    await sendApptEmail(db, a, 'reminder', ctx);
    reminded++;
  }
  return { reminded };
}

// ───────────────────────── admin actions ─────────────────────────

/** Book (or move) an appointment for an existing order. Admin may pick any free time, even outside the weekly hours. */
export async function adminSchedule(db: Database, opts: { appointmentId?: string; orderId?: string; sku?: string; startIso: string; durationMin?: number; resourceId?: string | null }) {
  const startMs = Date.parse(opts.startIso);
  if (!Number.isFinite(startMs)) throw ApiError.invalidRequest('Invalid start time.');
  let appt: any = null;
  if (opts.appointmentId) {
    [appt] = await db.query<any>(`SELECT * FROM appointments WHERE id = ?`, [opts.appointmentId]);
    if (!appt) throw ApiError.notFound('Appointment not found');
    if (appt.status !== 'booked') throw ApiError.conflict('Only a booked appointment can be moved.');
  }
  let productId: string, sku: string, title: string, orderId: string, customerTz: string | null = null, duration: number;
  if (appt) {
    productId = appt.product_id; sku = appt.sku; title = appt.title; orderId = appt.order_id; customerTz = appt.customer_tz;
    duration = Math.round((Date.parse(appt.ends_at) - Date.parse(appt.starts_at)) / 60000);
  } else {
    if (!opts.orderId) throw ApiError.invalidRequest('order_id is required.');
    const [o] = await db.query<any>(`SELECT id, status FROM orders WHERE id = ?`, [opts.orderId]);
    if (!o) throw ApiError.notFound('Order not found');
    if (o.status === 'canceled') throw ApiError.conflict('This order is canceled.');
    const lines = await db.query<any>(
      `SELECT oi.sku, v.product_id, p.title FROM order_items oi JOIN variants v ON v.sku = oi.sku JOIN products p ON p.id = v.product_id
       WHERE oi.order_id = ? AND v.product_type = 'service'`, [opts.orderId]);
    const line = opts.sku ? lines.find((l: any) => l.sku === opts.sku) : lines[0];
    if (!line) throw ApiError.invalidRequest('This order has no service line.');
    const [dup] = await db.query<any>(`SELECT id FROM appointments WHERE order_id = ? AND sku = ? AND status = 'booked'`, [opts.orderId, line.sku]);
    if (dup) throw ApiError.conflict('This order already has a booked appointment; move it instead.');
    const cfg = await getBookingConfig(db, line.product_id);
    productId = line.product_id; sku = line.sku; title = line.title; orderId = opts.orderId;
    duration = opts.durationMin ?? Number(cfg?.durations?.[line.sku] ?? cfg?.default_duration_min ?? 60);
  }
  const cfg = await getBookingConfig(db, productId);
  const endMs = startMs + duration * 60_000;
  const id = appt?.id ?? uuid();
  if (opts.resourceId) {
    const [pr] = await db.query<any>(`SELECT id FROM booking_resources WHERE id = ?`, [opts.resourceId]);
    if (!pr) throw ApiError.invalidRequest('Unknown provider.');
  }
  const taken = () => new ApiError('slot_taken', 409, 'That time overlaps another booking or a blocked period for this provider.');
  if (appt) {
    const res = opts.resourceId ?? appt.resource_id;
    const r = await db.run(
      `UPDATE appointments SET starts_at = ?, ends_at = ?, resource_id = ?, reminder_sent_at = NULL WHERE id = ? AND status = 'booked' AND ${OVERLAP_SQL}`,
      [iso(startMs), iso(endMs), res, id, ...overlapParams(id, productId, res, startMs, endMs, cfg?.buffer_min ?? 0)]);
    if (r.changes === 0) throw taken();
  } else {
    // a chosen provider, or the first provider of this service who is free at that time
    const candidates = opts.resourceId ? [opts.resourceId] : (await providersFor(db, productId)).map((p) => p.id);
    if (candidates.length === 0) throw ApiError.conflict('No active provider is assigned to this service.');
    let done = false;
    for (const res of candidates) {
      const r = await db.run(
        `INSERT INTO appointments (id, resource_id, product_id, sku, title, order_id, status, starts_at, ends_at, customer_tz, created_at)
         SELECT ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ? WHERE ${OVERLAP_SQL}`,
        [id, res, productId, sku, title, orderId, iso(startMs), iso(endMs), customerTz, now(), ...overlapParams(id, productId, res, startMs, endMs, cfg?.buffer_min ?? 0)]);
      if (r.changes > 0) { done = true; break; }
    }
    if (!done) throw taken();
  }
  await db.run(`UPDATE orders SET service_status = 'scheduled' WHERE id = ? AND service_status IN ('to_schedule', 'scheduled')`, [orderId]);
  const [row] = await db.query<any>(`SELECT * FROM appointments WHERE id = ?`, [id]);
  return { appt: row, previousStart: appt?.starts_at as string | undefined };
}

export async function adminCancel(db: Database, appointmentId: string) {
  const [a] = await db.query<any>(`SELECT * FROM appointments WHERE id = ?`, [appointmentId]);
  if (!a) throw ApiError.notFound('Appointment not found');
  if (a.status !== 'booked') throw ApiError.conflict('Only a booked appointment can be canceled.');
  await db.run(`UPDATE appointments SET status = 'canceled', canceled_at = ? WHERE id = ?`, [now(), appointmentId]);
  const [left] = await db.query<any>(`SELECT id FROM appointments WHERE order_id = ? AND status = 'booked' LIMIT 1`, [a.order_id]);
  if (!left) await db.run(`UPDATE orders SET service_status = 'to_schedule' WHERE id = ? AND service_status = 'scheduled'`, [a.order_id]);
  return a;
}
