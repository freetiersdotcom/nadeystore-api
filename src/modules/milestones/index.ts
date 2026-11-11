import type { ModuleDef } from '../types';
import { msAdmin } from './routes';
import { msPublic } from './public';

// Milestone payments: split an order into named stages ("30% on signing, 40% at delivery, 30% at the end").
// The customer sees the whole schedule on the payment page; the merchant asks for each stage when it is reached.
export const milestones: ModuleDef = {
  id: 'milestones',
  name: { fr: 'Paiements par étapes', en: 'Milestone payments' },
  description: {
    fr: 'Découpez une commande en étapes de paiement (acompte, livraison, solde…). Le client voit tout le calendrier sur la page de paiement ; vous demandez chaque étape quand elle est atteinte.',
    en: 'Split an order into payment stages (deposit, delivery, balance…). The customer sees the whole schedule on the payment page; you request each stage when it is reached.',
  },
  version: 1,
  migrate: [
    `CREATE TABLE IF NOT EXISTS ms_schedules (order_id TEXT PRIMARY KEY, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ms_stages (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, pos INTEGER NOT NULL, label TEXT NOT NULL, amount_cents INTEGER NOT NULL, expected_on TEXT, requested_at TEXT, created_at TEXT NOT NULL, UNIQUE (order_id, pos))`,
    `CREATE INDEX IF NOT EXISTS idx_ms_stages_order ON ms_stages(order_id)`,
  ],
  access: { manager: 'write', staff: 'read' },
  routes: msAdmin,
  publicRoutes: msPublic,
};
