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
import { payUrl } from './email/planNotice';
import { confirmBookings, getBookingConfig, DEFAULT_TZ } from './appointments';

export interface OrderResult {
  orderId:      string;
  orderNumber:  string;
  needsReview:  boolean;
}

export interface OrderContext {
  /** Provider name for logging — 'stripe', 'fedapay', etc. */
  provider: string;
  /** Provider's transaction/session reference for logging */
  providerRef: string;
  /** Base URL for download links in emails */
  storeBaseUrl: string;
  storeName:    string;
  /**
   * 'online' (default): payment already confirmed by the provider → order is 'paid'.
   * 'cod': pay on delivery → order starts 'pending'; payments are recorded later.
   * 'manual': entered by the merchant → 'pending' too, payments recorded by the caller.
   */
  paymentMethod?: 'online' | 'cod' | 'manual' | 'deposit';
  /** Do not send the confirmation email (counter sales, merchant-entered orders). */
  skipEmail?: boolean;
  /** Deposit checkout: the amount the provider just confirmed, the date the balance is expected, and the pay-link token. */
  deposit?: { amount_cents: number; due_at: string | null; pay_token: string };
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

  // Double-processing guard — keyed on whether an order already exists for
  // this cart, not on cart.status. Status alone can't distinguish "already
  // converted" from "swept as abandoned, but a late webhook just arrived" —
  // and the latter must still create an order, just flagged for review.
  const [existingOrder] = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE cart_id = ? LIMIT 1`, [cartId]
  );
  if (existingOrder) {
    console.log(`[${ctx_order.provider}] Cart ${cartId} already processed, skipping`);
    return null;
  }

  // If the cart is already 'expired' at this point (and no order exists —
  // checked above), it was swept by cleanupStaleCheckedOutCarts for
  // inactivity, and its reserved inventory was already released. The
  // payment is real and must still be recorded, but fulfillment needs a
  // human to confirm stock before shipping.
  let needsReview = cart.status === 'expired';
  const reviewReason = needsReview
    ? 'Payment confirmed after this checkout was auto-expired for inactivity; its inventory hold was already released — verify stock before fulfilling.'
    : null;

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
  const shippingCents        = Math.max(Number(cart.shipping_cents ?? 0), 0);
  const shippingLabel        = cart.shipping_label ?? null;
  const totalCents           = subtotalCents - discountAmountCents + shippingCents;

  // Parse shipping address from cart (set via PATCH /v1/carts/:id/shipping)
  let shippingAddress: any = null;
  let shippingName: string | null = cart.shipping_name ?? null;
  // Phone: from the delivery address, or (service-only carts, no address) from the cart's contact phone.
  let contactPhone: string | null = null;

  if (cart.ship_to) {
    try {
      shippingAddress = JSON.parse(cart.ship_to);
    } catch { /* malformed — proceed without */ }
  }
  contactPhone = shippingAddress?.phone ?? cart.contact_phone ?? null;

  const orderId     = uuid();
  const orderNumber = generateOrderNumber();
  const paymentMethod = ctx_order.paymentMethod ?? 'online';
  const isCod         = paymentMethod !== 'online';   // payment is collected later
  const orderStatus   = isCod ? 'pending' : 'paid';
  const amountPaid    = isCod ? (ctx_order.deposit?.amount_cents ?? 0) : totalCents;
  const paidAt        = isCod ? null : now();
  // Language chosen on the storefront (cart.locale). customers.locale defaults to 'en' and was
  // never written, so it can't be trusted; French is the store's primary language.
  const orderLocale   = cart.locale === 'en' ? 'en' : 'fr';

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

  // Remember the customer's latest language.
  if (customerId) {
    await db.run(`UPDATE customers SET locale = ? WHERE id = ?`, [orderLocale, customerId]);
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
           (id, customer_id, is_default, name, line1, line2, city, state, postal_code, country, phone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid(), customerId, isDefault, shippingName,
          shippingAddress.line1, shippingAddress.line2 ?? null,
          shippingAddress.city,  shippingAddress.state ?? null,
          shippingAddress.postal_code ?? '', shippingAddress.country, shippingAddress.phone ?? null,
        ]
      );
    }
  }

  // Keep the customer's phone: the first one we receive stays until the merchant edits it.
  if (contactPhone && customerId) {
    await db.run(
      `UPDATE customers SET phone = ? WHERE id = ? AND (phone IS NULL OR phone = '')`,
      [contactPhone, customerId]
    );
  }

  // ── Create order ──────────────────────────────────────────────────────────
  await db.run(
    `INSERT INTO orders
       (id, customer_id, number, status, customer_email,
        shipping_name, shipping_phone, ship_to,
        subtotal_cents, tax_cents, shipping_cents, total_cents, currency,
        discount_code, discount_id, discount_amount_cents,
        cart_id, needs_review, review_reason, payment_method, amount_paid_cents, paid_at, locale, shipping_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId, customerId, orderNumber, orderStatus, customerEmail,
      shippingName, contactPhone,
      shippingAddress ? JSON.stringify(shippingAddress) : null,
      subtotalCents,
      shippingCents, totalCents, currency,
      discountCode, discountId, discountAmountCents,
      cartId, needsReview ? 1 : 0, reviewReason, paymentMethod, amountPaid, paidAt, orderLocale, shippingLabel,
    ]
  );

  // Online orders are paid in full by the provider: record it in the payments ledger.
  if (!isCod) {
    await db.run(
      `INSERT INTO order_payments (id, order_id, amount_cents, method, reference) VALUES (?, ?, ?, 'online', ?)`,
      [uuid(), orderId, totalCents, ctx_order.providerRef]
    );
  }

  // Deposit orders: the provider confirmed the deposit; record it and set the balance deadline.
  if (paymentMethod === 'deposit' && ctx_order.deposit) {
    await db.run(
      `INSERT INTO order_payments (id, order_id, amount_cents, method, reference, note) VALUES (?, ?, ?, 'online', ?, 'Deposit')`,
      [uuid(), orderId, ctx_order.deposit.amount_cents, ctx_order.providerRef]
    );
    await db.run(
      `UPDATE orders SET due_at = ?, pay_token = ? WHERE id = ?`,
      [ctx_order.deposit.due_at, ctx_order.deposit.pay_token, orderId]
    );
  }

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
    product_type:    'physical' | 'digital' | 'service';
  }> = [];

  for (const item of items) {
    await db.run(
      `INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), orderId, item.sku, item.title, item.qty, item.unit_price_cents]
    );

    // Digital downloads and services have no stock: nothing was reserved at
    // checkout, so there is nothing to decrement or log.
    const [itemVariant] = await db.query<{
      product_type:      'physical' | 'digital' | 'service';
      digital_asset_key: string | null;
    }>(
      `SELECT product_type, digital_asset_key FROM variants WHERE sku = ? LIMIT 1`,
      [item.sku]
    );
    const itemType = itemVariant?.product_type ?? 'physical';

    itemsWithType.push({
      sku:             item.sku,
      title:           item.title,
      qty:             item.qty,
      unit_price_cents: item.unit_price_cents,
      product_type:    itemType,
    });

    if (itemType !== 'physical') continue;

    // The sale always happened — on_hand is decremented either way. The
    // reservation, though, was already released by the abandonment sweep
    // for a needs_review order, so decrementing it again would make
    // 'reserved' go negative and understate what's actually available.
    if (needsReview) {
      await db.run(
        `UPDATE inventory SET on_hand = on_hand - ?, updated_at = ? WHERE sku = ?`,
        [item.qty, now(), item.sku]
      );
    } else {
      await db.run(
        `UPDATE inventory SET
           reserved  = reserved - ?,
           on_hand   = on_hand - ?,
           updated_at = ?
         WHERE sku = ?`,
        [item.qty, item.qty, now(), item.sku]
      );
    }

    await db.run(
      `INSERT INTO inventory_logs (id, sku, delta, reason) VALUES (?, ?, ?, 'sale')`,
      [uuid(), item.sku, -item.qty]
    );

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

  // ── Services: flag the order for manual scheduling ────────────────────────
  const hasService = itemsWithType.some(i => i.product_type === 'service');
  let serviceStatus: 'to_schedule' | 'scheduled' | null = hasService ? 'to_schedule' : null;
  let bookedAppts: Array<{ title: string; starts_at: string; ends_at: string; tz: string; customer_tz: string | null }> = [];
  if (hasService) {
    await db.run(`UPDATE orders SET service_status = 'to_schedule' WHERE id = ?`, [orderId]);
    // Time slots chosen in the cart become bookings (any provider, any payment method).
    const { booked, lost } = await confirmBookings(db, cartId, orderId);
    for (const a of booked) {
      const [pv] = await db.query<any>(`SELECT product_id FROM variants WHERE sku = ? LIMIT 1`, [a.sku]);
      const cfg = pv ? await getBookingConfig(db, pv.product_id) : null;
      bookedAppts.push({ title: a.title, starts_at: a.starts_at, ends_at: a.ends_at, tz: cfg?.tz ?? DEFAULT_TZ, customer_tz: a.customer_tz });
    }
    const serviceLines = itemsWithType.filter(i => i.product_type === 'service').length;
    if (booked.length > 0 && lost.length === 0 && booked.length >= serviceLines) {
      serviceStatus = 'scheduled';
      await db.run(`UPDATE orders SET service_status = 'scheduled' WHERE id = ?`, [orderId]);
    }
    if (lost.length > 0) {
      needsReview = true;
      const why = 'Appointment slot no longer available after payment — agree on a new time with the customer.';
      await db.run(
        `UPDATE orders SET needs_review = 1, review_reason = CASE WHEN review_reason IS NULL OR review_reason = '' THEN ? ELSE review_reason || ' | ' || ? END WHERE id = ?`,
        [why, why, orderId]);
    }
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

    if (emailProvider && !ctx_order.skipEmail) {
      const tokenBySku = new Map(downloadTokens.map(t => [t.sku, t.plain_token]));

      const { html, text } = renderOrderConfirmation({
        order_number:     orderNumber,
        customer_email:   customerEmail,
        store_name:       ctx_order.storeName,
        locale:           orderLocale,
        store_base_url:   `${ctx_order.storeBaseUrl}/`,
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
        shipping_cents:   shippingCents,
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
        appointments:     bookedAppts.length > 0 ? bookedAppts : undefined,
        payment_method:   paymentMethod === 'deposit' ? 'deposit' : isCod ? 'cod' : 'online',
        plan:             paymentMethod === 'deposit' && ctx_order.deposit
          ? {
              paid_cents:    ctx_order.deposit.amount_cents,
              balance_cents: totalCents - ctx_order.deposit.amount_cents,
              due_at:        ctx_order.deposit.due_at,
              pay_url:       payUrl(ctx_order.storeBaseUrl, orderLocale, ctx_order.deposit.pay_token),
            }
          : undefined,
      });

      await emailProvider.send({
        to:      customerEmail,
        subject: orderEmailSubject(orderNumber, orderLocale, isCod),
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
      status:         orderStatus,
      payment_method: paymentMethod,
      needs_review:   needsReview,
      service_status: serviceStatus,
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
        shipping_cents:  shippingCents,
        total_cents:     totalCents,
        currency,
      },
      items: orderItems.map((i: any) => ({
        sku:             i.sku,
        title:           i.title,
        qty:             i.qty,
        unit_price_cents: i.unit_price_cents,
        product_type:    itemsWithType.find((t) => t.sku === i.sku)?.product_type ?? 'physical',
      })),
    },
  });

  console.log(
    `[${ctx_order.provider}] Order ${orderNumber} created ` +
    `(cart: ${cartId}, ref: ${ctx_order.providerRef})` +
    (needsReview ? ' — NEEDS REVIEW (late payment after cart was auto-expired)' : '')
  );

  return { orderId, orderNumber, needsReview };
}

function orderEmailSubject(orderNumber: string, locale: string | undefined, cod: boolean): string {
  const en = (locale ?? 'fr').slice(0, 2).toLowerCase() === 'en';
  if (cod) return en ? `Order received — ${orderNumber}` : `Commande reçue — ${orderNumber}`;
  return en ? `Order confirmed — ${orderNumber}` : `Commande confirmée — ${orderNumber}`;
}
