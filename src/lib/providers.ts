import Stripe from 'stripe';
import type { Database } from '../db';
import { ApiError } from '../types';
import { PROVIDER_CURRENCIES } from './checkout';
import { createFedaPayCheckout } from './fedapay';

// =============================================================================
// Payment providers for charges that are not a whole-cart checkout:
// deposits, and payments toward an existing order (the pay link).
//
// To add a provider: write an adapter below (isConfigured + createCharge), list its
// currencies in PROVIDER_CURRENCIES (lib/checkout.ts), add it to REGISTRY, and make its
// webhook call settleCharge() (lib/plans.ts) with the charge reference.
// =============================================================================

export type ProviderName = keyof typeof REGISTRY;

export interface ChargeRequest {
  amountCents: number;
  currency: string;
  customerEmail: string;
  description: string;
  returnUrl: string;
  cancelUrl?: string;
  /** Always set: the cart (deposit) or, for a balance payment, the order's cart or id. */
  cartId: string;
  kind: 'deposit' | 'payment';
  orderId?: string;
}

export interface PaymentProvider {
  name: string;
  isConfigured(db: Database, env: ProviderEnv): Promise<boolean>;
  createCharge(db: Database, env: ProviderEnv, req: ChargeRequest): Promise<{ checkout_url: string; ref: string }>;
}

export interface ProviderEnv { STRIPE_SECRET_KEY?: string }

async function configJson(db: Database, key: string): Promise<any | null> {
  const [row] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = ? LIMIT 1`, [key]);
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

const fedapay: PaymentProvider = {
  name: 'fedapay',
  async isConfigured(db) {
    return !!(await configJson(db, 'fedapay'))?.secret_key;
  },
  async createCharge(db, _env, req) {
    const config = await configJson(db, 'fedapay');
    if (!config?.secret_key) throw ApiError.invalidRequest('FedaPay not configured. POST /v1/setup/fedapay first.');
    const r = await createFedaPayCheckout({
      cartId: req.cartId, amountCents: req.amountCents, currency: req.currency,
      customerEmail: req.customerEmail, description: req.description,
      callbackUrl: req.returnUrl, config,
    });
    return { checkout_url: r.checkout_url, ref: String(r.transaction_id) };
  },
};

async function stripeKey(db: Database, env: ProviderEnv): Promise<string | null> {
  return env.STRIPE_SECRET_KEY || (await configJson(db, 'stripe'))?.secret_key || null;
}

const stripe: PaymentProvider = {
  name: 'stripe',
  async isConfigured(db, env) {
    return !!(await stripeKey(db, env));
  },
  async createCharge(db, env, req) {
    const key = await stripeKey(db, env);
    if (!key) throw ApiError.invalidRequest('Stripe not connected. POST /v1/setup/stripe first.');
    const client = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
    const session = await client.checkout.sessions.create({
      mode: 'payment',
      customer_email: req.customerEmail,
      line_items: [{
        price_data: {
          currency: req.currency.toLowerCase(),
          product_data: { name: req.description },
          unit_amount: req.amountCents,
        },
        quantity: 1,
      }],
      success_url: req.returnUrl,
      cancel_url: req.cancelUrl ?? req.returnUrl,
      metadata: { cart_id: req.cartId, kind: req.kind, ...(req.orderId ? { order_id: req.orderId } : {}) },
    });
    if (!session.url) throw new Error('Stripe returned no checkout URL');
    return { checkout_url: session.url, ref: session.id };
  },
};

export const REGISTRY = { fedapay, stripe } as const;

function supports(name: string, currency: string): boolean {
  return (PROVIDER_CURRENCIES[name] ?? []).includes(currency.toUpperCase());
}

/**
 * The provider that will take a charge in `currency`: the preferred one if it supports
 * the currency, otherwise the first configured provider that does.
 */
export async function resolveProvider(
  db: Database, env: ProviderEnv, currency: string, preferred?: string | null
): Promise<PaymentProvider & { name: ProviderName }> {
  const order = [
    ...(preferred && preferred in REGISTRY ? [preferred as ProviderName] : []),
    ...(Object.keys(REGISTRY) as ProviderName[]),
  ];
  for (const name of order) {
    if (supports(name, currency) && (await REGISTRY[name].isConfigured(db, env))) {
      return REGISTRY[name] as PaymentProvider & { name: ProviderName };
    }
  }
  throw ApiError.invalidRequest(`No payment provider is configured for ${currency.toUpperCase()}.`);
}

export async function providerAvailable(db: Database, env: ProviderEnv, currency: string): Promise<boolean> {
  try { await resolveProvider(db, env, currency); return true; } catch { return false; }
}
