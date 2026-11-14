// =============================================================================
// Offers module (upsell / cross-sell in the cart).
//   A rule says: "when the cart has <trigger>, offer <variant> (optionally X% off)".
//   The storefront asks which offers fit a cart, adds the chosen one as a normal cart line, and, at checkout,
//   asks the shop to confirm it (attach). Only the shop sets the discounted price, never the browser.
// =============================================================================
import type { Database } from '../../db';
import { now } from '../../types';

export type TriggerKind = 'any' | 'product' | 'sku';
export type Offer = {
  id: string; name: string; active: number; trigger_kind: TriggerKind; trigger_ref: string | null; offer_sku: string;
  discount_pct: number; max_qty: number; headline_fr: string | null; headline_en: string | null; priority: number; created_at: string;
};
export type MatchItem = {
  id: string; headline: string | null; sku: string; title: string; product_title: string; image_url: string | null; slug: string | null;
  product_type: string; price_cents: number; discounted_cents: number; discount_pct: number; max_qty: number; currency: string;
};

export const discounted = (priceCents: number, pct: number): number => Math.round((priceCents * (100 - pct)) / 100);
const uuid = () => crypto.randomUUID();

type CartView = { skus: string[]; productIds: Set<string> };
async function cartView(db: Database, skus: string[]): Promise<CartView> {
  const clean = [...new Set(skus.filter(Boolean))];
  const productIds = new Set<string>();
  if (clean.length) {
    const rows = await db.query<{ product_id: string }>(`SELECT product_id FROM variants WHERE sku IN (${clean.map(() => '?').join(',')})`, clean);
    for (const r of rows) productIds.add(r.product_id);
  }
  return { skus: clean, productIds };
}
export function triggerMet(o: Pick<Offer, 'trigger_kind' | 'trigger_ref'>, cart: CartView): boolean {
  if (!cart.skus.length) return false;
  if (o.trigger_kind === 'any') return true;
  if (o.trigger_kind === 'sku') return !!o.trigger_ref && cart.skus.includes(o.trigger_ref);
  return !!o.trigger_ref && cart.productIds.has(o.trigger_ref);
}

type Target = { sku: string; title: string; price_cents: number; currency: string; product_type: string | null; image_url: string | null; product_title: string; p_image: string | null; slug: string | null; product_id: string };
async function target(db: Database, sku: string): Promise<Target | null> {
  const [t] = await db.query<Target>(
    `SELECT v.sku, v.title, v.price_cents, v.currency, v.product_type, v.image_url, p.title AS product_title, p.image_url AS p_image, p.slug, p.id AS product_id
       FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ? AND v.status = 'active' AND p.status = 'active'`, [sku]);
  return t ?? null;
}
async function buyable(db: Database, t: Target, qty = 1): Promise<boolean> {
  if ((t.product_type ?? 'physical') !== 'physical') return true;
  const [inv] = await db.query<{ on_hand: number; reserved: number }>(`SELECT on_hand, reserved FROM inventory WHERE sku = ?`, [t.sku]);
  return (inv?.on_hand ?? 0) - (inv?.reserved ?? 0) >= qty;
}

/** The offers that fit this cart, best first. Never offers something already in the cart, or another variant of a product already there. */
export async function matchOffers(db: Database, skus: string[], lang: 'fr' | 'en', limit = 3): Promise<MatchItem[]> {
  const cart = await cartView(db, skus);
  if (!cart.skus.length) return [];
  const offers = await db.query<Offer>(`SELECT * FROM offers WHERE active = 1 ORDER BY priority DESC, created_at ASC, id ASC`);
  const out: MatchItem[] = [];
  for (const o of offers) {
    if (out.length >= limit) break;
    if (!triggerMet(o, cart) || cart.skus.includes(o.offer_sku)) continue;
    const t = await target(db, o.offer_sku);
    if (!t || cart.productIds.has(t.product_id) || !(await buyable(db, t))) continue;
    out.push({
      id: o.id, headline: (lang === 'en' ? o.headline_en : o.headline_fr) || null, sku: t.sku, title: t.title, product_title: t.product_title,
      image_url: t.image_url || t.p_image, slug: t.slug, product_type: t.product_type ?? 'physical', price_cents: t.price_cents,
      discounted_cents: discounted(t.price_cents, o.discount_pct), discount_pct: o.discount_pct, max_qty: o.max_qty, currency: t.currency,
    });
  }
  return out;
}

/**
 * Confirm the offers a cart took. Each accepted offer prices its cart line (the browser never decides the price).
 * Refused: the rule is off or gone, the line is missing, the quantity is above the rule's limit, the trigger is no longer in the cart,
 * or the line was already re-priced by something else.
 */
export async function attach(db: Database, cartId: string, offerIds: string[]): Promise<{ attached: string[]; refused: string[] }> {
  const attached: string[] = []; const refused: string[] = [];
  const [cart] = await db.query<{ id: string; status: string; currency: string | null }>(`SELECT id, status, currency FROM carts WHERE id = ?`, [cartId]);
  if (!cart || cart.status !== 'open') return { attached, refused: [...offerIds] };
  const lines = await db.query<{ id: string; sku: string; qty: number; unit_price_cents: number }>(`SELECT id, sku, qty, unit_price_cents FROM cart_items WHERE cart_id = ?`, [cartId]);
  for (const offerId of [...new Set(offerIds)]) {
    const [o] = await db.query<Offer>(`SELECT * FROM offers WHERE id = ? AND active = 1`, [offerId]);
    const line = o && lines.find((l) => l.sku === o.offer_sku);
    const t = o && line ? await target(db, o.offer_sku) : null;
    if (!o || !line || !t || line.qty > o.max_qty) { refused.push(offerId); continue; }
    const others = await cartView(db, lines.filter((l) => l.sku !== o.offer_sku).map((l) => l.sku));
    const price = discounted(t.price_cents, o.discount_pct);
    if (!triggerMet(o, others) || (line.unit_price_cents !== t.price_cents && line.unit_price_cents !== price)) { refused.push(offerId); continue; }
    await db.run(`UPDATE cart_items SET unit_price_cents = ? WHERE id = ?`, [price, line.id]);
    const [known] = await db.query(`SELECT 1 FROM offer_carts WHERE cart_id = ? AND offer_id = ?`, [cartId, offerId]);
    await db.run(`INSERT INTO offer_carts (cart_id, offer_id, sku, unit_cents, credited, created_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(cart_id, offer_id) DO UPDATE SET unit_cents = excluded.unit_cents`, [cartId, offerId, o.offer_sku, price, now()]);
    if (!known) await db.run(`INSERT INTO offer_events (id, offer_id, kind, cart_id, order_id, amount_cents, created_at) VALUES (?, ?, 'taken', ?, NULL, 0, ?)`, [uuid(), offerId, cartId, now()]);
    attached.push(offerId);
  }
  // Offers this cart no longer takes (dropped in the browser) are forgotten.
  const keep = attached.length ? `AND offer_id NOT IN (${attached.map(() => '?').join(',')})` : '';
  await db.run(`DELETE FROM offer_carts WHERE cart_id = ? AND credited = 0 ${keep}`, [cartId, ...attached]);
  return { attached, refused };
}

export async function seen(db: Database, offerIds: string[]): Promise<void> {
  for (const id of [...new Set(offerIds)].slice(0, 5)) {
    const [o] = await db.query(`SELECT 1 FROM offers WHERE id = ?`, [id]);
    if (o) await db.run(`INSERT INTO offer_events (id, offer_id, kind, cart_id, order_id, amount_cents, created_at) VALUES (?, ?, 'seen', NULL, NULL, 0, ?)`, [uuid(), id, now()]);
  }
}

/** Credit paid orders to the offers they took. Idempotent: every cart is credited once. Returns how many sales were credited. */
export async function credit(db: Database): Promise<number> {
  const rows = await db.query<{ cart_id: string; offer_id: string; sku: string; order_id: string }>(
    `SELECT c.cart_id, c.offer_id, c.sku, o.id AS order_id FROM offer_carts c JOIN orders o ON o.cart_id = c.cart_id
      WHERE c.credited = 0 AND o.paid_at IS NOT NULL AND o.status NOT IN ('canceled', 'refunded', 'pending')`);
  let n = 0;
  for (const r of rows) {
    const [line] = await db.query<{ qty: number; unit_price_cents: number }>(`SELECT qty, unit_price_cents FROM order_items WHERE order_id = ? AND sku = ?`, [r.order_id, r.sku]);
    if (line) {
      await db.run(`INSERT INTO offer_events (id, offer_id, kind, cart_id, order_id, amount_cents, created_at) VALUES (?, ?, 'sold', ?, ?, ?, ?)`, [uuid(), r.offer_id, r.cart_id, r.order_id, line.qty * line.unit_price_cents, now()]);
      n++;
    }
    await db.run(`UPDATE offer_carts SET credited = 1 WHERE cart_id = ? AND offer_id = ?`, [r.cart_id, r.offer_id]);
  }
  return n;
}

export type OfferRow = Offer & { offer_title: string | null; currency: string | null; seen: number; taken: number; sold: number; revenue_cents: number; trigger_title: string | null };
export async function listOffers(db: Database): Promise<OfferRow[]> {
  return db.query<OfferRow>(
    `SELECT o.*, p.title || CASE WHEN v.title IS NOT NULL AND v.title <> 'Default' THEN ' — ' || v.title ELSE '' END AS offer_title, v.currency AS currency,
            CASE o.trigger_kind WHEN 'product' THEN (SELECT title FROM products WHERE id = o.trigger_ref)
                                WHEN 'sku' THEN (SELECT pp.title || CASE WHEN vv.title <> 'Default' THEN ' — ' || vv.title ELSE '' END FROM variants vv JOIN products pp ON pp.id = vv.product_id WHERE vv.sku = o.trigger_ref)
                                ELSE NULL END AS trigger_title,
            (SELECT COUNT(*) FROM offer_events e WHERE e.offer_id = o.id AND e.kind = 'seen') AS seen,
            (SELECT COUNT(*) FROM offer_events e WHERE e.offer_id = o.id AND e.kind = 'taken') AS taken,
            (SELECT COUNT(*) FROM offer_events e WHERE e.offer_id = o.id AND e.kind = 'sold') AS sold,
            COALESCE((SELECT SUM(e.amount_cents) FROM offer_events e WHERE e.offer_id = o.id AND e.kind = 'sold'), 0) AS revenue_cents
       FROM offers o LEFT JOIN variants v ON v.sku = o.offer_sku LEFT JOIN products p ON p.id = v.product_id
      ORDER BY o.priority DESC, o.created_at ASC, o.id ASC`);
}
