// =============================================================================
// src/lib/shipping.ts
//
// Shipping zones, rates and the quote engine.
//
//   zone  = a set of countries (or "*" = rest of the world), optionally narrowed to
//           cities / regions of those countries. The most specific zone wins:
//             city or region match  >  country  >  rest of world
//   rate  = one way to ship inside a zone (courier, post, express, pickup…):
//             flat   one price
//             weight price by weight band, optional extra price per started kg above the last band
//             pickup collected by the customer, free
//   free shipping = optional threshold, per rate or for the whole store ("free over X").
//
// Amounts of rates are kept in the store's base currency (default XOF). A cart in another
// currency is converted with the `fx` table of the settings (base units for 1 unit of that
// currency; EUR is preset to the fixed CFA parity).
//
// Missing weights: a physical variant whose weight is 0 / unset is counted with the store's
// default weight and flagged `estimated` — never counted as 0. The admin lists those variants.
// =============================================================================

import type { Database } from '../db';
import { ApiError, uuid, now } from '../types';
import { minorFactor } from './currency';

export interface ShippingSettings {
  enabled: boolean;
  /** Weight used for a physical variant that has none (grams per unit). */
  default_weight_g: number;
  /** Free shipping when the goods total reaches this (base currency cents); null = off. Pickup is always free. */
  free_over_cents: number | null;
  base_currency: string;
  /** Base-currency units for 1 unit of the key currency, e.g. { EUR: 655.957 } with base XOF. */
  fx: Record<string, number>;
}

export const DEFAULT_SHIPPING_SETTINGS: ShippingSettings = {
  enabled: false,
  default_weight_g: 500,
  free_over_cents: null,
  base_currency: 'XOF',
  fx: { EUR: 655.957 },
};

export interface WeightBand { up_to_g: number; cents: number }

export interface ShippingRate {
  id: string;
  zone_id: string;
  name_fr: string;
  name_en: string;
  kind: 'flat' | 'weight' | 'pickup';
  flat_cents: number;
  bands: WeightBand[];
  over_per_kg_cents: number | null;
  free_over_cents: number | null;
  min_days: number | null;
  max_days: number | null;
  pickup_address: string | null;
  active: boolean;
  position: number;
}

export interface ShippingZone {
  id: string;
  name: string;
  countries: string[];
  regions: string[];
  active: boolean;
  position: number;
  rates: ShippingRate[];
}

export interface QuoteOption {
  id: string;
  kind: 'flat' | 'weight' | 'pickup';
  name_fr: string;
  name_en: string;
  cents: number;
  free: boolean;
  min_days: number | null;
  max_days: number | null;
  pickup_address: string | null;
}

export interface Quote {
  enabled: boolean;
  /** False when the goods need no delivery (digital / services only). */
  needed: boolean;
  deliverable: boolean;
  reason?: 'no_zone' | 'too_heavy' | 'currency' | 'no_address';
  currency: string;
  weight_g: number;
  /** True when at least one product had no weight and the default was used. */
  estimated: boolean;
  zone: { id: string; name: string } | null;
  options: QuoteOption[];
}

// ─────────────────────────────── settings ────────────────────────────────────

export async function getShippingSettings(db: Database): Promise<ShippingSettings> {
  const [row] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'shipping'`);
  let saved: Partial<ShippingSettings> = {};
  try { saved = row?.value ? JSON.parse(row.value) : {}; } catch { /* defaults */ }
  const d = DEFAULT_SHIPPING_SETTINGS;
  const int = (v: unknown, dflt: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : dflt);
  const fx: Record<string, number> = {};
  for (const [k, v] of Object.entries(saved.fx ?? d.fx)) {
    if (/^[A-Za-z]{3}$/.test(k) && Number(v) > 0) fx[k.toUpperCase()] = Number(v);
  }
  return {
    enabled: saved.enabled === true,
    default_weight_g: Math.max(int(saved.default_weight_g, d.default_weight_g), 1),
    free_over_cents: saved.free_over_cents != null && Number(saved.free_over_cents) > 0 ? Math.floor(Number(saved.free_over_cents)) : null,
    base_currency: /^[A-Za-z]{3}$/.test(String(saved.base_currency ?? '')) ? String(saved.base_currency).toUpperCase() : d.base_currency,
    fx,
  };
}

export async function saveShippingSettings(db: Database, s: ShippingSettings) {
  await db.run(
    `INSERT INTO config (key, value) VALUES ('shipping', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(s)]
  );
}

// ─────────────────────────────── zones & rates ───────────────────────────────

const parseJson = <T>(s: unknown, fallback: T): T => {
  try { const v = typeof s === 'string' ? JSON.parse(s) : null; return v ?? fallback; } catch { return fallback; }
};

function rowToRate(r: any): ShippingRate {
  const bands = parseJson<WeightBand[]>(r.bands, [])
    .filter((b) => Number(b.up_to_g) > 0 && Number(b.cents) >= 0)
    .map((b) => ({ up_to_g: Math.floor(Number(b.up_to_g)), cents: Math.floor(Number(b.cents)) }))
    .sort((a, b) => a.up_to_g - b.up_to_g);
  return {
    id: r.id, zone_id: r.zone_id, name_fr: r.name_fr, name_en: r.name_en,
    kind: r.kind, flat_cents: Number(r.flat_cents ?? 0), bands,
    over_per_kg_cents: r.over_per_kg_cents == null ? null : Number(r.over_per_kg_cents),
    free_over_cents: r.free_over_cents == null ? null : Number(r.free_over_cents),
    min_days: r.min_days == null ? null : Number(r.min_days),
    max_days: r.max_days == null ? null : Number(r.max_days),
    pickup_address: r.pickup_address ?? null,
    active: !!r.active, position: Number(r.position ?? 0),
  };
}

export async function listZones(db: Database): Promise<ShippingZone[]> {
  const zones = await db.query<any>(`SELECT * FROM shipping_zones ORDER BY position, name`);
  const rates = await db.query<any>(`SELECT * FROM shipping_rates ORDER BY position, name_fr`);
  return zones.map((z) => ({
    id: z.id, name: z.name,
    countries: parseJson<string[]>(z.countries, []).map((c) => String(c).toUpperCase()),
    regions: parseJson<string[]>(z.regions, []).map(String),
    active: !!z.active, position: Number(z.position ?? 0),
    rates: rates.filter((r) => r.zone_id === z.id).map(rowToRate),
  }));
}

/** Lower-case, accent-free, letters and digits only (words separated by one space). */
export function normPlace(s: string | null | undefined): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function regionMatches(regions: string[], city: string | null | undefined, state: string | null | undefined): boolean {
  const hay = [normPlace(city), normPlace(state)].filter(Boolean).map((h) => ` ${h} `);
  return regions.some((r) => {
    const n = normPlace(r);
    return n !== '' && hay.some((h) => h === ` ${n} ` || h.includes(` ${n} `));
  });
}

/** Active zones that cover this destination, most specific first (ties: admin order). */
export function matchZones(zones: ShippingZone[], country: string, city?: string | null, state?: string | null): ShippingZone[] {
  const c = (country || '').toUpperCase();
  const scored: Array<{ z: ShippingZone; score: number }> = [];
  for (const z of zones) {
    if (!z.active) continue;
    const covers = z.countries.includes(c);
    const world = z.countries.includes('*');
    if (!covers && !world) continue;
    if (z.regions.length > 0) {
      if (!covers || !regionMatches(z.regions, city, state)) continue;
      scored.push({ z, score: 3 });
    } else {
      scored.push({ z, score: covers ? 2 : 1 });
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.z.position - b.z.position).map((s) => s.z);
}

// ─────────────────────────────── currency ────────────────────────────────────

/** Cart-currency cents → base-currency cents, or null when no exchange rate is known. */
function toBase(cents: number, currency: string, s: ShippingSettings): number | null {
  const cur = currency.toUpperCase();
  if (cur === s.base_currency) return cents;
  const fx = s.fx[cur];
  if (!fx) return null;
  return Math.round((cents / minorFactor(cur)) * fx * minorFactor(s.base_currency));
}

function fromBase(cents: number, currency: string, s: ShippingSettings): number {
  const cur = currency.toUpperCase();
  if (cur === s.base_currency) return cents;
  const fx = s.fx[cur] ?? 1;
  return Math.round((cents / minorFactor(s.base_currency) / fx) * minorFactor(cur));
}

// ─────────────────────────────── pricing ─────────────────────────────────────

/** Base-currency price of a rate for this weight, or null when the rate cannot carry it (too heavy). */
export function ratePrice(rate: ShippingRate, weightG: number): number | null {
  if (rate.kind === 'pickup') return 0;
  if (rate.kind === 'flat') return rate.flat_cents;
  if (rate.bands.length === 0) return null;
  const band = rate.bands.find((b) => weightG <= b.up_to_g);
  if (band) return band.cents;
  const last = rate.bands[rate.bands.length - 1];
  if (rate.over_per_kg_cents == null) return null;
  return last.cents + Math.ceil((weightG - last.up_to_g) / 1000) * rate.over_per_kg_cents;
}

export interface QuoteInput {
  /** Total weight and goods value are given directly (admin test) or derived from items. */
  items?: Array<{ sku: string; qty: number }>;
  weight_g?: number;
  goods_cents: number;          // goods total after discount, cart currency
  currency: string;
  country: string | null | undefined;
  city?: string | null;
  state?: string | null;
  /** Price even while shipping is switched off (admin test). */
  force?: boolean;
}

/** Weight of the physical items. Variants without a weight count as the default weight and set `estimated`. */
export async function cartWeight(
  db: Database,
  items: Array<{ sku: string; qty: number }>,
  defaultG: number
): Promise<{ weight_g: number; estimated: boolean; physical: boolean }> {
  let weight = 0, estimated = false, physical = false;
  for (const it of items) {
    const [v] = await db.query<{ weight_g: number | null; product_type: string | null }>(
      `SELECT weight_g, product_type FROM variants WHERE sku = ? LIMIT 1`, [it.sku]
    );
    if (v && (v.product_type ?? 'physical') !== 'physical') continue;
    physical = true;
    const w = Number(v?.weight_g ?? 0);
    if (w > 0) weight += w * it.qty;
    else { weight += defaultG * it.qty; estimated = true; }
  }
  return { weight_g: weight, estimated, physical };
}

export async function quoteShipping(db: Database, input: QuoteInput): Promise<Quote> {
  const settings = await getShippingSettings(db);
  const currency = (input.currency || settings.base_currency).toUpperCase();
  const empty: Quote = {
    enabled: settings.enabled, needed: true, deliverable: true, currency,
    weight_g: 0, estimated: false, zone: null, options: [],
  };
  if (!settings.enabled && !input.force) return { ...empty, needed: false };

  let weight = input.weight_g ?? 0;
  let estimated = false;
  if (input.items) {
    const w = await cartWeight(db, input.items, settings.default_weight_g);
    if (!w.physical) return { ...empty, needed: false };
    weight = w.weight_g; estimated = w.estimated;
  }
  const base: Quote = { ...empty, weight_g: weight, estimated };

  if (!input.country) return { ...base, deliverable: false, reason: 'no_address' };
  const goodsBase = toBase(input.goods_cents, currency, settings);
  if (goodsBase === null) return { ...base, deliverable: false, reason: 'currency' };

  const zones = matchZones(await listZones(db), input.country, input.city, input.state);
  const zone = zones.find((z) => z.rates.some((r) => r.active));
  if (!zone) return { ...base, deliverable: false, reason: 'no_zone' };

  const options: QuoteOption[] = [];
  for (const r of zone.rates.filter((x) => x.active)) {
    const price = ratePrice(r, weight);
    if (price === null) continue;
    const threshold = r.free_over_cents ?? settings.free_over_cents;
    const free = r.kind === 'pickup' || price === 0 || (threshold != null && goodsBase >= threshold);
    options.push({
      id: r.id, kind: r.kind, name_fr: r.name_fr, name_en: r.name_en,
      cents: free ? 0 : fromBase(price, currency, settings), free,
      min_days: r.min_days, max_days: r.max_days, pickup_address: r.pickup_address,
    });
  }
  options.sort((a, b) => a.cents - b.cents);
  const zoneRef = { id: zone.id, name: zone.name };
  if (options.length === 0) return { ...base, zone: zoneRef, deliverable: false, reason: 'too_heavy' };
  return { ...base, zone: zoneRef, options };
}

// ─────────────────────────────── cart integration ────────────────────────────

export interface ResolvedShipping {
  cents: number;
  label: string | null;
  rate_id: string | null;
}

const NONE: ResolvedShipping = { cents: 0, label: null, rate_id: null };

/**
 * Prices the delivery of a cart and freezes it on the cart row (shipping_cents / label / rate).
 * Called by prepareCheckout, so every payment path charges the same amount. Throws when the
 * address cannot be delivered to. With shipping switched off, or nothing to deliver, it is 0.
 */
export async function resolveCartShipping(
  db: Database,
  cart: { id: string; currency: string | null; ship_to: string | null; shipping_rate_id?: string | null; locale?: string | null },
  items: Array<{ sku: string; qty: number; unit_price_cents: number }>,
  discountCents: number
): Promise<ResolvedShipping> {
  const clear = async () => {
    await db.run(`UPDATE carts SET shipping_cents = 0, shipping_label = NULL, shipping_rate_id = NULL WHERE id = ?`, [cart.id]);
    return NONE;
  };
  const settings = await getShippingSettings(db);
  if (!settings.enabled) return clear();

  let addr: any = null;
  try { addr = cart.ship_to ? JSON.parse(cart.ship_to) : null; } catch { /* no address */ }
  const goods = items.reduce((s, i) => s + i.unit_price_cents * i.qty, 0) - discountCents;
  const q = await quoteShipping(db, {
    items: items.map((i) => ({ sku: i.sku, qty: i.qty })),
    goods_cents: Math.max(goods, 0),
    currency: cart.currency ?? settings.base_currency,
    country: addr?.country, city: addr?.city, state: addr?.state,
  });
  if (!q.needed) return clear();
  if (!q.deliverable) {
    const why = {
      no_address: 'A delivery address is required.',
      no_zone: 'We do not deliver to this address yet.',
      too_heavy: 'This order is too heavy for the available delivery options. Please contact us.',
      currency: 'Delivery rates are not available in this currency.',
    }[q.reason ?? 'no_zone'];
    throw new ApiError('shipping_unavailable', 400, why, { reason: q.reason });
  }
  // Nothing chosen (or the choice is gone): the cheapest delivery, never pick-up by surprise.
  const chosen = q.options.find((o) => o.id === cart.shipping_rate_id) ?? q.options.find((o) => o.kind !== 'pickup') ?? q.options[0];
  const label = (cart.locale === 'en' ? chosen.name_en : chosen.name_fr) || chosen.name_fr || chosen.name_en;
  await db.run(
    `UPDATE carts SET shipping_cents = ?, shipping_label = ?, shipping_rate_id = ? WHERE id = ?`,
    [chosen.cents, label, chosen.id, cart.id]
  );
  return { cents: chosen.cents, label, rate_id: chosen.id };
}

// ─────────────────────────────── admin helpers ───────────────────────────────

/** Physical variants that have no weight yet (rates would use the default weight for them). */
export async function variantsMissingWeight(db: Database) {
  return db.query<{ variant_id: string; sku: string; title: string; product_title: string; product_id: string }>(
    `SELECT v.id AS variant_id, v.sku, v.title, p.title AS product_title, p.id AS product_id
       FROM variants v JOIN products p ON p.id = v.product_id
      WHERE COALESCE(v.product_type, 'physical') = 'physical' AND COALESCE(v.weight_g, 0) <= 0
      ORDER BY p.title, v.title`
  );
}

/** Editable starting point: Benin local courier + pickup, West Africa, Europe and the rest of the world. */
export async function seedStarterZones(db: Database): Promise<number> {
  const [n] = await db.query<{ c: number }>(`SELECT COUNT(*) AS c FROM shipping_zones`);
  if (Number(n?.c) > 0) return 0;
  const zone = async (name: string, countries: string[], regions: string[], position: number) => {
    const id = uuid();
    await db.run(
      `INSERT INTO shipping_zones (id, name, countries, regions, active, position, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [id, name, JSON.stringify(countries), JSON.stringify(regions), position, now()]
    );
    return id;
  };
  const rate = async (zoneId: string, r: Partial<ShippingRate> & { name_fr: string; name_en: string; kind: ShippingRate['kind'] }, position: number) =>
    db.run(
      `INSERT INTO shipping_rates (id, zone_id, name_fr, name_en, kind, flat_cents, bands, over_per_kg_cents, free_over_cents, min_days, max_days, pickup_address, active, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [uuid(), zoneId, r.name_fr, r.name_en, r.kind, r.flat_cents ?? 0, JSON.stringify(r.bands ?? []),
       r.over_per_kg_cents ?? null, r.free_over_cents ?? null, r.min_days ?? null, r.max_days ?? null, r.pickup_address ?? null, position]
    );

  const cotonou = await zone('Cotonou & Abomey-Calavi', ['BJ'], ['Cotonou', 'Abomey-Calavi', 'Calavi'], 0);
  await rate(cotonou, { name_fr: 'Livraison par coursier', name_en: 'Courier delivery', kind: 'weight',
    bands: [{ up_to_g: 1000, cents: 1000 }, { up_to_g: 3000, cents: 1500 }, { up_to_g: 10000, cents: 2500 }], over_per_kg_cents: 300, min_days: 1, max_days: 2 }, 0);
  await rate(cotonou, { name_fr: 'Retrait en boutique', name_en: 'Store pickup', kind: 'pickup', pickup_address: 'À renseigner', min_days: 0, max_days: 1 }, 1);
  const benin = await zone('Bénin (reste du pays)', ['BJ'], [], 1);
  await rate(benin, { name_fr: 'Livraison par coursier', name_en: 'Courier delivery', kind: 'weight',
    bands: [{ up_to_g: 1000, cents: 2000 }, { up_to_g: 3000, cents: 3000 }, { up_to_g: 10000, cents: 5000 }], over_per_kg_cents: 500, min_days: 2, max_days: 5 }, 0);
  const africa = await zone('Afrique de l’Ouest', ['TG', 'NG', 'GH', 'CI', 'SN', 'BF', 'NE', 'ML'], [], 2);
  await rate(africa, { name_fr: 'Colis international', name_en: 'International parcel', kind: 'weight',
    bands: [{ up_to_g: 1000, cents: 10000 }, { up_to_g: 3000, cents: 18000 }, { up_to_g: 10000, cents: 35000 }], over_per_kg_cents: 3500, min_days: 5, max_days: 10 }, 0);
  const europe = await zone('Europe & Amérique du Nord', ['FR', 'BE', 'GB', 'CA', 'DE', 'ES', 'IT', 'NL', 'CH', 'US'], [], 3);
  await rate(europe, { name_fr: 'Colis international', name_en: 'International parcel', kind: 'weight',
    bands: [{ up_to_g: 1000, cents: 15000 }, { up_to_g: 3000, cents: 25000 }, { up_to_g: 10000, cents: 50000 }], over_per_kg_cents: 5000, min_days: 7, max_days: 15 }, 0);
  const world = await zone('Reste du monde', ['*'], [], 9);
  await rate(world, { name_fr: 'Colis international', name_en: 'International parcel', kind: 'weight',
    bands: [{ up_to_g: 1000, cents: 20000 }, { up_to_g: 3000, cents: 35000 }, { up_to_g: 10000, cents: 65000 }], over_per_kg_cents: 6000, min_days: 10, max_days: 20 }, 0);
  return 6;
}
