import type { ModuleDef } from '../types';
import { voucherAdmin } from './routes';
import { voucherPublic } from './public';
import { reconcile } from './lib';
import { runVoucherCheck } from './alerts';

// WiFi / access vouchers: you load the codes your hotspot already knows (from MikroTik User Manager, Mikhmon…),
// link them to products, and each paid order (online, mobile money, cash at the counter) receives its code(s)
// automatically: on the confirmation page, on a private link and by e-mail when there is an address.
// If the codes run out, paid orders wait and are served first-come-first-served as soon as you load more.
export const vouchers: ModuleDef = {
  id: 'vouchers',
  name: { fr: 'Tickets WiFi', en: 'WiFi vouchers' },
  description: {
    fr: 'Vendez des tickets WiFi (hotspot MikroTik, Mikhmon…) : organisez vos sites et forfaits, chargez vos codes, et chaque commande payée reçoit son ticket automatiquement, même en cas de vente au comptoir.',
    en: 'Sell access codes (MikroTik hotspot, Mikhmon…): organise locations and plans, load your codes, and every paid order gets its code automatically, counter sales included.',
  },
  version: 3,
  migrate: [
    // A plan is a product variant (its price, name and stock label live in the catalog) that is sold as a code.
    `CREATE TABLE IF NOT EXISTS voucher_plans (
       sku TEXT PRIMARY KEY,
       instructions_fr TEXT,
       instructions_en TEXT,
       created_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS voucher_codes (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       sku TEXT NOT NULL,
       username TEXT NOT NULL UNIQUE,
       password TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'sold', 'void')),
       batch TEXT,
       order_id TEXT,
       order_item_id TEXT,
       slot INTEGER,
       created_at TEXT NOT NULL,
       sold_at TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_voucher_codes_sku_status ON voucher_codes(sku, status)`,
    // One code per unit bought: the same order line can never be given the same slot twice, even by two requests at once.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_voucher_codes_slot ON voucher_codes(order_item_id, slot) WHERE order_item_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_voucher_codes_order ON voucher_codes(order_id)`,
    `CREATE TABLE IF NOT EXISTS voucher_orders (
       order_id TEXT PRIMARY KEY,
       token TEXT NOT NULL UNIQUE,
       emailed_at TEXT,
       email_tries INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS voucher_settings (id INTEGER PRIMARY KEY CHECK (id = 1), origin TEXT)`,
    `INSERT OR IGNORE INTO voucher_settings (id, origin) VALUES (1, NULL)`,
    // Low-code alerts (version 2): per-plan threshold, what has already been announced, and the shared settings.
    `CREATE TABLE IF NOT EXISTS voucher_low (sku TEXT PRIMARY KEY, threshold INTEGER, muted INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS voucher_low_state (sku TEXT PRIMARY KEY, level TEXT NOT NULL CHECK (level IN ('low', 'out')), alerted_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS voucher_alert_settings (id INTEGER PRIMARY KEY CHECK (id = 1), default_threshold INTEGER NOT NULL DEFAULT 10, emails TEXT NOT NULL DEFAULT '', push INTEGER NOT NULL DEFAULT 1)`,
    `INSERT OR IGNORE INTO voucher_alert_settings (id) VALUES (1)`,
    // Locations (version 3): a location is the catalog product that holds one or more plans (variants). Its instructions are the default for its plans.
    `CREATE TABLE IF NOT EXISTS voucher_locations (product_id TEXT PRIMARY KEY, instructions_fr TEXT, instructions_en TEXT, created_at TEXT NOT NULL)`,
    `INSERT OR IGNORE INTO voucher_locations (product_id, created_at) SELECT DISTINCT v.product_id, datetime('now') FROM voucher_plans p JOIN variants v ON v.sku = p.sku`,
  ],
  access: { manager: 'write', staff: 'read' },
  hooks: {
    orderPaid: async (db) => { await reconcile(db); await runVoucherCheck(db); },
    scheduled: async (db, ctx) => { await runVoucherCheck(db, ctx.storeName); },
  },
  routes: voucherAdmin,
  publicRoutes: voucherPublic,
};
