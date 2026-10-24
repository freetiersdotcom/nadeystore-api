import type { Database } from '../db';
import { uuid, now } from '../types';

// =============================================================================
// Order payments ledger
//
// An order has a total and a list of payments (order_payments). What the
// customer has paid is amount_paid_cents; the balance is total - paid.
// Online orders get one 'online' payment when the provider confirms; pay-on-
// delivery, cash and manual orders collect payments over time.
// =============================================================================

export type PaymentMethod = 'online' | 'cash' | 'mobile_money' | 'bank_transfer' | 'card' | 'other';
export const MANUAL_PAYMENT_METHODS = ['cash', 'mobile_money', 'bank_transfer', 'card', 'other'] as const;
export type PaymentStatus = 'unpaid' | 'partial' | 'paid';

export function paymentState(order: { total_cents: number; amount_paid_cents?: number | null }) {
  const paid = Number(order.amount_paid_cents ?? 0);
  const total = Number(order.total_cents);
  const status: PaymentStatus = paid >= total ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  return { paid_cents: paid, balance_cents: Math.max(total - paid, 0), payment_status: status };
}

export interface RecordPaymentInput {
  amount_cents: number;
  method: PaymentMethod;
  reference?: string | null;
  note?: string | null;
}

/**
 * Adds a payment to an order and updates its totals. Caller has already
 * validated the amount (>0, <= balance). When the balance reaches zero the
 * order gets paid_at, and a still-'pending' order moves to 'paid'.
 */
export async function recordPayment(db: Database, order: any, input: RecordPaymentInput) {
  const id = uuid();
  await db.run(
    `INSERT INTO order_payments (id, order_id, amount_cents, method, reference, note) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, order.id, input.amount_cents, input.method, input.reference ?? null, input.note ?? null]
  );

  const newPaid = Number(order.amount_paid_cents ?? 0) + input.amount_cents;
  const complete = newPaid >= Number(order.total_cents);
  const sets = ['amount_paid_cents = ?'];
  const params: unknown[] = [newPaid];
  if (complete) {
    sets.push('paid_at = ?');
    params.push(now());
    if (order.status === 'pending') sets.push(`status = 'paid'`);
  }
  params.push(order.id);
  await db.run(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, params);

  return { id, amount_paid_cents: newPaid, complete };
}
