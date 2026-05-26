import { Hono } from 'hono';
import Stripe from 'stripe';
import { getDb } from '../db';
import { ApiError, uuid, now, generateOrderNumber, type HonoEnv } from '../types';
import { dispatchWebhooks } from '../lib/webhooks';
import { handleUCPStripeWebhook } from './ucp';

import { createOrderFromCart } from '../lib/orders';
import { verifyFedaPaySignature, verifyFedaPayTransaction } from '../lib/fedapay';

// ============================================================
// WEBHOOK ROUTES
// ============================================================

export const webhooks = new Hono<HonoEnv>();

// POST /v1/webhooks/stripe
webhooks.post('/stripe', async (c) => {
  const signature = c.req.header('stripe-signature');
  const body = await c.req.text();

  if (!signature) throw ApiError.invalidRequest('Missing stripe-signature header');

  const db = getDb(c.var.db);

  // Get stripe keys from config
  const [config] = await db.query<any>(`SELECT * FROM config WHERE key = 'stripe'`);
  if (!config?.value) {
    throw ApiError.invalidRequest('Stripe not configured');
  }

  const stripeConfig = JSON.parse(config.value);
  if (!stripeConfig.webhook_secret) {
    throw ApiError.invalidRequest('Stripe webhook secret not configured');
  }

  // Verify signature
  const stripe = new Stripe(stripeConfig.secret_key);
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, stripeConfig.webhook_secret);
  } catch (e: any) {
    throw new ApiError('webhook_signature_invalid', 400, e.message);
  }

  // Dedupe
  const [existing] = await db.query<any>(`SELECT id FROM events WHERE stripe_event_id = ?`, [
    event.id,
  ]);
  if (existing) return c.json({ ok: true });

  if (event.type === 'checkout.session.completed') {
    const webhookSession = event.data.object as Stripe.Checkout.Session;

    if (webhookSession.metadata?.ucp_checkout_session_id) {
      await handleUCPStripeWebhook(db, webhookSession.id, webhookSession);
    }

    const cartId = webhookSession.metadata?.cart_id;

    if (cartId) {
      // Retrieve full session to get shipping_details (collected by Stripe if enabled)
      const session = await stripe.checkout.sessions.retrieve(webhookSession.id);
      const shippingAddress = session.shipping_details?.address ?? null;
      const shippingName    = session.shipping_details?.name
        ?? session.customer_details?.name ?? null;

      // If Stripe collected shipping, save it to the cart before order creation
      // so createOrderFromCart() picks it up from cart.ship_to
      if (shippingAddress) {
        await db.run(
          `UPDATE carts SET
             ship_to       = ?,
             shipping_name = ?,
             updated_at    = ?
           WHERE id = ?`,
          [
            JSON.stringify({
              line1:       shippingAddress.line1,
              line2:       shippingAddress.line2 ?? null,
              city:        shippingAddress.city,
              state:       shippingAddress.state ?? null,
              postal_code: shippingAddress.postal_code,
              country:     shippingAddress.country,
            }),
            shippingName,
            now(),
            cartId,
          ]
        );
      }

      const storeBaseUrl = (c.env as any).STORE_URL
        ?? (c.env.IMAGES_URL ? new URL(c.env.IMAGES_URL).origin : 'https://yourstore.com');

      await createOrderFromCart(db, c.var.db, c.executionCtx, cartId, {
        provider:     'stripe',
        providerRef:  session.id,
        storeBaseUrl,
        storeName:    c.env.STORE_NAME ?? 'Your Store',
      });
    }
  }

  // Log event
  await db.run(
    `INSERT INTO events (id, stripe_event_id, type, payload) VALUES (?, ?, ?, ?)`,
    [uuid(), event.id, event.type, JSON.stringify(event.data.object)]
  );

  return c.json({ ok: true });
});

// Raw format as POSTed by FedaPay to the webhook endpoint
interface FedaPayRawEvent {
  klass:     string;           // "v1/event"
  id:        string;           // FedaPay event ID (for deduplication)
  type:      string;           // "transaction.approved" | "transaction.declined" etc.
  entity:    string;           // stringified JSON of the transaction object
  object_id: number;           // transaction numeric ID
}

// Shape of the parsed entity string
interface FedaPayTransaction {
  id:               number;
  reference:        string;    // merchant_reference = cartId
  amount:           number;
  status:           string;
  description:      string;
  custom_metadata?: Record<string, string> | null;
  currency_id?:     number;    // currency is a foreign key in the raw format
  metadata?:        Record<string, unknown>;
  // Note: currency ISO is NOT in entity — only currency_id.
  // Use verifyFedaPayTransaction() to get the ISO code if needed,
  // or read it from the cart (cart.currency) which is more reliable.
}

// POST /v1/webhooks/fedapay — CORRECTED
// Raw format as POSTed by FedaPay to the webhook endpoint
interface FedaPayTransaction {
  id:               number;
  reference:        string | null;
  amount:           number;
  status:           string;
  description:      string;
  custom_metadata?: Record<string, string> | null;
  currency?:        { iso: string } | null;
  metadata?:        Record<string, unknown>;
}

interface FedaPayRawEvent {
  name:    string;             // "transaction.approved"
  object:  string;             // "transaction"
  entity:  FedaPayTransaction; // already a parsed object, not a string
  account: Record<string, any>;
}

// POST /v1/webhooks/fedapay
webhooks.post('/fedapay', async (c) => {
  const signature = c.req.header('x-fedapay-signature');
  const body      = await c.req.text();

  if (!signature) throw ApiError.invalidRequest('Missing x-fedapay-signature header');

  const db = getDb(c.var.db);

  const [config] = await db.query<any>(`SELECT * FROM config WHERE key = 'fedapay'`);
  if (!config?.value) throw ApiError.invalidRequest('FedaPay not configured');

  const fedaPayConfig = JSON.parse(config.value);
  if (!fedaPayConfig.webhook_secret) throw ApiError.invalidRequest('FedaPay webhook secret not configured');

  try {
    await verifyFedaPaySignature(body, signature, fedaPayConfig.webhook_secret);
  } catch (e: any) {
    throw new ApiError('webhook_signature_invalid', 400, e.message);
  }

  let rawEvent: FedaPayRawEvent;
  try {
    rawEvent = JSON.parse(body);
  } catch {
    throw ApiError.invalidRequest('Invalid JSON payload');
  }

  const eventType = rawEvent.name;
  const tx        = rawEvent.entity ?? null;
  const txId      = tx?.id ?? null;

  // No stable top-level event ID from FedaPay — construct one from event type + transaction ID
  const dedupKey = `fedapay_evt_${eventType}_${txId}`;

  const [existing] = await db.query<any>(
    `SELECT id FROM events WHERE stripe_event_id = ?`, [dedupKey]
  );
  if (existing) return c.json({ ok: true });

  if (eventType === 'transaction.approved' && tx) {

    // Resolve cart ID — with fallback layers
    let cartId: string | null = tx.custom_metadata?.cart_id ?? null;
	
	console.log(`[fedapay] First attempt cardId cart ${cartId}`);

    if (!cartId && txId) {
      const [row] = await db.query<{ cart_id: string }>(
        `SELECT cart_id FROM fedapay_transactions WHERE transaction_id = ?`, [txId]
      );
      cartId = row?.cart_id ?? null;
    }
	
	console.log(`[fedapay] Second attempt cardId cart ${cartId}`);

    if (cartId) {
      const dbBinding    = c.var.db;
      const storeBaseUrl = (c.env as any).STORE_URL
        ?? (c.env.IMAGES_URL ? new URL(c.env.IMAGES_URL).origin : 'https://yourstore.com');

      c.executionCtx.waitUntil(
        (async () => {
          try {
            const status = await verifyFedaPayTransaction(txId!, fedaPayConfig);
            if (status !== 'approved') {
              console.warn(`[fedapay] API verify: tx ${txId} not approved, aborting`);
              return;
            }
          } catch (err) {
            console.warn(`[fedapay] API verify failed for tx ${txId} (proceeding):`, err);
          }

          await createOrderFromCart(getDb(dbBinding), dbBinding, c.executionCtx, cartId!, {
            provider:    'fedapay',
            providerRef: String(txId),
            storeBaseUrl,
            storeName:   c.env.STORE_NAME ?? 'Your Store',
          });
        })().catch(err => console.error('[fedapay] order creation error:', err))
      );
    } else {
      console.warn(`[fedapay] transaction.approved — could not resolve cart for tx_id: ${txId}`);
    }

  } else {
    console.log(`[fedapay] ${eventType} — tx_id: ${txId}`);
  }

  // Log event
  await db.run(
    `INSERT INTO events (id, stripe_event_id, type, payload) VALUES (?, ?, ?, ?)`,
    [uuid(), dedupKey, eventType, JSON.stringify(rawEvent.entity ?? {})]
  );

  return c.json({ ok: true });
});