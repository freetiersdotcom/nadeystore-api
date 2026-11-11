import type { ModuleDef } from '../types';
import { subsAdmin } from './routes';
import { subsPublic } from './public';
import { tick } from './lib';

// Subscriptions: put a recurring plan on any existing product. Each cycle is a normal order paid through a pay link.
export const subs: ModuleDef = {
  id: 'subs',
  name: { fr: 'Abonnements', en: 'Subscriptions' },
  description: {
    fr: 'Proposez un produit existant « tous les mois » (ou toutes les semaines). Chaque échéance crée une commande avec un lien de paiement envoyé au client ; le client peut mettre en pause, sauter ou arrêter depuis un lien privé.',
    en: 'Offer an existing product “every month” (or every week). Each cycle creates an order with a pay link sent to the customer; the customer can pause, skip or stop from a private link.',
  },
  version: 1,
  migrate: [
    `CREATE TABLE IF NOT EXISTS sub_plans (id TEXT PRIMARY KEY, sku TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, every_n INTEGER NOT NULL, price_cents INTEGER NOT NULL, max_cycles INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_plans_sku ON sub_plans(sku)`,
    `CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, plan_id TEXT, sku TEXT NOT NULL, title TEXT NOT NULL, qty INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL, currency TEXT NOT NULL,
       email TEXT NOT NULL, name TEXT, phone TEXT, locale TEXT NOT NULL DEFAULT 'fr', ship_to TEXT, shipping_cents INTEGER NOT NULL DEFAULT 0, shipping_label TEXT,
       status TEXT NOT NULL, pause_reason TEXT, unit TEXT NOT NULL, every_n INTEGER NOT NULL, max_cycles INTEGER, start_at TEXT NOT NULL, period INTEGER NOT NULL DEFAULT 0, billed INTEGER NOT NULL DEFAULT 0, cycles_done INTEGER NOT NULL DEFAULT 0,
       next_due_at TEXT NOT NULL, waiting_stock INTEGER NOT NULL DEFAULT 0, source_order_id TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_subs_due ON subscriptions(status, next_due_at)`,
    `CREATE INDEX IF NOT EXISTS idx_subs_email ON subscriptions(email)`,
    `CREATE TABLE IF NOT EXISTS sub_orders (order_id TEXT PRIMARY KEY, sub_id TEXT NOT NULL, cycle INTEGER NOT NULL, due_at TEXT NOT NULL, counted INTEGER NOT NULL DEFAULT 0, reminded_at TEXT, closed TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_orders_sub ON sub_orders(sub_id)`,
    `CREATE TABLE IF NOT EXISTS sub_carts (cart_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sub_settings (id INTEGER PRIMARY KEY CHECK (id = 1), lead_days INTEGER NOT NULL DEFAULT 3, remind_days INTEGER NOT NULL DEFAULT 1, grace_days INTEGER NOT NULL DEFAULT 3, origin TEXT)`,
    `INSERT OR IGNORE INTO sub_settings (id) VALUES (1)`,
  ],
  access: { manager: 'write', staff: 'read' },
  routes: subsAdmin,
  publicRoutes: subsPublic,
  hooks: {
    orderPaid: async (db) => { await tick(db, { storeBaseUrl: '', storeName: '' }); },
    scheduled: async (db, ctx) => { await tick(db, ctx); },
  },
};
