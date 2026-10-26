import type { Database } from '../db';
import type { DOStub } from '../types';
import { uuid, now } from '../types';
import { getEmailProvider } from './email/index';
import { fmtMoney, fmtDate, payUrl, renderPlanEmail, type PlanEmailKind } from './email/planNotice';
import { recordPayment, paymentState } from './payments';
import { createOrderFromCart, type OrderContext } from './orders';
import { releaseOfflineOrder } from '../routes/orders';
import { providerAvailable, type ChargeRequest, type PaymentProvider, type ProviderEnv } from './providers';
import { minorFactor } from './currency';
import { cancelOrderAppointments } from './appointments';

// =============================================================================
// Deposits and installments
//
//  - Per product: deposit_type ('percent' | 'fixed') + deposit_value. Percent is 1-99;
//    fixed is an amount in minor units (same unit as price_cents), per unit sold.
//  - A deposit order is a normal offline order (status 'pending', stock decremented at
//    the first payment) whose first payment is the deposit. The rest is collected as
//    payments of any amount, any number of times: online through the pay link, or
//    recorded by the merchant (cash, mobile money...).
//  - due_at is the date the balance is expected. The daily cron (sweepPlans) sends one
//    reminder, and — only if the merchant switched "auto-cancel" on — cancels pending
//    orders that are still unpaid grace_days after due_at. The merchant can always
//    cancel by hand; releasing stock works the same way for both.
// =============================================================================

export interface PlanSettings {
  auto_cancel: boolean;       // cancel overdue orders automatically (default off: merchant decides)
  due_days: number;           // days given to settle the balance after the deposit
  grace_days: number;         // extra days after due_at before auto-cancel
  reminder_days: number;      // send the reminder this many days before due_at (0 = no reminder)
  min_payment_cents: number;  // smallest online installment (the final balance is always allowed)
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  auto_cancel: false, due_days: 14, grace_days: 3, reminder_days: 3, min_payment_cents: 0,
};

export async function getPlanSettings(db: Database): Promise<PlanSettings> {
  const [row] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'payment_plans'`);
  let saved: Partial<PlanSettings> = {};
  try { saved = row?.value ? JSON.parse(row.value) : {}; } catch { /* use defaults */ }
  const int = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);
  return {
    auto_cancel: saved.auto_cancel === true,
    due_days: Math.max(int(saved.due_days, DEFAULT_PLAN_SETTINGS.due_days), 1),
    grace_days: int(saved.grace_days, DEFAULT_PLAN_SETTINGS.grace_days),
    reminder_days: int(saved.reminder_days, DEFAULT_PLAN_SETTINGS.reminder_days),
    min_payment_cents: int(saved.min_payment_cents, DEFAULT_PLAN_SETTINGS.min_payment_cents),
  };
}

export async function savePlanSettings(db: Database, s: PlanSettings) {
  await db.run(
    `INSERT INTO config (key, value) VALUES ('payment_plans', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(s)]
  );
}

export function addDays(iso: string | Date, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function newPayToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function storeBase(env: { STORE_URL?: string; IMAGES_URL?: string }): string {
  return env.STORE_URL ?? (env.IMAGES_URL ? new URL(env.IMAGES_URL).origin : 'https://yourstore.com');
}

export { payUrl };

/** Returns the order's pay token, creating it if needed. */
export async function ensurePayToken(db: Database, order: { id: string; pay_token?: string | null }): Promise<string> {
  if (order.pay_token) return order.pay_token;
  const token = newPayToken();
  await db.run(`UPDATE orders SET pay_token = ? WHERE id = ? AND pay_token IS NULL`, [token, order.id]);
  const [row] = await db.query<{ pay_token: string }>(`SELECT pay_token FROM orders WHERE id = ?`, [order.id]);
  return row.pay_token;
}

// ── Deposit calculation ──────────────────────────────────────────────────────

export interface DepositQuote {
  eligible: boolean;
  reason?: 'no_deposit_product' | 'digital' | 'no_provider' | 'not_less_than_total';
  total_cents: number;
  deposit_cents: number;
  balance_cents: number;
  currency: string;
  due_days: number;
}

export async function computeDeposit(
  db: Database,
  env: ProviderEnv,
  items: Array<{ sku: string; qty: number; unit_price_cents: number }>,
  subtotalCents: number,
  totalCents: number,
  currency: string,
  shippingCents = 0   // delivery is part of the balance: the deposit itself comes from the goods only
): Promise<DepositQuote> {
  const settings = await getPlanSettings(db);
  const base = { total_cents: totalCents + shippingCents, deposit_cents: 0, balance_cents: totalCents + shippingCents, currency, due_days: settings.due_days };
  if (!(await providerAvailable(db, env, currency))) return { ...base, eligible: false, reason: 'no_provider' };

  let raw = 0;
  let hasDepositProduct = false;
  let dueDays = Infinity;   // shortest balance period among the deposit products in the cart
  const ownDays = (r: { deposit_due_days: number | null } | undefined) =>
    Number(r?.deposit_due_days) > 0 ? Number(r!.deposit_due_days) : settings.due_days;
  for (const it of items) {
    const [row] = await db.query<{ deposit_type: string | null; deposit_value: number | null; deposit_due_days: number | null; product_type: string }>(
      `SELECT p.deposit_type, p.deposit_value, p.deposit_due_days, v.product_type
         FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ? LIMIT 1`,
      [it.sku]
    );
    if (row?.product_type === 'digital') return { ...base, eligible: false, reason: 'digital' };
    const line = it.unit_price_cents * it.qty;
    const value = Number(row?.deposit_value ?? 0);
    if (row?.deposit_type === 'percent' && value > 0) {
      hasDepositProduct = true;
      dueDays = Math.min(dueDays, ownDays(row));
      raw += Math.ceil((line * value) / 100);
    } else if (row?.deposit_type === 'fixed' && value > 0) {
      hasDepositProduct = true;
      dueDays = Math.min(dueDays, ownDays(row));
      raw += Math.min(value * it.qty, line);
    } else {
      raw += line;           // products without a deposit setting are paid in full up front
    }
  }
  if (!hasDepositProduct) return { ...base, eligible: false, reason: 'no_deposit_product' };

  // Scale for any cart discount so the deposit stays proportional to what is actually owed.
  const scaled = subtotalCents > 0 ? Math.ceil((raw * totalCents) / subtotalCents) : raw;
  const deposit = Math.max(1, Math.min(scaled, totalCents));
  if (deposit >= totalCents) return { ...base, eligible: false, reason: 'not_less_than_total' };
  return { ...base, due_days: Number.isFinite(dueDays) ? dueDays : settings.due_days, eligible: true, deposit_cents: deposit, balance_cents: totalCents + shippingCents - deposit };
}

/** Days to pay the balance of an order created from this cart: the shortest period set on its deposit products (store default when a product has none). */
export async function dueDaysForCart(db: Database, cartId: string, fallback: number): Promise<number> {
  const rows = await db.query<{ deposit_due_days: number | null }>(
    `SELECT p.deposit_due_days FROM cart_items ci
       JOIN variants v ON v.sku = ci.sku JOIN products p ON p.id = v.product_id
      WHERE ci.cart_id = ? AND p.deposit_type IS NOT NULL`, [cartId]);
  const days = rows.map((r) => (Number(r.deposit_due_days) > 0 ? Number(r.deposit_due_days) : fallback));
  return days.length > 0 ? Math.min(...days) : fallback;
}

// ── Emails ───────────────────────────────────────────────────────────────────

export interface NoticeCtx { storeBaseUrl: string; storeName: string }

export async function sendPlanEmail(
  db: Database, order: any, kind: PlanEmailKind, ctx: NoticeCtx, received?: number
) {
  try {
    const provider = await getEmailProvider(db);
    if (!provider) return;
    const loc = order.locale === 'en' ? 'en' : 'fr';
    const st = paymentState(order);
    let url: string | null = null;
    if (kind !== 'paid' && kind !== 'canceled') {
      url = payUrl(ctx.storeBaseUrl, loc, await ensurePayToken(db, order));
    }
    const mail = renderPlanEmail(kind, {
      store_name: ctx.storeName,
      order_number: order.number,
      received: received != null ? fmtMoney(received, order.currency, loc) : undefined,
      total: fmtMoney(order.total_cents, order.currency, loc),
      paid: fmtMoney(st.paid_cents, order.currency, loc),
      balance: fmtMoney(st.balance_cents, order.currency, loc),
      due: fmtDate(order.due_at, loc),
      pay_url: url,
    }, loc);
    await provider.send({ to: order.customer_email, ...mail });
  } catch (err: any) {
    console.error(`[plans] email '${kind}' failed for order ${order.number}: ${err.message}`);
  }
}

// ── Online payment of a balance ──────────────────────────────────────────────

/**
 * Records an online payment (confirmed by the provider) on an existing order.
 * Idempotent on `reference`. Money that arrives when it should not (order canceled,
 * or more than the balance) is still recorded, and the order is flagged for review so
 * the merchant refunds the difference.
 */
export async function receiveOnlinePayment(
  db: Database, orderId: string, amountCents: number, reference: string, ctx: NoticeCtx, provider = 'online'
) {
  const [dup] = await db.query<{ id: string }>(
    `SELECT id FROM order_payments WHERE order_id = ? AND reference = ? LIMIT 1`, [orderId, reference]
  );
  if (dup) return null;

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) { console.warn(`[plans] payment ${reference}: order ${orderId} not found`); return null; }

  const before = paymentState(order);
  const dead = order.status === 'canceled' || order.status === 'refunded';
  const over = amountCents > before.balance_cents;

  const res = await recordPayment(db, order, {
    amount_cents: amountCents, method: 'online', reference, note: `Online payment (${provider})`,
  });

  if (dead || over) {
    const why = dead
      ? `Payment of ${amountCents} received after the order was ${order.status}: refund it.`
      : `Payment of ${amountCents} exceeded the balance (${before.balance_cents}): refund the difference.`;
    await db.run(`UPDATE orders SET needs_review = 1, review_reason = ? WHERE id = ?`, [why, orderId]);
  }

  const [fresh] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!dead) await sendPlanEmail(db, fresh, res.complete ? 'paid' : 'payment', ctx, amountCents);
  return res;
}

// ── Charges: start and settle ────────────────────────────────────────────────

/** Creates a charge at the provider and remembers what it is for (deposit / balance payment). */
export async function startCharge(
  db: Database, env: ProviderEnv, provider: PaymentProvider, req: ChargeRequest
) {
  const r = await provider.createCharge(db, env, req);
  await db.run(
    `INSERT INTO payment_intents (provider, ref, kind, cart_id, order_id, amount_cents, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [provider.name, r.ref, req.kind, req.cartId, req.orderId ?? null, req.amountCents, req.currency.toUpperCase()]
  );
  return r;
}

/**
 * Called by every provider's webhook once a payment is confirmed. Drop-in for
 * createOrderFromCart(): looks up what the charge was for ('deposit', a 'payment'
 * toward an existing order, or nothing = a normal whole-cart checkout) and acts.
 */
export async function settleCharge(
  db: Database, stub: DOStub, ctx: ExecutionContext, cartId: string,
  provider: string, ref: string, orderCtx: OrderContext
) {
  let intent: { kind: string | null; amount_cents: number | null; order_id: string | null } | undefined;
  try {
    [intent] = await db.query(
      `SELECT kind, amount_cents, order_id FROM payment_intents WHERE provider = ? AND ref = ?`, [provider, ref]
    );
  } catch { /* table missing: treat as a normal checkout */ }

  const notice = { storeBaseUrl: orderCtx.storeBaseUrl, storeName: orderCtx.storeName };

  if (intent?.kind === 'payment' && intent.order_id && intent.amount_cents) {
    return receiveOnlinePayment(db, intent.order_id, intent.amount_cents, ref, notice, provider);
  }

  if (intent?.kind === 'deposit' && intent.amount_cents) {
    const settings = await getPlanSettings(db);
    return createOrderFromCart(db, stub, ctx, cartId, {
      ...orderCtx,
      paymentMethod: 'deposit',
      deposit: { amount_cents: intent.amount_cents, due_at: addDays(new Date(), await dueDaysForCart(db, cartId, settings.due_days)), pay_token: newPayToken() },
    });
  }

  return createOrderFromCart(db, stub, ctx, cartId, orderCtx);
}

export { minorFactor };

// ── Daily sweep ──────────────────────────────────────────────────────────────

const DAY = 86_400_000;

export async function sweepPlans(db: Database, ctx: NoticeCtx) {
  const s = await getPlanSettings(db);
  const nowMs = Date.now();
  const rows = await db.query<any>(
    `SELECT * FROM orders
      WHERE due_at IS NOT NULL AND amount_paid_cents < total_cents
        AND status NOT IN ('canceled', 'refunded')`
  );

  let reminded = 0, canceled = 0;
  for (const o of rows) {
    const dueMs = Date.parse(o.due_at);
    if (Number.isNaN(dueMs)) continue;

    if (s.auto_cancel && o.status === 'pending' && nowMs > dueMs + s.grace_days * DAY) {
      await releaseOfflineOrder(db as any, o);
      await db.run(`UPDATE orders SET status = 'canceled' WHERE id = ? AND status = 'pending'`, [o.id]);
      await cancelOrderAppointments(db, o.id);
      await sendPlanEmail(db, { ...o, status: 'canceled' }, 'canceled', ctx);
      canceled++;
      continue;
    }

    if (!o.reminder_sent_at && s.reminder_days > 0 && nowMs >= dueMs - s.reminder_days * DAY) {
      await db.run(`UPDATE orders SET reminder_sent_at = ? WHERE id = ?`, [now(), o.id]);
      await sendPlanEmail(db, o, nowMs > dueMs ? 'overdue' : 'reminder', ctx);
      reminded++;
    }
  }
  return { checked: rows.length, reminded, canceled };
}
