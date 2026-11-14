import type { ModuleDef } from '../types';
import { offersAdmin } from './routes';
import { offersPublic } from './public';
import { credit } from './lib';

// Offers: upsell and cross-sell in the cart. "When the cart has X, suggest Y (optionally with a discount)".
export const offers: ModuleDef = {
  id: 'offers',
  name: { fr: 'Offres complémentaires', en: 'Offers (upsell)' },
  description: {
    fr: 'Proposez un article complémentaire dans le panier, avec une réduction facultative : « avec ce produit, ajoutez celui-ci ». Le rapport montre combien d’offres sont vues, prises et payées.',
    en: 'Suggest a complementary item in the cart, with an optional discount: "with this product, add that one". The report shows how many offers are seen, taken and paid.',
  },
  version: 1,
  migrate: [
    `CREATE TABLE IF NOT EXISTS offers (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, trigger_kind TEXT NOT NULL, trigger_ref TEXT, offer_sku TEXT NOT NULL,
       discount_pct INTEGER NOT NULL DEFAULT 0, max_qty INTEGER NOT NULL DEFAULT 1, headline_fr TEXT, headline_en TEXT, priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS offer_carts (cart_id TEXT NOT NULL, offer_id TEXT NOT NULL, sku TEXT NOT NULL, unit_cents INTEGER NOT NULL, credited INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (cart_id, offer_id))`,
    `CREATE TABLE IF NOT EXISTS offer_events (id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, kind TEXT NOT NULL, cart_id TEXT, order_id TEXT, amount_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_offer_events_offer ON offer_events(offer_id, kind)`,
  ],
  access: { manager: 'write', staff: 'read' },
  routes: offersAdmin,
  publicRoutes: offersPublic,
  hooks: {
    orderPaid: async (db) => { await credit(db); },
    scheduled: async (db) => { await credit(db); },
  },
};
