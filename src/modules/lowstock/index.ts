import type { ModuleDef } from '../types';
import { lowstockAdmin } from './routes';
import { runCheck } from './lib';

// Low-stock alerts: one message when a product crosses its threshold (not every 15 minutes), with the supplier to call.
export const lowstock: ModuleDef = {
  id: 'lowstock',
  name: { fr: 'Alertes de stock bas', en: 'Low-stock alerts' },
  description: {
    fr: 'Soyez prévenu (notification et e-mail) quand un produit passe sous son seuil, avec le fournisseur à contacter et un message de réassort prêt à envoyer.',
    en: 'Get told (notification and e-mail) when a product drops under its threshold, with the supplier to contact and a ready-to-send reorder message.',
  },
  version: 1,
  migrate: [
    `CREATE TABLE IF NOT EXISTS lowstock_suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, note TEXT, created_at TEXT NOT NULL)`,
    // Per-product settings; a product without a row uses the default threshold.
    `CREATE TABLE IF NOT EXISTS lowstock_items (sku TEXT PRIMARY KEY, threshold INTEGER, muted INTEGER NOT NULL DEFAULT 0, supplier_id TEXT, reorder_qty INTEGER)`,
    // What has already been announced, so a product is announced once per drop and again only if it runs out.
    `CREATE TABLE IF NOT EXISTS lowstock_state (sku TEXT PRIMARY KEY, level TEXT NOT NULL CHECK (level IN ('low', 'out')), alerted_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS lowstock_settings (id INTEGER PRIMARY KEY CHECK (id = 1), default_threshold INTEGER NOT NULL DEFAULT 5, emails TEXT NOT NULL DEFAULT '', push INTEGER NOT NULL DEFAULT 1)`,
    `INSERT OR IGNORE INTO lowstock_settings (id) VALUES (1)`,
  ],
  access: { manager: 'write', staff: 'read' },
  routes: lowstockAdmin,
  hooks: {
    orderPaid: async (db) => { await runCheck(db); },
    scheduled: async (db, ctx) => { await runCheck(db, ctx.storeName); },
  },
};
