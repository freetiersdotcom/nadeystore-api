import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import Stripe from 'stripe';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { ApiError, uuid, now, isValidEmail, type HonoEnv } from '../types';
import { validateDiscount, calculateDiscount, type Discount } from './discounts';
import {
  CartIdParam,
  CartResponse,
  CreateCartBody,
  AddCartItemsBody,
  CheckoutBody,
  CheckoutResponse,
  ApplyDiscountBody,
  ApplyDiscountResponse,
  ErrorResponse,
  CartTotals,
} from '../schemas';

import { prepareCheckout, setCartShipping } from '../lib/checkout';
import { createFedaPayCheckout } from '../lib/fedapay';

const RemoveDiscountResponse = z.object({
  discount: z.null(),
  totals: CartTotals,
}).openapi('RemoveDiscountResponse');

const app = new OpenAPIHono<HonoEnv>();

app.use('*', authMiddleware);

const getCart = createRoute({
  method: 'get',
  path: '/{cartId}',
  tags: ['Checkout'],
  summary: 'Get cart by ID',
  request: { params: CartIdParam },
  responses: {
    200: { content: { 'application/json': { schema: CartResponse } }, description: 'Cart details' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart not found' },
  },
});

app.openapi(getCart, async (c) => {
  const { cartId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');

  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);

  return c.json({
    id: cart.id,
    status: cart.status,
    currency: cart.currency,
    customer_email: cart.customer_email,
    items: items.map((i) => ({
      sku: i.sku,
      title: i.title,
      qty: i.qty,
      unit_price_cents: i.unit_price_cents,
    })),
    expires_at: cart.expires_at,
    stripe_checkout_session_id: cart.stripe_checkout_session_id,
  }, 200);
});

const createCart = createRoute({
  method: 'post',
  path: '/',
  tags: ['Checkout'],
  summary: 'Create a new cart',
  request: { body: { content: { 'application/json': { schema: CreateCartBody } } } },
  responses: {
    200: { content: { 'application/json': { schema: CartResponse } }, description: 'Created cart' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid email' },
  },
});

app.openapi(createCart, async (c) => {
  const { customer_email } = c.req.valid('json');

  if (!isValidEmail(customer_email)) {
    throw ApiError.invalidRequest('A valid customer_email is required');
  }

  const db = getDb(c.var.db);
  const id = uuid();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await db.run(`INSERT INTO carts (id, customer_email, expires_at) VALUES (?, ?, ?)`, [
    id,
    customer_email,
    expiresAt,
  ]);

  return c.json({
    id,
    status: 'open' as const,
    currency: 'USD',
    customer_email,
    items: [],
    discount: null,
    totals: {
      subtotal_cents: 0,
      discount_cents: 0,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: 0,
    },
    expires_at: expiresAt,
  }, 200);
});

const addCartItems = createRoute({
  method: 'post',
  path: '/{cartId}/items',
  tags: ['Checkout'],
  summary: 'Add items to cart',
  description: 'Replaces existing cart items with the provided items',
  request: {
    params: CartIdParam,
    body: { content: { 'application/json': { schema: AddCartItemsBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: CartResponse } }, description: 'Updated cart' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart or SKU not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart is not open' },
  },
});

app.openapi(addCartItems, async (c) => {
  const { cartId } = c.req.valid('param');
  const { items } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');
  if (cart.status !== 'open') throw ApiError.conflict('Cart is not open');

  const validatedItems = [];
  for (const { sku, qty } of items) {
    const [variant] = await db.query<any>(`SELECT * FROM variants WHERE sku = ?`, [sku]);
    if (!variant) throw ApiError.notFound(`SKU not found: ${sku}`);
    if (variant.status !== 'active') throw ApiError.invalidRequest(`SKU not active: ${sku}`);

    const [inv] = await db.query<any>(`SELECT * FROM inventory WHERE sku = ?`, [sku]);
    const available = (inv?.on_hand ?? 0) - (inv?.reserved ?? 0);
    if (available < qty) throw ApiError.insufficientInventory(sku);

    validatedItems.push({
      sku,
      title: variant.title,
      qty,
      unit_price_cents: variant.price_cents,
    });
  }

  await db.run(`DELETE FROM cart_items WHERE cart_id = ?`, [cartId]);

  for (const item of validatedItems) {
    await db.run(
      `INSERT INTO cart_items (id, cart_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), cartId, item.sku, item.title, item.qty, item.unit_price_cents]
    );
  }

  const allCartItems = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
  const subtotalCents = allCartItems.reduce(
    (sum, item) => sum + item.unit_price_cents * item.qty,
    0
  );

  let discountInfo = null;
  let discountAmountCents = 0;
  if (cart.discount_id) {
    const [discount] = await db.query<any>(`SELECT * FROM discounts WHERE id = ?`, [
      cart.discount_id,
    ]);
    if (discount) {
      try {
        await validateDiscount(db, discount as Discount, subtotalCents, cart.customer_email);
        discountAmountCents = calculateDiscount(discount as Discount, subtotalCents);
        await db.run(`UPDATE carts SET discount_amount_cents = ? WHERE id = ?`, [
          discountAmountCents,
          cartId,
        ]);
        discountInfo = {
          code: discount.code,
          type: discount.type as 'percentage' | 'fixed_amount',
          amount_cents: discountAmountCents,
        };
      } catch {
        await db.run(
          `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0 WHERE id = ?`,
          [cartId]
        );
      }
    } else {
      await db.run(
        `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0 WHERE id = ?`,
        [cartId]
      );
    }
  }

  return c.json({
    id: cart.id,
    status: cart.status,
    currency: cart.currency,
    customer_email: cart.customer_email,
    items: allCartItems.map((item) => ({
      sku: item.sku,
      title: item.title,
      qty: item.qty,
      unit_price_cents: item.unit_price_cents,
    })),
    discount: discountInfo,
    totals: {
      subtotal_cents: subtotalCents,
      discount_cents: discountAmountCents,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: subtotalCents - discountAmountCents,
    },
    expires_at: cart.expires_at,
  }, 200);
});

const checkoutCart = createRoute({
  method: 'post',
  path: '/{cartId}/checkout',
  tags: ['Checkout'],
  summary: 'Initiate Stripe checkout',
  description: 'Creates a Stripe checkout session and returns the URL',
  request: {
    params: CartIdParam,
    body: { content: { 'application/json': { schema: CheckoutBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: CheckoutResponse } }, description: 'Checkout URL' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request or insufficient inventory' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart is not open' },
  },
});

app.openapi(checkoutCart, async (c) => {
  const { cartId } = c.req.valid('param');
  const { success_url, cancel_url, collect_shipping, shipping_countries, shipping_options } =
    c.req.valid('json');

  const stripeSecretKey = c.get('auth').stripeSecretKey;
  if (!stripeSecretKey) {
    throw ApiError.invalidRequest('Stripe not connected. POST /v1/setup/stripe first.');
  }

  const db = getDb(c.var.db);

  // Shared pre-checkout: validates, locks cart, reserves inventory + discount
  const prepared = await prepareCheckout(db, cartId, 'stripe');

  let session;
  try {
    const stripe = new Stripe(stripeSecretKey);

    // Build line items — use final_amount_cents if discount was applied
    // by distributing discount proportionally across items, or let Stripe
    // handle it via a coupon. Current approach: pass coupon if discount exists.
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] =
      prepared.items.map(item => ({
        price_data: {
          currency:     prepared.currency.toLowerCase(),
          product_data: { name: item.title },
          unit_amount:  item.unit_price_cents,
        },
        quantity: item.qty,
      }));

    // Build Stripe coupon for discount if applicable
    let stripeCouponId: string | null = null;
    if (prepared.discount && prepared.discount_amount_cents > 0) {
      const d = prepared.discount;
      const needsOnTheFly = d.type === 'percentage' && d.max_discount_cents;

      if (d.stripe_coupon_id && !needsOnTheFly) {
        stripeCouponId = d.stripe_coupon_id;
      } else {
        try {
          const couponParams: Stripe.CouponCreateParams = { duration: 'once' };
          if (d.type === 'percentage' && d.max_discount_cents) {
            couponParams.amount_off = prepared.discount_amount_cents;
            couponParams.currency   = prepared.currency.toLowerCase();
          } else if (d.type === 'percentage') {
            couponParams.percent_off = d.value;
          } else {
            couponParams.amount_off = d.value;
            couponParams.currency   = prepared.currency.toLowerCase();
          }
          const coupon  = await stripe.coupons.create(couponParams);
          stripeCouponId = coupon.id;
        } catch (err: any) {
          await prepared.rollback();
          console.error(`Stripe coupon creation failed: ${err.message}`);
          throw ApiError.invalidRequest(
            'Failed to apply discount. Remove it and try again.'
          );
        }
      }
    }

    const defaultShippingOptions: Stripe.Checkout.SessionCreateParams.ShippingOption[] = [{
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: 0, currency: prepared.currency.toLowerCase() },
        display_name: 'Standard Shipping',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 5 },
          maximum: { unit: 'business_day', value: 7 },
        },
      },
    }];

    session = await stripe.checkout.sessions.create({
      mode:           'payment',
      customer_email: prepared.cart.customer_email,
      automatic_tax:  { enabled: true },
      ...(collect_shipping && {
        shipping_address_collection: {
          allowed_countries: shipping_countries as any,
        },
        shipping_options: shipping_options ?? defaultShippingOptions,
      }),
      line_items: lineItems,
      ...(stripeCouponId && { discounts: [{ coupon: stripeCouponId }] }),
      success_url,
      cancel_url,
      metadata: {
        cart_id: cartId,
        ...(prepared.discount && {
          discount_id:   prepared.discount.id,
          discount_code: prepared.discount.code || '',
          discount_type: prepared.discount.type,
        }),
      },
    });
  } catch (err) {
    if (!(err instanceof ApiError)) await prepared.rollback();
    throw err;
  }

  await db.run(
    `UPDATE carts SET stripe_checkout_session_id = ?, discount_amount_cents = ?, updated_at = ?
     WHERE id = ?`,
    [session.id, prepared.discount_amount_cents, now(), cartId]
  );

  return c.json({
    id:           prepared.cart.id,
    checkout_url: session.url,
    expires_at:   new Date(session.expires_at * 1000).toISOString(),
  }, 200);
});

const FedaPayCheckoutBody = z.object({
  success_url: z.string().url().openapi({ example: 'https://yourstore.com/success' }),
  cancel_url:  z.string().url().openapi({ example: 'https://yourstore.com/cancel' }),
}).openapi('FedaPayCheckoutBody');

const FedaPayCheckoutResponse = z.object({
  checkout_url:   z.string().url(),
  transaction_id: z.number().int(),
  cart_id:        z.string(),
}).openapi('FedaPayCheckoutResponse');

const fedaPayCheckout = createRoute({
  method: 'post',
  path:   '/{cartId}/checkout/fedapay',
  tags:   ['Checkout'],
  summary: 'Create FedaPay checkout session',
  description: [
    'Creates a FedaPay hosted checkout session for the cart.',
    'Discounts and inventory are reserved before calling FedaPay.',
    'FedaPay posts to /v1/webhooks/fedapay on payment confirmation.',
    'Configure via POST /v1/setup/fedapay.',
  ].join(' '),
  request: {
    params: CartIdParam,
    body:   { content: { 'application/json': { schema: FedaPayCheckoutBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: FedaPayCheckoutResponse } }, description: 'Checkout URL' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart not open' },
  },
});

app.openapi(fedaPayCheckout, async (c) => {
  const { cartId }    = c.req.valid('param');
  const { success_url } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [config] = await db.query<any>(`SELECT * FROM config WHERE key = 'fedapay'`);
  if (!config?.value) throw ApiError.invalidRequest('FedaPay not configured. POST /v1/setup/fedapay first.');
  const fedaPayConfig = JSON.parse(config.value);

  // Shared pre-checkout (validates currency against FedaPay's supported list)
  const prepared = await prepareCheckout(db, cartId, 'fedapay');

  const description = prepared.items.map(i => i.title).join(', ').slice(0, 200);

  let result: { checkout_url: string; transaction_id: number };
  try {
    result = await createFedaPayCheckout({
      cartId,
      amountCents:   prepared.final_amount_cents,
      currency:      prepared.currency,
      customerEmail: prepared.cart.customer_email,
      description,
      callbackUrl:   success_url,
      config:        fedaPayConfig,
    });
  } catch (err: any) {
    await prepared.rollback();
    throw ApiError.invalidRequest(`FedaPay checkout error: ${err.message}`);
  }

  // Store discount amount on cart so the webhook handler can read it
  await db.run(
    `UPDATE carts SET discount_amount_cents = ?, updated_at = ? WHERE id = ?`,
    [prepared.discount_amount_cents, now(), cartId]
  );

  return c.json({
    checkout_url:   result.checkout_url,
    transaction_id: result.transaction_id,
    cart_id:        cartId,
  }, 200);
});

const SetShippingBody = z.object({
  name:        z.string().optional().nullable(),
  line1:       z.string().min(1),
  line2:       z.string().optional().nullable(),
  city:        z.string().min(1),
  state:       z.string().optional().nullable(),
  postal_code: z.string().min(1),
  country:     z.string().length(2).openapi({ example: 'BJ', description: 'ISO 3166-1 alpha-2' }),
}).openapi('SetShipping');

const setShippingRoute = createRoute({
  method:  'patch',
  path:    '/{cartId}/shipping',
  tags:    ['Checkout'],
  summary: 'Set shipping address on cart',
  description: [
    'Stores a shipping address on the cart before checkout.',
    'The address is attached to the order regardless of payment provider.',
    'For digital-only carts, this step is not required.',
  ].join(' '),
  request: {
    params: CartIdParam,
    body:   { content: { 'application/json': { schema: SetShippingBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } }, description: 'Address saved' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart not found' },
  },
});

app.openapi(setShippingRoute, async (c) => {
  const { cartId } = c.req.valid('param');
  const body       = c.req.valid('json');
  const db         = getDb(c.var.db);

  const [cart] = await db.query<{ status: string }>(
    `SELECT status FROM carts WHERE id = ? LIMIT 1`, [cartId]
  );
  if (!cart) throw ApiError.notFound('Cart not found');
  if (cart.status !== 'open') throw ApiError.invalidRequest('Cart is not open');

  await setCartShipping(db, cartId, body);

  return c.json({ ok: true as const }, 200);
});


const applyDiscount = createRoute({
  method: 'post',
  path: '/{cartId}/apply-discount',
  tags: ['Checkout'],
  summary: 'Apply discount code to cart',
  request: {
    params: CartIdParam,
    body: { content: { 'application/json': { schema: ApplyDiscountBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: ApplyDiscountResponse } }, description: 'Discount applied' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid discount' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart or discount not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart is not open' },
  },
});

app.openapi(applyDiscount, async (c) => {
  const { cartId } = c.req.valid('param');
  const { code } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');
  if (cart.status !== 'open') throw ApiError.conflict('Cart is not open');

  const normalizedCode = code.toUpperCase().trim();

  const [discount] = await db.query<any>(`SELECT * FROM discounts WHERE code = ?`, [normalizedCode]);
  if (!discount) throw ApiError.notFound('Discount code not found');

  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
  if (items.length === 0) throw ApiError.invalidRequest('Cart is empty');

  const subtotalCents = items.reduce((sum: number, item: any) => {
    return sum + item.unit_price_cents * item.qty;
  }, 0);

  await validateDiscount(db, discount as Discount, subtotalCents, cart.customer_email);
  const discountAmountCents = calculateDiscount(discount as Discount, subtotalCents);

  await db.run(
    `UPDATE carts SET discount_code = ?, discount_id = ?, discount_amount_cents = ? WHERE id = ?`,
    [discount.code, discount.id, discountAmountCents, cartId]
  );

  return c.json({
    discount: {
      code: discount.code,
      type: discount.type as 'percentage' | 'fixed_amount',
      amount_cents: discountAmountCents,
    },
    totals: {
      subtotal_cents: subtotalCents,
      discount_cents: discountAmountCents,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: subtotalCents - discountAmountCents,
    },
  }, 200);
});

const removeDiscount = createRoute({
  method: 'delete',
  path: '/{cartId}/discount',
  tags: ['Checkout'],
  summary: 'Remove discount from cart',
  request: { params: CartIdParam },
  responses: {
    200: { content: { 'application/json': { schema: RemoveDiscountResponse } }, description: 'Discount removed' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart is not open' },
  },
});

app.openapi(removeDiscount, async (c) => {
  const { cartId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');
  if (cart.status !== 'open') throw ApiError.conflict('Cart is not open');

  await db.run(
    `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0 WHERE id = ?`,
    [cartId]
  );

  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
  const subtotalCents = items.reduce((sum: number, item: any) => {
    return sum + item.unit_price_cents * item.qty;
  }, 0);

  return c.json({
    discount: null,
    totals: {
      subtotal_cents: subtotalCents,
      discount_cents: 0,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: subtotalCents,
    },
  }, 200);
});

export { app as checkout };
