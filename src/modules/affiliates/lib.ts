import type { Database } from '../../db';
import { now } from '../../types';

export type AffiliateRow = {
  id: string; code: string; token: string; name: string; email: string | null; phone: string | null; rate_bp: number;
  status: 'active' | 'paused'; discount_code: string | null; note: string | null; created_at: string; updated_at: string;
};

export type CommissionState = 'awaiting_payment' | 'pending' | 'available' | 'canceled';
export type OrderCommission = {
  order_id: string; number: string; created_at: string; currency: string; via: string; rate_bp: number;
  base_cents: number; commission_cents: number; state: CommissionState;
};
export type Totals = { currency: string; available_cents: number; pending_cents: number; paid_out_cents: number; balance_cents: number; canceled_count: number; orders: number };

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}
export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const normCode = (s: string) => s.trim().toUpperCase();
export const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export const referralLink = (storeUrl: string | undefined, origin: string, code: string) =>
  `${(storeUrl || origin).replace(/\/+$/, '')}/?ref=${encodeURIComponent(code)}`;

export async function holdDays(db: Database): Promise<number> {
  const [r] = await db.query<{ hold_days: number }>(`SELECT hold_days FROM affiliate_settings WHERE id = 1`);
  return r?.hold_days ?? 14;
}

/**
 * Attribute orders to affiliates. An order belongs to an affiliate when its cart was reported by the
 * storefront (?ref=CODE) or when the customer used the affiliate's linked discount code. Done once per
 * order (the rate is frozen then); an affiliate's own purchases never count.
 */
export async function syncAttribution(db: Database): Promise<void> {
  const ts = now();
  await db.run(
    `INSERT OR IGNORE INTO affiliate_orders (order_id, affiliate_id, rate_bp, via, created_at)
     SELECT o.id, a.id, a.rate_bp, 'link', ? FROM orders o
       JOIN affiliate_referrals r ON r.cart_id = o.cart_id
       JOIN affiliates a ON a.id = r.affiliate_id
      WHERE o.id NOT IN (SELECT order_id FROM affiliate_orders)
        AND lower(o.customer_email) != lower(COALESCE(a.email, ''))`,
    [ts]
  );
  await db.run(
    `INSERT OR IGNORE INTO affiliate_orders (order_id, affiliate_id, rate_bp, via, created_at)
     SELECT o.id, a.id, a.rate_bp, 'code', ? FROM orders o
       JOIN affiliates a ON a.discount_code IS NOT NULL AND upper(a.discount_code) = upper(o.discount_code)
      WHERE o.discount_code IS NOT NULL
        AND o.id NOT IN (SELECT order_id FROM affiliate_orders)
        AND lower(o.customer_email) != lower(COALESCE(a.email, ''))`,
    [ts]
  );
}

type Raw = {
  order_id: string; number: string; created_at: string; currency: string; via: string; rate_bp: number; status: string;
  subtotal_cents: number; discount_amount_cents: number | null; total_cents: number; amount_paid_cents: number;
  refunded_cents: number; last_payment_at: string | null;
};

/** Commission of one order, from what has really been paid and not refunded. */
export function commissionOf(r: Raw, hold: number, at = Date.now()): OrderCommission {
  const base = Math.max(0, r.subtotal_cents - (r.discount_amount_cents ?? 0));
  const net = Math.max(0, r.amount_paid_cents - r.refunded_cents);
  const dead = r.status === 'refunded' || r.status === 'canceled' || (r.amount_paid_cents > 0 && net === 0);
  const ratio = r.total_cents > 0 ? Math.min(1, net / r.total_cents) : 0;
  const cents = dead ? 0 : Math.floor((base * ratio * r.rate_bp) / 10000);
  let state: CommissionState;
  if (dead) state = 'canceled';
  else if (r.amount_paid_cents <= 0) state = 'awaiting_payment';
  else {
    const since = Date.parse((r.last_payment_at ?? r.created_at).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(r.last_payment_at ?? r.created_at) ? '' : 'Z'));
    state = Number.isFinite(since) && at - since < hold * 86_400_000 ? 'pending' : 'available';
  }
  return { order_id: r.order_id, number: r.number, created_at: r.created_at, currency: r.currency, via: r.via, rate_bp: r.rate_bp, base_cents: base, commission_cents: cents, state };
}

export async function ordersOf(db: Database, affiliateId: string | null): Promise<(OrderCommission & { affiliate_id: string })[]> {
  const hold = await holdDays(db);
  const rows = await db.query<Raw & { affiliate_id: string }>(
    `SELECT ao.order_id, ao.affiliate_id, ao.rate_bp, ao.via, o.number, o.created_at, o.currency, o.status, o.subtotal_cents, o.discount_amount_cents, o.total_cents,
            COALESCE(o.amount_paid_cents, 0) AS amount_paid_cents,
            COALESCE((SELECT SUM(amount_cents) FROM refunds f WHERE f.order_id = o.id AND f.status != 'failed'), 0) AS refunded_cents,
            (SELECT MAX(created_at) FROM order_payments p WHERE p.order_id = o.id) AS last_payment_at
       FROM affiliate_orders ao JOIN orders o ON o.id = ao.order_id
      ${affiliateId ? 'WHERE ao.affiliate_id = ?' : ''}
      ORDER BY o.created_at DESC LIMIT 2000`,
    affiliateId ? [affiliateId] : []
  );
  return rows.map((r) => ({ ...commissionOf(r, hold), affiliate_id: r.affiliate_id }));
}

export async function payoutsOf(db: Database, affiliateId: string | null) {
  return db.query<{ id: string; affiliate_id: string; amount_cents: number; currency: string; method: string; reference: string | null; note: string | null; created_at: string }>(
    `SELECT * FROM affiliate_payouts ${affiliateId ? 'WHERE affiliate_id = ?' : ''} ORDER BY created_at DESC LIMIT 2000`, affiliateId ? [affiliateId] : []
  );
}

/** Money per currency: what is payable now, what is still on hold, what was paid out, what is still owed. */
export function totalsOf(orders: OrderCommission[], payouts: { currency: string; amount_cents: number }[]): Totals[] {
  const by = new Map<string, Totals>();
  const t = (cur: string) => { let x = by.get(cur); if (!x) { x = { currency: cur, available_cents: 0, pending_cents: 0, paid_out_cents: 0, balance_cents: 0, canceled_count: 0, orders: 0 }; by.set(cur, x); } return x; };
  for (const o of orders) {
    const x = t(o.currency); x.orders++;
    if (o.state === 'available') x.available_cents += o.commission_cents;
    else if (o.state === 'pending') x.pending_cents += o.commission_cents;
    else if (o.state === 'canceled') x.canceled_count++;
  }
  for (const p of payouts) t(p.currency).paid_out_cents += p.amount_cents;
  for (const x of by.values()) x.balance_cents = x.available_cents - x.paid_out_cents;
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function formatAffiliate(a: AffiliateRow, storeUrl: string | undefined, origin: string) {
  return {
    id: a.id, code: a.code, name: a.name, email: a.email, phone: a.phone, rate_percent: a.rate_bp / 100, status: a.status,
    discount_code: a.discount_code, note: a.note, created_at: a.created_at,
    link: referralLink(storeUrl, origin, a.code), portal_url: `${origin}/m/affiliates/a/${a.token}`,
  };
}

export const money = (cents: number, currency: string, lang: 'fr' | 'en') => {
  const zero = ['XOF', 'GNF', 'JPY', 'KRW', 'VND'].includes(currency.toUpperCase());
  try {
    return new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'fr-FR', { style: 'currency', currency, minimumFractionDigits: zero ? 0 : 2, maximumFractionDigits: zero ? 0 : 2 }).format(zero ? cents : cents / 100);
  } catch { return `${cents / (zero ? 1 : 100)} ${currency}`; }
};
