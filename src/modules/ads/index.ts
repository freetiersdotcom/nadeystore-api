import type { ModuleDef } from '../types';
import { adsAdmin } from './routes';
import { adsPublic } from './public';
import { purgeOld } from './lib';

// Ad tracking: which campaign brought each order, what it cost, and what was left after the costs of the goods.
// Off by default. The storefront only reports a visitor's campaign after they accepted measurement cookies.
export const ads: ModuleDef = {
  id: 'ads',
  name: { fr: 'Suivi des publicités', en: 'Ad tracking' },
  description: {
    fr: 'Sait quelle campagne (Meta, TikTok, Google…) a amené chaque commande, avec un rapport par campagne : ventes, bénéfice, dépenses publicitaires saisies et retour sur investissement.',
    en: 'Knows which campaign (Meta, TikTok, Google…) brought each order, with a per-campaign report: sales, profit, ad spend you enter and return on spend.',
  },
  version: 1,
  migrate: [
    // One row per cart that arrived through a campaign; the order finds it through orders.cart_id.
    `CREATE TABLE IF NOT EXISTS ad_attribution (
       cart_id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '',
       content TEXT NOT NULL DEFAULT '', term TEXT NOT NULL DEFAULT '', click_id_type TEXT NOT NULL DEFAULT '', click_id TEXT NOT NULL DEFAULT '',
       landing TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '', fbp TEXT NOT NULL DEFAULT '', ttp TEXT NOT NULL DEFAULT '',
       ip TEXT, ua TEXT, created_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS ad_spend (
       id TEXT PRIMARY KEY, platform TEXT NOT NULL, campaign TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL,
       amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), currency TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ad_spend_days ON ad_spend(from_day, to_day)`,
  ],
  // Profit figures are private: owner, agency and manager only (like the Profit page), never staff.
  access: { manager: 'write' },
  routes: adsAdmin,
  publicRoutes: adsPublic,
  hooks: { scheduled: async (db) => { await purgeOld(db); } },
};
