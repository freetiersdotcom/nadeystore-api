import type { ModuleDef } from '../types';
import { affiliateAdmin } from './routes';
import { affiliatePublic } from './public';

// Affiliates: partners share a link (or a code) and earn a percentage of the sales they bring.
// Commissions are worked out from the real orders: nothing counts until money has been paid, a refund
// cancels (or reduces) it, and a hold period lets refund windows pass before it becomes payable.
// Payouts are recorded by hand; the module never moves money.
export const affiliates: ModuleDef = {
  id: 'affiliates',
  name: { fr: 'Affiliation', en: 'Affiliates' },
  description: {
    fr: 'Des partenaires partagent un lien ou un code et touchent un pourcentage des ventes payées. Une commande remboursée annule la commission ; les versements sont notés à la main.',
    en: 'Partners share a link or a code and earn a percentage of paid sales. A refunded order cancels the commission; payouts are recorded by hand.',
  },
  version: 1,
  migrate: [
    `CREATE TABLE IF NOT EXISTS affiliates (
       id TEXT PRIMARY KEY,
       code TEXT NOT NULL UNIQUE,
       token TEXT NOT NULL UNIQUE,
       name TEXT NOT NULL,
       email TEXT,
       phone TEXT,
       rate_bp INTEGER NOT NULL CHECK (rate_bp >= 0 AND rate_bp <= 10000),
       status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
       discount_code TEXT,
       note TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    // Which affiliate sent a cart (the storefront reports it when a visitor arrives with ?ref=CODE).
    `CREATE TABLE IF NOT EXISTS affiliate_referrals (
       cart_id TEXT PRIMARY KEY,
       affiliate_id TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
    // One row per attributed order; the rate is frozen here so later edits never rewrite history.
    `CREATE TABLE IF NOT EXISTS affiliate_orders (
       order_id TEXT PRIMARY KEY,
       affiliate_id TEXT NOT NULL,
       rate_bp INTEGER NOT NULL,
       via TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_affiliate_orders_aff ON affiliate_orders(affiliate_id)`,
    `CREATE TABLE IF NOT EXISTS affiliate_payouts (
       id TEXT PRIMARY KEY,
       affiliate_id TEXT NOT NULL,
       amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
       currency TEXT NOT NULL,
       method TEXT NOT NULL,
       reference TEXT,
       note TEXT,
       created_at TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_aff ON affiliate_payouts(affiliate_id)`,
    `CREATE TABLE IF NOT EXISTS affiliate_settings (id INTEGER PRIMARY KEY CHECK (id = 1), hold_days INTEGER NOT NULL DEFAULT 14)`,
    `INSERT OR IGNORE INTO affiliate_settings (id, hold_days) VALUES (1, 14)`,
  ],
  access: { manager: 'read' },
  routes: affiliateAdmin,
  publicRoutes: affiliatePublic,
};
