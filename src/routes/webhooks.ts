import { Hono } from 'hono';
import Stripe from 'stripe';
import { getDb } from '../db';
import { ApiError, uuid, now, generateOrderNumber, type HonoEnv } from '../types';
import { dispatchWebhooks } from '../lib/webhooks';
import { handleUCPStripeWebhook } from './ucp';
import { getEmailProvider } from '../lib/email/index';
import { renderOrderConfirmation } from '../lib/email/template';
import { createDownloadTokens } from '../lib/downloads';

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
      const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
      if (cart) {
        const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);

        // Retrieve full session from Stripe to get shipping_details
        const session = await stripe.checkout.sessions.retrieve(webhookSession.id);

        // Handle discount
        let discountCode = null;
        let discountId = null;
        let discountAmountCents = 0;
        let discount: any = null;

        if (session.metadata?.discount_id) {
          const [discountRow] = await db.query<any>(`SELECT * FROM discounts WHERE id = ?`, [
            session.metadata.discount_id,
          ]);

          if (discountRow) {
            discount = discountRow;
            discountCode = discount.code;
            discountId = discount.id;
            discountAmountCents = cart.discount_amount_cents || 0;
          }
        }

        const subtotalCents = items.reduce(
          (sum: number, item: any) => sum + item.unit_price_cents * item.qty,
          0
        );

        const orderNumber = generateOrderNumber();
        const customerEmail = cart.customer_email;
        const shippingName =
          session.shipping_details?.name || session.customer_details?.name || null;
        const shippingPhone =
          session.shipping_details?.phone || session.customer_details?.phone || null;
        const shippingAddress = session.shipping_details?.address || null;

        // Upsert customer
        let customerId: string | null = null;
        const [existingCustomer] = await db.query<any>(
          `SELECT id, order_count, total_spent_cents FROM customers WHERE email = ?`,
          [customerEmail]
        );

        if (existingCustomer) {
          customerId = existingCustomer.id;
          await db.run(
            `UPDATE customers SET 
              name = COALESCE(?, name),
              phone = COALESCE(?, phone),
              order_count = order_count + 1,
              total_spent_cents = total_spent_cents + ?,
              last_order_at = ?,
              updated_at = ?
            WHERE id = ?`,
            [shippingName, shippingPhone, session.amount_total ?? 0, now(), now(), customerId]
          );
        } else {
          customerId = uuid();
          await db.run(
            `INSERT INTO customers (id, email, name, phone, order_count, total_spent_cents, last_order_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
            [customerId, customerEmail, shippingName, shippingPhone, session.amount_total ?? 0, now()]
          );
        }

        // Save shipping address
        if (shippingAddress && customerId) {
          const [existingAddress] = await db.query<any>(
            `SELECT id FROM customer_addresses WHERE customer_id = ? AND line1 = ? AND postal_code = ?`,
            [customerId, shippingAddress.line1, shippingAddress.postal_code]
          );

          if (!existingAddress) {
            const [addressCount] = await db.query<any>(
              `SELECT COUNT(*) as count FROM customer_addresses WHERE customer_id = ?`,
              [customerId]
            );
            const isDefault = addressCount.count === 0 ? 1 : 0;

            await db.run(
              `INSERT INTO customer_addresses (id, customer_id, is_default, name, line1, line2, city, state, postal_code, country, phone)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                uuid(), customerId, isDefault, shippingName,
                shippingAddress.line1, shippingAddress.line2 || null,
                shippingAddress.city, shippingAddress.state,
                shippingAddress.postal_code, shippingAddress.country, shippingPhone,
              ]
            );
          }
        }

        // Create order
        const orderId = uuid();
        await db.run(
          `INSERT INTO orders (id, customer_id, number, status, customer_email, 
           shipping_name, shipping_phone, ship_to,
           subtotal_cents, tax_cents, shipping_cents, total_cents, currency,
           discount_code, discount_id, discount_amount_cents,
           stripe_checkout_session_id, stripe_payment_intent_id)
           VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId, customerId, orderNumber, customerEmail,
            shippingName, shippingPhone,
            shippingAddress ? JSON.stringify(shippingAddress) : null,
            subtotalCents,
            session.total_details?.amount_tax ?? 0,
            session.total_details?.amount_shipping ?? 0,
            session.amount_total ?? 0,
            cart.currency,
            discountCode, discountId, discountAmountCents,
            session.id, session.payment_intent,
          ]
        );

        // Discount usage tracking
        if (discountId && discountAmountCents > 0) {
          const [existingUsage] = await db.query<any>(
            `SELECT id FROM discount_usage WHERE order_id = ? AND discount_id = ?`,
            [orderId, discountId]
          );

          if (!existingUsage) {
            if (discount?.usage_limit_per_customer !== null) {
              const usageId = uuid();
              const customerEmailLower = cart.customer_email.toLowerCase();
              const result = await db.run(
                `INSERT INTO discount_usage (id, discount_id, order_id, customer_email, discount_amount_cents)
                 SELECT ?, ?, ?, ?, ?
                 WHERE (
                   SELECT COUNT(*) FROM discount_usage 
                   WHERE discount_id = ? AND customer_email = ?
                 ) < ?`,
                [usageId, discountId, orderId, customerEmailLower, discountAmountCents,
                 discountId, customerEmailLower, discount.usage_limit_per_customer]
              );

              if (result.changes === 0) {
                console.warn(
                  `Discount usage limit exceeded for customer ${customerEmailLower} and discount ${discountId}, ` +
                    `but order ${orderId} already created (payment succeeded). Race condition.`
                );
              }
            } else {
              await db.run(
                `INSERT INTO discount_usage (id, discount_id, order_id, customer_email, discount_amount_cents)
                 VALUES (?, ?, ?, ?, ?)`,
                [uuid(), discountId, orderId, cart.customer_email.toLowerCase(), discountAmountCents]
              );
            }
          }
        }

        // Create order items, update inventory, and collect variant metadata
        // We fetch variant product_type here so the email template knows what to render
        const itemsWithType: Array<{
          sku: string;
          title: string;
          qty: number;
          unit_price_cents: number;
          product_type: 'physical' | 'digital';
          digital_asset_key: string | null;
        }> = [];

        for (const item of items) {
          await db.run(
            `INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
            [uuid(), orderId, item.sku, item.title, item.qty, item.unit_price_cents]
          );

          await db.run(
            `UPDATE inventory SET reserved = reserved - ?, on_hand = on_hand - ?, updated_at = ? WHERE sku = ?`,
            [item.qty, item.qty, now(), item.sku]
          );

          await db.run(
            `INSERT INTO inventory_logs (id, sku, delta, reason) VALUES (?, ?, ?, 'sale')`,
            [uuid(), item.sku, -item.qty]
          );

          const [variant] = await db.query<{
            product_type: 'physical' | 'digital';
            digital_asset_key: string | null;
          }>(
            `SELECT product_type, digital_asset_key FROM variants WHERE sku = ? LIMIT 1`,
            [item.sku]
          );

          itemsWithType.push({
            sku: item.sku,
            title: item.title,
            qty: item.qty,
            unit_price_cents: item.unit_price_cents,
            product_type: variant?.product_type ?? 'physical',
            digital_asset_key: variant?.digital_asset_key ?? null,
          });
        }

        // Generate download tokens for digital items
        const digitalItems = itemsWithType.filter(i => i.product_type === 'digital');
        let downloadTokens: Array<{ plain_token: string; sku: string }> = [];

        if (digitalItems.length > 0) {
          downloadTokens = await createDownloadTokens(
            db,
            orderId,
            digitalItems.map(i => ({ sku: i.sku }))
          );
        }

        // Mark cart as expired
        await db.run(`UPDATE carts SET status = 'expired', updated_at = ? WHERE id = ?`, [
          now(), cartId,
        ]);

        // Send order confirmation email (best-effort, never fail the webhook)
        try {
          const emailProvider = await getEmailProvider(db);

          if (emailProvider) {
            // Build store base URL for download links
            // Falls back to IMAGES_URL domain if STORE_URL isn't set
            const storeBaseUrl = (c.env as any).STORE_URL
              ?? (c.env.IMAGES_URL ? new URL(c.env.IMAGES_URL).origin : 'https://yourstore.com');
            const storeName = c.env.STORE_NAME ?? 'Your Store';

            // Map items to template format, attaching download tokens for digital items
            const tokenBySkU = new Map(downloadTokens.map(t => [t.sku, t.plain_token]));

            const templateItems = itemsWithType.map(item => ({
              sku: item.sku,
              title: item.title,
              qty: item.qty,
              unit_price_cents: item.unit_price_cents,
              product_type: item.product_type,
              download_token: item.product_type === 'digital'
                ? tokenBySkU.get(item.sku)
                : undefined,
            }));

            const { html, text } = renderOrderConfirmation({
              order_number: orderNumber,
              customer_email: customerEmail,
              store_name: storeName,
              store_base_url: storeBaseUrl,
              items: templateItems,
              subtotal_cents: subtotalCents,
              discount: discountCode
                ? { code: discountCode, amount_cents: discountAmountCents }
                : null,
              tax_cents: session.total_details?.amount_tax ?? 0,
              shipping_cents: session.total_details?.amount_shipping ?? 0,
              total_cents: session.amount_total ?? 0,
              currency: cart.currency,
              shipping_address: shippingAddress
                ? {
                    line1: shippingAddress.line1,
                    line2: shippingAddress.line2,
                    city: shippingAddress.city,
                    state: shippingAddress.state,
                    postal_code: shippingAddress.postal_code,
                    country: shippingAddress.country,
                  }
                : null,
              shipping_name: shippingName,
            });

            await emailProvider.send({
              to: customerEmail,
              subject: `Order confirmed — ${orderNumber}`,
              html,
              text,
            });
          }
        } catch (emailErr: any) {
          // Email failure must never break order creation
          console.error(`Failed to send order confirmation for ${orderNumber}: ${emailErr.message}`);
        }

        // Dispatch order.created webhook
        const orderItems = await db.query<any>(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
        await dispatchWebhooks(c.var.db, c.executionCtx, 'order.created', {
          order: {
            id: orderId,
            number: orderNumber,
            status: 'paid',
            customer_email: customerEmail,
            customer_id: customerId,
            shipping: {
              name: shippingName,
              phone: shippingPhone,
              address: shippingAddress,
            },
            amounts: {
              subtotal_cents: session.amount_subtotal ?? 0,
              tax_cents: session.total_details?.amount_tax ?? 0,
              shipping_cents: session.total_details?.amount_shipping ?? 0,
              total_cents: session.amount_total ?? 0,
              currency: cart.currency,
            },
            items: orderItems.map((i: any) => ({
              sku: i.sku,
              title: i.title,
              qty: i.qty,
              unit_price_cents: i.unit_price_cents,
            })),
            stripe: {
              checkout_session_id: session.id,
              payment_intent_id: session.payment_intent,
            },
          },
        });
      }
    }
  }

  // Log event
  await db.run(
    `INSERT INTO events (id, stripe_event_id, type, payload) VALUES (?, ?, ?, ?)`,
    [uuid(), event.id, event.type, JSON.stringify(event.data.object)]
  );

  return c.json({ ok: true });
});
