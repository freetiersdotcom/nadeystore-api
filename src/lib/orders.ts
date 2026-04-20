// =============================================================================
// src/lib/orders.ts
//
// Provider-agnostic order creation from a checked-out cart.
// Called by both the Stripe and FedaPay webhook handlers after payment
// is confirmed. Knows nothing about which provider fired the event.
//
// Responsibilities:
//   1. Guard against double-processing (cart already processed check)
//   2. Upsert customer and save shipping address
//   3. Create order with all financial fields from the cart
//   4. Create order items and update inventory
//   5. Generate download tokens for digital items
//   6. Mark the cart as processed
//   7. Send order confirmation email
//   8. Dispatch outbound order.created webhook
//
// Returns the created orderId and orderNumber for the caller to log.
//
// Adding a new payment provider: implement a webhook handler that
// verifies the provider's signature and calls createOrderFromCart().
// Nothing in this file needs changing.
// =============================================================================

import type { Database } from '../db';
import type { DOStub } from '../types';
import { uuid, now, generateOrderNumber } from '../types';
import { createDownloadTokens } from './downloads';
import { getEmailProvider } from './email/index';
import { renderOrderConfirmation } from './email/template';
import { dispatchWebhooks } from './webhooks';

export interface OrderResult {
  orderId:     string;
  orderNumber: string;
}

export interface OrderContext {
  /** Provider name for logging — 'stripe', 'fedapay', etc. */
  provider: string;
  /** Provider's transaction/session reference for logging */
  providerRef: string;
  /** Base URL for download links in emails */
  storeBaseUrl: string;
  storeName:    string;
}

// =============================================================================
// createOrderFromCart
// =============================================================================

export async function createOrderFromCart(
  db:      Database,
  doStub:  DOStub,
  ctx:     ExecutionContext,
  cartId:  string,
  ctx_order: OrderContext
): Promise<OrderResult | null> {

  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ? LIMIT 1`, [cartId]);

  if (!cart) {
    console.warn(`[${ctx_order.provider}] Cart ${cartId} not found`);
    return null;
  }

  // Double-processing guard — cart is only processed once
  // (set to 'checked_out' by the checkout route; here we move it to 'expired'
  // to signal the order has been fully created)
  if (cart.status === 'expired') {
    console.log(`[${ctx_order.provider}] Cart ${cartId} already processed, skipping`);
    return null;
  }

  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
  if (!items.length) return null;

  const subtotalCents = items.reduce(
    (sum: number, item: any) => sum + item.unit_price_cents * item.qty, 0
  );

  const discountAmountCents  = cart.discount_amount_cents ?? 0;
  const discountCode         = cart.discount_code ?? null;
  const discountId           = cart.discount_id ?? null;
  const currency             = cart.currency ?? 'USD';
  const customerEmail        = cart.customer_email;
  const totalCents           = subtotalCents - discountAmountCents;

  // Parse shipping address from cart (set via PATCH /v1/carts/:id/shipping)
  let shippingAddress: any = null;
  let shippingName: string | null = cart.shipping_name ?? null;

  if (cart.ship_to) {
    try {
      shippingAddress = JSON.parse(cart.ship_to);
    } catch { /* malformed — proceed without */ }
  }

  const orderId     = uuid();
  const orderNumber = generateOrderNumber();

  // ── Upsert customer ───────────────────────────────────────────────────────
  let customerId: string | null = null;
  const [existingCustomer] = await db.query<any>(
    `SELECT id FROM customers WHERE email = ? LIMIT 1`, [customerEmail]
  );

  if (existingCustomer) {
    customerId = existingCustomer.id;
    await db.run(
      `UPDATE customers SET
         order_count          = order_count + 1,
         total_spent_cents    = total_spent_cents + ?,
         last_order_at        = ?,
         updated_at           = ?
       WHERE id = ?`,
      [totalCents, now(), now(), customerId]
    );
  } else {
    customerId = uuid();
    await db.run(
      `INSERT INTO customers (id, email, order_count, total_spent_cents, last_order_at)
       VALUES (?, ?, 1, ?, ?)`,
      [customerId, customerEmail, totalCents, now()]
    );
  }

  // ── Save shipping address if present ─────────────────────────────────────
  if (shippingAddress && customerId) {
    const [existingAddr] = await db.query<any>(
      `SELECT id FROM customer_addresses
       WHERE customer_id = ? AND line1 = ? AND postal_code = ? LIMIT 1`,
      [customerId, shippingAddress.line1, shippingAddress.postal_code]
    );

    if (!existingAddr) {
      const [addrCount] = await db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM customer_addresses WHERE customer_id = ?`,
        [customerId]
      );
      const isDefault = (addrCount?.count ?? 0) === 0 ? 1 : 0;

      await db.run(
        `INSERT INTO customer_addresses
           (id, customer_id, is_default, name, line1, line2, city, state, postal_code, country)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid(), customerId, isDefault, shippingName,
          shippingAddress.line1, shippingAddress.line2 ?? null,
          shippingAddress.city,  shippingAddress.state ?? null,
          shippingAddress.postal_code, shippingAddress.country,
        ]
      );
    }
  }

  // ── Create order ──────────────────────────────────────────────────────────
  await db.run(
    `INSERT INTO orders
       (id, customer_id, number, status, customer_email,
        shipping_name, shipping_phone, ship_to,
        subtotal_cents, tax_cents, shipping_cents, total_cents, currency,
        discount_code, discount_id, discount_amount_cents)
     VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
    [
      orderId, customerId, orderNumber, customerEmail,
      shippingName, null,
      shippingAddress ? JSON.stringify(shippingAddress) : null,
      subtotalCents,
      totalCents, currency,
      discountCode, discountId, discountAmountCents,
    ]
  );

  // ── Discount usage tracking ───────────────────────────────────────────────
  if (discountId && discountAmountCents > 0) {
    const [existingUsage] = await db.query<any>(
      `SELECT id FROM discount_usage WHERE order_id = ? AND discount_id = ? LIMIT 1`,
      [orderId, discountId]
    );

    if (!existingUsage) {
      await db.run(
        `INSERT INTO discount_usage
           (id, discount_id, order_id, customer_email, discount_amount_cents)
         VALUES (?, ?, ?, ?, ?)`,
        [uuid(), discountId, orderId, customerEmail.toLowerCase(), discountAmountCents]
      );
    }
  }

  // ── Create order items, update inventory, collect variant metadata ────────
  const itemsWithType: Array<{
    sku:             string;
    title:           string;
    qty:             number;
    unit_price_cents: number;
    product_type:    'physical' | 'digital';
  }> = [];

  for (const item of items) {
    await db.run(
      `INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), orderId, item.sku, item.title, item.qty, item.unit_price_cents]
    );

    await db.run(
      `UPDATE inventory SET
         reserved  = reserved - ?,
         on_hand   = on_hand - ?,
         updated_at = ?
       WHERE sku = ?`,
      [item.qty, item.qty, now(), item.sku]
    );

    await db.run(
      `INSERT INTO inventory_logs (id, sku, delta, reason) VALUES (?, ?, ?, 'sale')`,
      [uuid(), item.sku, -item.qty]
    );

    const [variant] = await db.query<{
      product_type:      'physical' | 'digital';
      digital_asset_key: string | null;
    }>(
      `SELECT product_type, digital_asset_key FROM variants WHERE sku = ? LIMIT 1`,
      [item.sku]
    );

    itemsWithType.push({
      sku:             item.sku,
      title:           item.title,
      qty:             item.qty,
      unit_price_cents: item.unit_price_cents,
      product_type:    variant?.product_type ?? 'physical',
    });
  }

  // ── Generate download tokens for digital items ────────────────────────────
  const digitalItems = itemsWithType.filter(i => i.product_type === 'digital');
  let downloadTokens: Array<{ plain_token: string; sku: string }> = [];

  if (digitalItems.length > 0) {
    downloadTokens = await createDownloadTokens(
      db,
      orderId,
      digitalItems.map(i => ({ sku: i.sku }))
    );
  }

  // ── Mark cart as fully processed ──────────────────────────────────────────
  // Use 'expired' to signal order has been created (mirrors Stripe handler).
  await db.run(
    `UPDATE carts SET status = 'expired', updated_at = ? WHERE id = ?`,
    [now(), cartId]
  );

  // ── Send order confirmation email ─────────────────────────────────────────
  try {
    const emailProvider = await getEmailProvider(db);

    if (emailProvider) {
      const tokenBySku = new Map(downloadTokens.map(t => [t.sku, t.plain_token]));

      const { html, text } = renderOrderConfirmation({
        order_number:     orderNumber,
        customer_email:   customerEmail,
        store_name:       ctx_order.storeName,
        store_base_url:   ctx_order.storeBaseUrl,
        items:            itemsWithType.map(item => ({
          sku:             item.sku,
          title:           item.title,
          qty:             item.qty,
          unit_price_cents: item.unit_price_cents,
          product_type:    item.product_type,
          download_token:  item.product_type === 'digital'
            ? tokenBySku.get(item.sku)
            : undefined,
        })),
        subtotal_cents:   subtotalCents,
        discount:         discountCode && discountAmountCents > 0
          ? { code: discountCode, amount_cents: discountAmountCents }
          : null,
        tax_cents:        0,
        shipping_cents:   0,
        total_cents:      totalCents,
        currency,
        shipping_address: shippingAddress
          ? {
              line1:       shippingAddress.line1,
              line2:       shippingAddress.line2 ?? null,
              city:        shippingAddress.city,
              state:       shippingAddress.state ?? null,
              postal_code: shippingAddress.postal_code,
              country:     shippingAddress.country,
            }
          : null,
        shipping_name:    shippingName,
      });

      await emailProvider.send({
        to:      customerEmail,
        subject: `Order confirmed — ${orderNumber}`,
        html,
        text,
      });
    }
  } catch (emailErr: any) {
    // Email failure must never block order creation
    console.error(
      `[${ctx_order.provider}] Email failed for order ${orderNumber}: ${emailErr.message}`
    );
  }

  // ── Dispatch outbound order.created webhook ───────────────────────────────
  const orderItems = await db.query<any>(
    `SELECT * FROM order_items WHERE order_id = ?`, [orderId]
  );

  await dispatchWebhooks(doStub, ctx, 'order.created', {
    order: {
      id:             orderId,
      number:         orderNumber,
      status:         'paid',
      customer_email: customerEmail,
      customer_id:    customerId,
      provider:       ctx_order.provider,
      provider_ref:   ctx_order.providerRef,
      shipping: {
        name:    shippingName,
        address: shippingAddress,
      },
      amounts: {
        subtotal_cents:  subtotalCents,
        discount_cents:  discountAmountCents,
        tax_cents:       0,
        shipping_cents:  0,
        total_cents:     totalCents,
        currency,
      },
      items: orderItems.map((i: any) => ({
        sku:             i.sku,
        title:           i.title,
        qty:             i.qty,
        unit_price_cents: i.unit_price_cents,
      })),
    },
  });

  console.log(
    `[${ctx_order.provider}] Order ${orderNumber} created ` +
    `(cart: ${cartId}, ref: ${ctx_order.providerRef})`
  );

  return { orderId, orderNumber };
}
