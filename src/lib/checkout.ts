// =============================================================================
// src/lib/checkout.ts
//
// Provider-agnostic pre-checkout preparation.
// Called by both the Stripe and FedaPay checkout routes before any
// provider-specific session creation.
//
// Responsibilities:
//   1. Atomically lock the cart (status → 'checked_out')
//   2. Load and validate cart items
//   3. Validate, apply, and reserve any discount
//   4. Reserve inventory for all items
//   5. Read pre-collected shipping address from the cart (if set)
//   6. Resolve the effective currency for the given provider
//   7. Return everything the checkout route and order handler need
//
// On any failure, the cart is reverted to 'open' and inventory/discount
// reservations are released. The caller can throw immediately.
//
// Adding a new payment provider requires zero changes here.
// =============================================================================

import type { Database } from '../db';
import { ApiError, uuid, now } from '../types';
import { validateDiscount, calculateDiscount, type Discount } from '../routes/discounts';

// Currencies natively supported by each provider.
// If the cart currency is not in the provider's list, we either convert
// (future) or return an error (current safe default).
const PROVIDER_CURRENCIES: Record<string, string[]> = {
  stripe:    ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK'],
  fedapay:   ['XOF', 'EUR', 'USD', 'GBP'],
  paystack:  ['NGN', 'USD', 'GBP', 'ZAR', 'GHS', 'KES'],
  // Add future providers here
};

export interface PreparedCheckout {
  cart:                 CartRow;
  items:                CartItemRow[];
  subtotal_cents:       number;
  discount_amount_cents: number;
  final_amount_cents:   number;   // subtotal - discount; what to charge the customer
  currency:             string;
  discount:             Discount | null;
  shipping_address:     ShippingAddress | null;
  /** Release all reservations — call on provider API failure */
  rollback:             () => Promise<void>;
}

interface CartRow {
  id:                   string;
  customer_email:       string;
  currency:             string;
  discount_id:          string | null;
  discount_code:        string | null;
  discount_amount_cents: number;
  ship_to:              string | null;  // JSON string
  shipping_name:        string | null;
}

interface CartItemRow {
  id:              string;
  cart_id:         string;
  sku:             string;
  title:           string;
  qty:             number;
  unit_price_cents: number;
}

export interface ShippingAddress {
  name:        string | null;
  line1:       string;
  line2:       string | null;
  city:        string;
  state:       string | null;
  postal_code: string;
  country:     string;
}

// =============================================================================
// prepareCheckout
// =============================================================================

export async function prepareCheckout(
  db: Database,
  cartId: string,
  provider: string
): Promise<PreparedCheckout> {

  // ── 1. Atomically lock the cart ───────────────────────────────────────────
  // Use a single UPDATE with WHERE status = 'open' to avoid race conditions.
  const lockResult = await db.run(
    `UPDATE carts SET status = 'checked_out', updated_at = ?
     WHERE id = ? AND status = 'open'`,
    [now(), cartId]
  );

  if (lockResult.changes === 0) {
    const [existing] = await db.query<{ status: string }>(
      `SELECT status FROM carts WHERE id = ? LIMIT 1`, [cartId]
    );
    if (!existing) throw ApiError.notFound('Cart not found');
    throw ApiError.conflict('Cart is not open');
  }

  const [cart] = await db.query<CartRow>(`SELECT * FROM carts WHERE id = ? LIMIT 1`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');

  // ── 2. Load items ─────────────────────────────────────────────────────────
  const items = await db.query<CartItemRow>(
    `SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]
  );

  if (items.length === 0) {
    await db.run(`UPDATE carts SET status = 'open', updated_at = ? WHERE id = ?`, [now(), cartId]);
    throw ApiError.invalidRequest('Cart is empty');
  }

  const subtotalCents = items.reduce(
    (sum, item) => sum + item.unit_price_cents * item.qty, 0
  );

  // ── 3. Validate and reserve discount ─────────────────────────────────────
  let discountAmountCents = cart.discount_amount_cents ?? 0;
  let discount: Discount | null = null;
  let discountReserved = false;

  if (cart.discount_id) {
    const [discountRow] = await db.query<any>(
      `SELECT * FROM discounts WHERE id = ?`, [cart.discount_id]
    );

    if (discountRow) {
      discount = discountRow as Discount;

      try {
        await validateDiscount(db, discount, subtotalCents, cart.customer_email);
      } catch (err) {
        // Discount invalid — clear it and proceed without
        await db.run(
          `UPDATE carts SET discount_code = NULL, discount_id = NULL,
           discount_amount_cents = 0, updated_at = ? WHERE id = ?`,
          [now(), cartId]
        );
        discount = null;
        discountAmountCents = 0;
      }

      if (discount && discount.usage_limit !== null) {
        const currentTime = now();
        const result = await db.run(
          `UPDATE discounts
           SET usage_count = usage_count + 1, updated_at = ?
           WHERE id = ?
             AND status = 'active'
             AND (starts_at IS NULL OR starts_at <= ?)
             AND (expires_at IS NULL OR expires_at >= ?)
             AND usage_count < usage_limit`,
          [currentTime, discount.id, currentTime, currentTime]
        );

        if (result.changes === 0) {
          await db.run(
            `UPDATE carts SET discount_code = NULL, discount_id = NULL,
             discount_amount_cents = 0, updated_at = ? WHERE id = ?`,
            [now(), cartId]
          );
          discount = null;
          discountAmountCents = 0;
        } else {
          discountReserved = true;
          discountAmountCents = calculateDiscount(discount, subtotalCents);
        }
      } else if (discount) {
        discountAmountCents = calculateDiscount(discount, subtotalCents);
      }
    } else {
      // Discount row gone — clear reference
      await db.run(
        `UPDATE carts SET discount_code = NULL, discount_id = NULL,
         discount_amount_cents = 0, updated_at = ? WHERE id = ?`,
        [now(), cartId]
      );
      discount = null;
      discountAmountCents = 0;
    }
  }

  // ── 4. Reserve inventory ──────────────────────────────────────────────────
  const reservedSkus: { sku: string; qty: number }[] = [];

  for (const item of items) {
    const result = await db.run(
      `UPDATE inventory SET reserved = reserved + ?, updated_at = ?
       WHERE sku = ? AND on_hand - reserved >= ?`,
      [item.qty, now(), item.sku, item.qty]
    );

    if (result.changes === 0) {
      // Release already-reserved inventory before throwing
      for (const r of reservedSkus) {
        await db.run(
          `UPDATE inventory SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE sku = ?`,
          [r.qty, now(), r.sku]
        );
      }
      if (discountReserved && discount) {
        await db.run(
          `UPDATE discounts SET usage_count = MAX(usage_count - 1, 0), updated_at = ? WHERE id = ?`,
          [now(), discount.id]
        );
      }
      await db.run(
        `UPDATE carts SET status = 'open', updated_at = ? WHERE id = ?`, [now(), cartId]
      );
      throw ApiError.insufficientInventory(item.sku);
    }

    reservedSkus.push({ sku: item.sku, qty: item.qty });
  }

  // ── 5. Read pre-collected shipping address ────────────────────────────────
  let shippingAddress: ShippingAddress | null = null;

  if (cart.ship_to) {
    try {
      const parsed = JSON.parse(cart.ship_to);
      shippingAddress = {
        name:        cart.shipping_name ?? null,
        line1:       parsed.line1,
        line2:       parsed.line2 ?? null,
        city:        parsed.city,
        state:       parsed.state ?? null,
        postal_code: parsed.postal_code,
        country:     parsed.country,
      };
    } catch {
      // Malformed shipping data — proceed without
    }
  }

  // ── 6. Resolve currency ───────────────────────────────────────────────────
  const cartCurrency = (cart.currency ?? 'USD').toUpperCase();
  const supportedCurrencies = PROVIDER_CURRENCIES[provider.toLowerCase()];

  // If we don't know the provider's currencies yet (new provider), allow any
  if (supportedCurrencies && !supportedCurrencies.includes(cartCurrency)) {
    // Release everything before throwing
    for (const r of reservedSkus) {
      await db.run(
        `UPDATE inventory SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE sku = ?`,
        [r.qty, now(), r.sku]
      );
    }
    if (discountReserved && discount) {
      await db.run(
        `UPDATE discounts SET usage_count = MAX(usage_count - 1, 0), updated_at = ? WHERE id = ?`,
        [now(), discount.id]
      );
    }
    await db.run(
      `UPDATE carts SET status = 'open', updated_at = ? WHERE id = ?`, [now(), cartId]
    );
    throw ApiError.invalidRequest(
      `Currency ${cartCurrency} is not supported by ${provider}. ` +
      `Supported: ${supportedCurrencies.join(', ')}.`
    );
  }

  // ── 7. Build rollback function ────────────────────────────────────────────
  const rollback = async (): Promise<void> => {
    await db.run(
      `UPDATE carts SET status = 'open', updated_at = ? WHERE id = ?`, [now(), cartId]
    );
    for (const r of reservedSkus) {
      await db.run(
        `UPDATE inventory SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE sku = ?`,
        [r.qty, now(), r.sku]
      );
    }
    if (discountReserved && discount) {
      await db.run(
        `UPDATE discounts SET usage_count = MAX(usage_count - 1, 0), updated_at = ? WHERE id = ?`,
        [now(), discount.id]
      );
    }
  };

  return {
    cart,
    items,
    subtotal_cents:        subtotalCents,
    discount_amount_cents: discountAmountCents,
    final_amount_cents:    subtotalCents - discountAmountCents,
    currency:              cartCurrency,
    discount,
    shipping_address:      shippingAddress,
    rollback,
  };
}

// =============================================================================
// setCartShipping
// =============================================================================
// Call this from a new PATCH /v1/carts/:cartId/shipping endpoint.
// Stores the shipping address on the cart before checkout so it's available
// to any payment provider and to the order creation handler.

export async function setCartShipping(
  db: Database,
  cartId: string,
  address: Omit<ShippingAddress, 'name'> & { name?: string | null }
): Promise<void> {
  const { name, ...addressFields } = address;

  await db.run(
    `UPDATE carts
     SET ship_to = ?, shipping_name = ?, updated_at = ?
     WHERE id = ? AND status = 'open'`,
    [JSON.stringify(addressFields), name ?? null, now(), cartId]
  );
}
