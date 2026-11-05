import type { ModuleDef } from '../types';
import { recoveryAdmin } from './routes';
import { recoveryPublic } from './public';
import { runRecovery } from './lib';

// Abandoned-cart recovery: a customer who typed an e-mail at checkout and left without paying gets up to two
// friendly reminders (default 3 h and 48 h later) with a link that refills the cart. One click opts out for good.
export const recovery: ModuleDef = {
  id: 'recovery',
  name: { fr: 'Paniers abandonnés', en: 'Abandoned carts' },
  description: {
    fr: 'Relancez par e-mail les clients qui ont laissé leur adresse puis quitté le paiement : jusqu’à deux rappels avec un lien qui remplit le panier, désinscription en un clic.',
    en: 'E-mail customers who left their address and then abandoned checkout: up to two reminders with a link that refills the cart, one-click opt-out.',
  },
  version: 1,
  migrate: [
    // One row per abandoned cart. The items are copied because the core deletes them shortly after a cart expires.
    `CREATE TABLE IF NOT EXISTS recovery_carts (
       cart_id TEXT PRIMARY KEY,
       token TEXT NOT NULL UNIQUE,
       email TEXT NOT NULL,
       locale TEXT,
       currency TEXT NOT NULL,
       items_json TEXT NOT NULL,
       total_cents INTEGER NOT NULL,
       cart_at TEXT NOT NULL,
       step INTEGER NOT NULL DEFAULT 0,
       tries INTEGER NOT NULL DEFAULT 0,
       first_sent_at TEXT,
       last_sent_at TEXT,
       resumed_at TEXT,
       closed TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_recovery_email ON recovery_carts(email)`,
    `CREATE TABLE IF NOT EXISTS recovery_optout (email TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS recovery_settings (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       origin TEXT,
       step1_hours INTEGER NOT NULL DEFAULT 3,
       step2_hours INTEGER NOT NULL DEFAULT 48,
       discount_code TEXT,
       cooldown_days INTEGER NOT NULL DEFAULT 3,
       max_age_days INTEGER NOT NULL DEFAULT 7
     )`,
    `INSERT OR IGNORE INTO recovery_settings (id) VALUES (1)`,
  ],
  access: { manager: 'write', staff: 'read' },
  routes: recoveryAdmin,
  publicRoutes: recoveryPublic,
  hooks: { scheduled: async (db, ctx) => { await runRecovery(db, ctx); } },
};
