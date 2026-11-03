import type { Database } from '../../db';
import { minorFactor } from '../../lib/currency';

export type QuoteItem = { sku: string; title: string; qty: number; unit_price_cents: number };
export type QuoteRow = {
  id: string; seq: number; number: string; token: string; status: 'draft' | 'sent' | 'accepted' | 'declined' | 'converted';
  customer_name: string | null; customer_email: string | null; customer_phone: string | null; currency: string; locale: string;
  items: string; total_cents: number; note: string | null; valid_until: string; order_id: string | null;
  created_at: string; updated_at: string; sent_at: string | null; responded_at: string | null;
};

/** A sent quote past its date reads as expired (nothing is stored: it is derived). */
export function effectiveStatus(q: Pick<QuoteRow, 'status' | 'valid_until'>): QuoteRow['status'] | 'expired' {
  return q.status === 'sent' && q.valid_until < new Date().toISOString() ? 'expired' : q.status;
}

export function parseItems(q: Pick<QuoteRow, 'items'>): QuoteItem[] {
  try { const v = JSON.parse(q.items); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function publicUrl(origin: string, token: string) { return `${origin.replace(/\/$/, '')}/m/quotes/q/${token}`; }

export function formatQuote(q: QuoteRow, origin: string) {
  return {
    id: q.id, number: q.number, status: effectiveStatus(q), stored_status: q.status,
    customer_name: q.customer_name, customer_email: q.customer_email, customer_phone: q.customer_phone,
    currency: q.currency, locale: q.locale, items: parseItems(q), total_cents: q.total_cents, note: q.note,
    valid_until: q.valid_until, order_id: q.order_id, public_url: publicUrl(origin, q.token),
    created_at: q.created_at, sent_at: q.sent_at, responded_at: q.responded_at,
  };
}

/** Look up the catalog for each line: the title and the current price are written onto the quote. */
export async function resolveItems(db: Database, lines: Array<{ sku: string; qty: number; unit_price_cents?: number; title?: string }>): Promise<QuoteItem[]> {
  const out: QuoteItem[] = [];
  for (const l of lines) {
    const [v] = await db.query<{ sku: string; vtitle: string; ptitle: string; price_cents: number }>(
      `SELECT v.sku, v.title AS vtitle, p.title AS ptitle, v.price_cents FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ?`, [l.sku]
    );
    if (!v) throw new Error(`Unknown sku: ${l.sku}`);
    const title = l.title?.trim() || (v.vtitle && v.vtitle !== v.ptitle ? `${v.ptitle} — ${v.vtitle}` : v.ptitle);
    out.push({ sku: v.sku, title, qty: l.qty, unit_price_cents: l.unit_price_cents ?? v.price_cents });
  }
  return out;
}

export const totalOf = (items: QuoteItem[]) => items.reduce((s, i) => s + i.unit_price_cents * i.qty, 0);

export function money(cents: number, currency: string, lang: 'fr' | 'en') {
  const zero = minorFactor(currency) === 1;
  return new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'fr-FR', { style: 'currency', currency, minimumFractionDigits: zero ? 0 : 2, maximumFractionDigits: zero ? 0 : 2 }).format(zero ? cents : cents / 100);
}

export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
