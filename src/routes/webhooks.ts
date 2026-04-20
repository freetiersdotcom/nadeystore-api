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

  const payload    = JSON.parse(body) as { name: string; object: any };
  const eventName  = payload.name;
  const tx         = payload.object;
  const eventId    = `fedapay_${tx.id}_${eventName}`;

  const [existing] = await db.query<any>(
    `SELECT id FROM events WHERE stripe_event_id = ?`, [eventId]
  );
  if (existing) return c.json({ ok: true });

  if (eventName === 'transaction.approved') {
    const cartId = tx.reference ?? tx.custom_metadata?.cart_id;

    if (cartId) {
      c.executionCtx.waitUntil((async () => {
        try {
          // Optional API re-verify
          const status = await verifyFedaPayTransaction(tx.id, fedaPayConfig);
          if (status !== 'approved') {
            console.warn(`[fedapay] API verify: tx ${tx.id} not approved`);
            return;
          }
        } catch (err) {
          console.warn(`[fedapay] API verify failed (proceeding):`, err);
        }

        const storeBaseUrl = (c.env as any).STORE_URL
          ?? (c.env.IMAGES_URL ? new URL(c.env.IMAGES_URL).origin : 'https://yourstore.com');

        await createOrderFromCart(db as any, c.var.db, c.executionCtx, cartId, {
          provider:     'fedapay',
          providerRef:  String(tx.id),
          storeBaseUrl,
          storeName:    c.env.STORE_NAME ?? 'Your Store',
        });
      })().catch(err => console.error('[fedapay] order creation error:', err)));
    }
  }

  await db.run(
    `INSERT INTO events (id, stripe_event_id, type, payload) VALUES (?, ?, ?, ?)`,
    [uuid(), eventId, eventName, JSON.stringify(tx)]
  );

  return c.json({ ok: true });
});
