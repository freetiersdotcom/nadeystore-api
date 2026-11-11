// Ad tracking: which campaign brought each order, and what the campaigns cost.
// Attribution is stored per cart (the storefront reports it before checkout, only when the visitor agreed to measurement
// cookies) and reaches the order through orders.cart_id. Money comes from the profit code, so this report and the
// profit report can never disagree.
import type { Database } from '../../db';
import { figures, getFees, type Line } from '../../routes/profit';

const CTRL = /[\u0000-\u001f\u007f]/g;
export const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(CTRL, ' ').trim().slice(0, max) : '');

export type Attribution = {
  source: string; medium: string; campaign: string; content: string; term: string;
  click_id_type: string; click_id: string; landing: string; referrer: string; fbp: string; ttp: string;
};

const CLICK_SOURCE: Record<string, string> = { fbclid: 'facebook', ttclid: 'tiktok', gclid: 'google' };

/** Cleans what the browser sent. A click id alone (no UTM) still tells us the platform. Returns null when there is nothing to attribute. */
export function normalizeAttribution(i: Record<string, unknown>): Attribution | null {
  const a: Attribution = {
    source: clean(i.utm_source ?? i.source, 60).toLowerCase(), medium: clean(i.utm_medium ?? i.medium, 60).toLowerCase(),
    campaign: clean(i.utm_campaign ?? i.campaign, 120), content: clean(i.utm_content ?? i.content, 120), term: clean(i.utm_term ?? i.term, 120),
    click_id_type: '', click_id: '', landing: clean(i.landing, 300), referrer: clean(i.referrer, 300), fbp: clean(i.fbp, 120), ttp: clean(i.ttp, 120),
  };
  const type = clean(i.click_id_type, 10).toLowerCase();
  if (CLICK_SOURCE[type]) { a.click_id_type = type; a.click_id = clean(i.click_id, 300); }
  if (a.click_id && !a.source) a.source = CLICK_SOURCE[a.click_id_type];
  if (a.click_id && !a.medium) a.medium = 'paid';
  if (!a.source && !a.medium && !a.campaign && !a.click_id) return null;
  return a;
}

export async function saveAttribution(db: Database, cartId: string, a: Attribution, nowIso: string, who: { ip?: string | null; ua?: string | null } = {}): Promise<boolean> {
  const [cart] = await db.query<{ id: string }>(`SELECT id FROM carts WHERE id = ?`, [cartId]);
  if (!cart) return false;
  // The latest campaign a visitor came from wins, until the cart becomes an order (then it is frozen).
  await db.run(
    `INSERT INTO ad_attribution (cart_id, source, medium, campaign, content, term, click_id_type, click_id, landing, referrer, fbp, ttp, ip, ua, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cart_id) DO UPDATE SET source = excluded.source, medium = excluded.medium, campaign = excluded.campaign, content = excluded.content,
       term = excluded.term, click_id_type = excluded.click_id_type, click_id = excluded.click_id, landing = excluded.landing, referrer = excluded.referrer,
       fbp = excluded.fbp, ttp = excluded.ttp, ip = excluded.ip, ua = excluded.ua, created_at = excluded.created_at
     WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.cart_id = ad_attribution.cart_id)`,
    [cartId, a.source, a.medium, a.campaign, a.content, a.term, a.click_id_type, a.click_id, a.landing, a.referrer, a.fbp, a.ttp, clean(who.ip, 64) || null, clean(who.ua, 300) || null, nowIso]);
  return true;
}

/** Rows for carts that never became an order are dropped after 60 days. */
export async function purgeOld(db: Database): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString();
  await db.run(`DELETE FROM ad_attribution WHERE created_at < ? AND cart_id NOT IN (SELECT cart_id FROM orders WHERE cart_id IS NOT NULL)`, [cutoff]);
}

export const DIRECT = '(direct / unknown)';
const dayMs = 86_400_000;
const dayNum = (d: string) => Math.floor(Date.parse(d + 'T00:00:00Z') / dayMs);

export type ReportRow = {
  key: string; campaign: string; source: string; medium: string;
  orders: number; revenue_cents: number; known_orders: number; known_revenue_cents: number; margin_cents: number;
  coverage_pct: number; spend_cents: number; roas: number | null; net_cents: number | null;
};

export async function buildReport(db: Database, from: string, to: string) {
  const startIso = from + 'T00:00:00.000Z', endIso = new Date(Date.parse(to + 'T00:00:00Z') + dayMs).toISOString();
  const startSql = from + ' 00:00:00', endSql = endIso.slice(0, 10) + ' 00:00:00';
  const orders = await db.query<any>(
    `SELECT o.id, o.currency, COALESCE(o.discount_amount_cents, 0) AS discount, a.source, a.medium, a.campaign
       FROM orders o LEFT JOIN ad_attribution a ON a.cart_id = o.cart_id
      WHERE o.paid_at IS NOT NULL AND o.status != 'canceled' AND ((o.paid_at >= ? AND o.paid_at < ?) OR (o.paid_at >= ? AND o.paid_at < ?))
      ORDER BY o.paid_at LIMIT 5001`, [startIso, endIso, startSql, endSql]);
  const truncated = orders.length > 5000; if (truncated) orders.length = 5000;
  const ids = orders.map((o: any) => o.id);
  const lines = new Map<string, Line[]>(), refunded = new Map<string, number>(), paidBy = new Map<string, Record<string, number>>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400), q = chunk.map(() => '?').join(',');
    for (const r of await db.query<any>(`SELECT order_id, sku, title, qty, unit_price_cents, cost_cents FROM order_items WHERE order_id IN (${q})`, chunk)) (lines.get(r.order_id) ?? lines.set(r.order_id, []).get(r.order_id)!).push(r);
    for (const r of await db.query<any>(`SELECT order_id, SUM(amount_cents) AS n FROM refunds WHERE order_id IN (${q}) AND status NOT IN ('failed', 'canceled') GROUP BY order_id`, chunk)) refunded.set(r.order_id, r.n);
    for (const r of await db.query<any>(`SELECT order_id, method, SUM(amount_cents) AS n FROM order_payments WHERE order_id IN (${q}) GROUP BY order_id, method`, chunk)) { const m = paidBy.get(r.order_id) ?? {}; m[r.method] = r.n; paidBy.set(r.order_id, m); }
  }
  const fees = await getFees(db);
  const cur = new Map<string, Map<string, ReportRow>>();
  const row = (currency: string, key: string, campaign: string, source: string, medium: string): ReportRow => {
    const m = cur.get(currency) ?? cur.set(currency, new Map()).get(currency)!;
    return m.get(key) ?? m.set(key, { key, campaign, source, medium, orders: 0, revenue_cents: 0, known_orders: 0, known_revenue_cents: 0, margin_cents: 0, coverage_pct: 100, spend_cents: 0, roas: null, net_cents: null }).get(key)!;
  };
  for (const o of orders) {
    const l = lines.get(o.id) ?? []; if (!l.length) continue;
    const f = figures(l, o.discount, refunded.get(o.id) ?? 0, paidBy.get(o.id) ?? {}, fees);
    const attributed = !!(o.source || o.medium || o.campaign);
    const key = !attributed ? '' : (o.campaign ? String(o.campaign).toLowerCase() : `(${o.source || o.medium})`);
    const r = attributed ? row(o.currency, key, o.campaign || `(no campaign) ${o.source || o.medium}`, o.source || '', o.medium || '') : row(o.currency, '', DIRECT, '', '');
    r.orders++; r.revenue_cents += f.net;
    if (f.complete) { r.known_orders++; r.known_revenue_cents += f.net; r.margin_cents += f.margin as number; }
  }
  // Spend entered by hand, spread evenly over its days and counted for the days inside the period.
  const spends = await db.query<any>(`SELECT platform, campaign, from_day, to_day, amount_cents, currency FROM ad_spend WHERE to_day >= ? AND from_day <= ?`, [from, to]);
  const f0 = dayNum(from), t0 = dayNum(to);
  for (const s of spends) {
    const a = dayNum(s.from_day), b = dayNum(s.to_day), total = b - a + 1;
    const overlap = Math.max(0, Math.min(b, t0) - Math.max(a, f0) + 1);
    if (!overlap) continue;
    const r = row(s.currency, String(s.campaign).toLowerCase(), s.campaign, String(s.platform).toLowerCase(), '');
    r.spend_cents += (s.amount_cents * overlap) / total;
    if (!r.source) r.source = String(s.platform).toLowerCase();
  }
  const currencies = [...cur.entries()].map(([currency, m]) => {
    const rows = [...m.values()].map((r) => {
      const spend = Math.round(r.spend_cents);
      return { ...r, spend_cents: spend,
        coverage_pct: r.revenue_cents > 0 ? Math.round((r.known_revenue_cents / r.revenue_cents) * 100) : 100,
        roas: spend > 0 ? Math.round((r.revenue_cents / spend) * 100) / 100 : null,
        net_cents: r.known_orders > 0 || spend > 0 ? r.margin_cents - spend : null } as ReportRow;
    }).sort((x, y) => (x.key === '' ? 1 : 0) - (y.key === '' ? 1 : 0) || y.revenue_cents - x.revenue_cents);
    const sum = (k: 'orders' | 'revenue_cents' | 'known_orders' | 'known_revenue_cents' | 'margin_cents' | 'spend_cents') => rows.reduce((n, r) => n + r[k], 0);
    const spend = sum('spend_cents'); const attributedRows = rows.filter((r) => r.key !== '');
    return { currency, rows,
      totals: { orders: sum('orders'), revenue_cents: sum('revenue_cents'), spend_cents: spend, margin_cents: sum('margin_cents'),
        attributed_orders: attributedRows.reduce((n, r) => n + r.orders, 0), attributed_revenue_cents: attributedRows.reduce((n, r) => n + r.revenue_cents, 0),
        roas: spend > 0 ? Math.round((attributedRows.reduce((n, r) => n + r.revenue_cents, 0) / spend) * 100) / 100 : null } };
  });
  return { from, to, truncated, currencies };
}
