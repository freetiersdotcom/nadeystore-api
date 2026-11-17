// src/lib/tiers.ts
// What a client's plan includes, and the checks that enforce it.
//
//   TIERS  below is the agency's price list: which optional modules, which admin features and how many products / staff accounts each
//          tier gets. Edit it to match your offers. Changing it needs a deploy of the API.
//   The tier of one client is stored in its own database (config key "tier") and set by the agency with PUT /v1/tier + X-Setup-Token
//   (see routes/tier.ts), so an upgrade needs no deploy and the client's owner can never change it.
//   A client with nothing stored is on the "pro" tier (everything), so existing shops are unchanged until you choose a tier for them.
import type { Database } from '../db';
import { ApiError } from '../types';

export type Kind = 'physical' | 'digital' | 'service';
export const KINDS: Kind[] = ['physical', 'digital', 'service'];

/** Admin areas that can be left out of a tier (checked on /v1/discounts, /v1/import + /v1/export, /v1/profit + /v1/costs, /v1/backup). */
export type Feature = 'discounts' | 'import_export' | 'profit' | 'backup';
export const FEATURES: Feature[] = ['discounts', 'import_export', 'profit', 'backup'];

export type TierDef = { label: string; modules: string[] | '*'; features: Feature[] | '*'; max_products: number | null; max_staff: number | null };

// ── The price list ── (module ids: quotes, affiliates, vouchers, recovery, lowstock, ads, subs, milestones, offers)
export const TIERS: Record<string, TierDef> = {
  starter: { label: 'Starter', modules: ['lowstock'], features: [], max_products: 30, max_staff: 1 },
  standard: { label: 'Standard', modules: ['lowstock', 'recovery', 'quotes', 'vouchers', 'milestones'], features: ['discounts', 'import_export'], max_products: 200, max_staff: 3 },
  pro: { label: 'Pro', modules: '*', features: '*', max_products: null, max_staff: null },
};
export const DEFAULT_TIER = 'pro';

/** What is saved for one client. `sells` is about the business (not the price); the rest adjusts the tier. */
export type StoredPlan = { tier: string; sells?: Kind[]; extra_modules?: string[]; max_products?: number | null; max_staff?: number | null };
export type Plan = {
  tier: string; label: string; sells: Kind[];
  modules: string[] | '*'; features: Record<Feature, boolean>;
  max_products: number | null; max_staff: number | null;
};

export async function readStoredPlan(db: Database): Promise<StoredPlan | null> {
  const [r] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'tier'`);
  if (!r?.value) return null;
  try { const v = JSON.parse(r.value); return v && typeof v.tier === 'string' ? (v as StoredPlan) : null; } catch { return null; }
}

export function resolvePlan(stored: StoredPlan | null): Plan {
  // An unknown name (a tier removed from the list) fails closed to the smallest tier; no stored tier at all means "pro".
  const name = stored ? stored.tier : DEFAULT_TIER;
  const def = TIERS[name] ?? TIERS.starter;
  const modules = def.modules === '*' ? '*' : [...new Set([...def.modules, ...(stored?.extra_modules ?? [])])];
  const on = (f: Feature) => def.features === '*' || def.features.includes(f);
  return {
    tier: TIERS[name] ? name : 'starter', label: def.label,
    sells: stored?.sells?.length ? stored.sells : [...KINDS],
    modules, features: { discounts: on('discounts'), import_export: on('import_export'), profit: on('profit'), backup: on('backup') },
    max_products: stored && 'max_products' in stored && stored.max_products !== undefined ? stored.max_products : def.max_products,
    max_staff: stored && 'max_staff' in stored && stored.max_staff !== undefined ? stored.max_staff : def.max_staff,
  };
}

export async function getPlan(db: Database): Promise<Plan> { return resolvePlan(await readStoredPlan(db)); }
export const moduleAllowed = (plan: Plan, id: string) => plan.modules === '*' || plan.modules.includes(id);

export const tierError = (message: string, details: Record<string, unknown> = {}) => new ApiError('tier_limit', 403, message, details);

export async function assertFeature(db: Database, feature: Feature): Promise<void> {
  const plan = await getPlan(db);
  if (!plan.features[feature]) throw tierError(`This is not included in the ${plan.label} plan. Ask your provider to upgrade.`, { feature, tier: plan.tier });
}

export async function assertSells(db: Database, kind: string): Promise<void> {
  const plan = await getPlan(db);
  if (!plan.sells.includes(kind as Kind)) throw tierError(`This shop does not sell "${kind}" products.`, { sells: plan.sells, kind });
}

const PRODUCTS = `SELECT COUNT(*) AS n FROM products p WHERE NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.sku = 'CUSTOM')`;
export const countProducts = async (db: Database) => (await db.query<{ n: number }>(PRODUCTS))[0]?.n ?? 0;
export const countStaff = async (db: Database) => (await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role IN ('manager', 'staff') AND status = 'active'`))[0]?.n ?? 0;

export async function assertProductRoom(db: Database, adding = 1): Promise<void> {
  const plan = await getPlan(db);
  if (plan.max_products === null) return;
  if ((await countProducts(db)) + adding > plan.max_products) throw tierError(`The ${plan.label} plan allows ${plan.max_products} products. Ask your provider to upgrade.`, { max_products: plan.max_products });
}

export async function assertStaffRoom(db: Database): Promise<void> {
  const plan = await getPlan(db);
  if (plan.max_staff === null) return;
  if ((await countStaff(db)) + 1 > plan.max_staff) throw tierError(`The ${plan.label} plan allows ${plan.max_staff} staff account${plan.max_staff === 1 ? '' : 's'}. Ask your provider to upgrade.`, { max_staff: plan.max_staff });
}

/** For CSV import: problems the plan would cause, reported like any other row error. */
export async function tierImportErrors(db: Database, ops: Array<{ create: boolean; variants: Array<{ fields: { product_type?: string }; line: number }>; lines: number[] }>): Promise<Array<{ line: number; message: string }>> {
  const plan = await getPlan(db); const out: Array<{ line: number; message: string }> = [];
  for (const op of ops) for (const v of op.variants) {
    const k = v.fields.product_type;
    if (k && !plan.sells.includes(k as Kind)) out.push({ line: v.line, message: `type "${k}" is not sold by this shop` });
  }
  if (plan.max_products !== null) {
    const creating = ops.filter((o) => o.create).length;
    if (creating && (await countProducts(db)) + creating > plan.max_products) out.push({ line: ops.find((o) => o.create)?.lines[0] ?? 1, message: `the ${plan.label} plan allows ${plan.max_products} products; this file would create ${creating} more` });
  }
  return out;
}
