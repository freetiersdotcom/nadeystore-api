import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { ApiError, type HonoEnv } from '../types';
import { authMiddleware } from '../middleware/auth';
import { prepareCheckout } from '../lib/checkout';
import { createOrderFromCart } from '../lib/orders';
import { CartIdParam, ErrorResponse } from '../schemas';

// =============================================================================
// Payment on delivery (COD)
//
// POST /v1/carts/:cartId/checkout/cod
//
// No payment provider is involved: the cart is locked and stock reserved by
// prepareCheckout() exactly like an online checkout, then the order is created
// immediately through createOrderFromCart() with status 'pending'. An admin
// marks it 'paid' (PATCH /v1/orders/:id {status:'paid'}) once the cash is in.
//
// Guard rails:
//   - physical items require a shipping country listed in COD_COUNTRIES
//     (env var, comma-separated ISO codes, default "BJ"; set it empty to
//     disable COD entirely). Digital-only carts are refused (nothing could be
//     delivered "against payment"); services are allowed.
//   - a phone number is required (address.phone; carts from an older storefront page
//     kept it in postal_code).
// =============================================================================

const CodCheckoutBody = z.object({}).passthrough().openapi('CodCheckoutBody');

const CodCheckoutResponse = z.object({
  order_number: z.string(),
  cart_id:      z.string(),
  status:       z.literal('pending'),
  payment_method: z.literal('cod'),
}).openapi('CodCheckoutResponse');

const codCheckout = createRoute({
  method: 'post',
  path:   '/{cartId}/checkout/cod',
  tags:   ['Checkout'],
  summary: 'Place an order to be paid on delivery',
  description: 'Creates the order immediately with status "pending". Stock is decremented; the admin marks the order paid once cash is collected.',
  request: {
    params: CartIdParam,
    body:   { content: { 'application/json': { schema: CodCheckoutBody } }, required: false },
  },
  responses: {
    200: { content: { 'application/json': { schema: CodCheckoutResponse } }, description: 'Order placed' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not eligible for payment on delivery' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cart not open' },
  },
});

export function codCountries(env: unknown): string[] {
  const raw = (env as { COD_COUNTRIES?: string }).COD_COUNTRIES ?? 'BJ';
  return raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

export const cod = new OpenAPIHono<HonoEnv>();

// Same credential as the rest of /v1/carts (storefront public key).
cod.use('*', authMiddleware);

cod.openapi(codCheckout, async (c) => {
  const { cartId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const allowed = codCountries(c.env);
  if (allowed.length === 0) {
    throw ApiError.invalidRequest('Payment on delivery is not available.');
  }

  const prepared = await prepareCheckout(db, cartId, 'cod');

  try {
    const kinds = await db.query<{ product_type: string }>(
      `SELECT v.product_type FROM cart_items ci JOIN variants v ON v.sku = ci.sku WHERE ci.cart_id = ?`,
      [cartId]
    );
    const types = kinds.map((k) => k.product_type);

    if (types.includes('digital')) {
      throw ApiError.invalidRequest('Digital products must be paid online.');
    }

    if (types.includes('physical') || types.length === 0) {
      const addr = prepared.shipping_address;
      if (!addr) {
        throw ApiError.invalidRequest('A delivery address is required for payment on delivery.');
      }
      if (!allowed.includes((addr.country ?? '').toUpperCase())) {
        throw ApiError.invalidRequest('Payment on delivery is not available for this country.');
      }
      // New carts carry a validated `phone`; carts built by an older storefront page kept it in postal_code.
      if (!addr.phone && (addr.postal_code ?? '').replace(/\D/g, '').length < 8) {
        throw ApiError.invalidRequest('A phone number is required for payment on delivery.');
      }
    }

    const storeBaseUrl = (c.env as any).STORE_URL
      ?? (c.env.IMAGES_URL ? new URL(c.env.IMAGES_URL).origin : 'https://yourstore.com');

    const result = await createOrderFromCart(db, c.var.db, c.executionCtx, cartId, {
      provider:      'cod',
      providerRef:   cartId,
      storeBaseUrl,
      storeName:     c.env.STORE_NAME ?? 'Your Store',
      paymentMethod: 'cod',
    });

    if (!result) throw ApiError.invalidRequest('Could not create the order.');

    return c.json({
      order_number:   result.orderNumber,
      cart_id:        cartId,
      status:         'pending' as const,
      payment_method: 'cod' as const,
    }, 200);
  } catch (err) {
    // Only roll back if no order exists yet (an order means stock/discount are committed).
    const [existing] = await db.query<{ id: string }>(`SELECT id FROM orders WHERE cart_id = ? LIMIT 1`, [cartId]);
    if (!existing) await prepared.rollback();
    throw err;
  }
});
