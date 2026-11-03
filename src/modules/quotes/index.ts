import type { ModuleDef } from '../types';
import { quoteAdmin } from './routes';
import { quotePublic } from './public';

// Quotations (devis): prepare a priced offer for a customer, send the link by e-mail or WhatsApp,
// the customer accepts or declines on a simple page, and an accepted quote becomes an order.
export const quotes: ModuleDef = {
  id: 'quotes',
  name: { fr: 'Devis', en: 'Quotations' },
  description: {
    fr: 'Préparez un devis chiffré, envoyez le lien au client (e-mail ou WhatsApp), il l’accepte en ligne, puis transformez-le en commande.',
    en: 'Prepare a priced quotation, send the link to the customer (e-mail or WhatsApp), they accept it online, then turn it into an order.',
  },
  version: 1,
  migrate: [
    `CREATE TABLE IF NOT EXISTS quotes (
       id TEXT PRIMARY KEY,
       seq INTEGER NOT NULL UNIQUE,
       number TEXT NOT NULL UNIQUE,
       token TEXT NOT NULL UNIQUE,
       status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'converted')),
       customer_name TEXT,
       customer_email TEXT,
       customer_phone TEXT,
       currency TEXT NOT NULL,
       locale TEXT NOT NULL DEFAULT 'fr',
       items TEXT NOT NULL,
       total_cents INTEGER NOT NULL,
       note TEXT,
       valid_until TEXT NOT NULL,
       order_id TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       sent_at TEXT,
       responded_at TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status)`,
  ],
  access: { manager: 'write', staff: 'read' },
  routes: quoteAdmin,
  publicRoutes: quotePublic,
};
