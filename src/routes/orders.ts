import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import Stripe from 'stripe';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, generateOrderNumber, type HonoEnv } from '../types';
import { validateDiscount, calculateDiscount, type Discount } from './discounts';
import { dispatchWebhooks, type WebhookEventType } from '../lib/webhooks';
import {
  OrderIdParam,
  OrderResponse,
  OrderListResponse,
  OrderQuery,
  UpdateOrderBody,
  RefundOrderBody,
  RefundResponse,
  CreateTestOrderBody,
  ErrorResponse,
} from '../schemas';

const app = new OpenAPIHono<HonoEnv>();

app.use('*', authMiddleware);

const listOrders = createRoute({
  method: 'get',
  path: '/',
  tags: ['Orders'],
  summary: 'List orders',
  description: 'List orders with pagination and optional filters by status and email',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { query: OrderQuery },
  responses: {
    200: { content: { 'application/json': { schema: OrderListResponse } }, description: 'List of orders' },
  },
});

app.openapi(listOrders, async (c) => {
  const db = getDb(c.var.db);
  const { limit: limitStr, cursor, status, email } = c.req.valid('query');
  const limit = Math.min(parseInt(limitStr || '20'), 100);

  let query = `SELECT * FROM orders WHERE 1=1`;
  const params: unknown[] = [];

  if (status) {
    query += ` AND status = ?`;
    params.push(status);
  }

  if (email) {
    query += ` AND customer_email = ?`;
    params.push(email);
  }

  if (cursor) {
    query += ` AND created_at < ?`;
    params.push(cursor);
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit + 1);

  const orderList = await db.query<any>(query, params);

  const hasMore = orderList.length > limit;
  if (hasMore) orderList.pop();

  const orderIds = orderList.map((o) => o.id);
  const itemsByOrder: Record<string, any[]> = {};

  if (orderIds.length > 0) {
    const placeholders = orderIds.map(() => '?').join(',');
    const allItems = await db.query<any>(
      `SELECT * FROM order_items WHERE order_id IN (${placeholders})`,
      orderIds
    );

    for (const item of allItems) {
      if (!itemsByOrder[item.order_id]) {
        itemsByOrder[item.order_id] = [];
      }
      itemsByOrder[item.order_id].push(item);
    }
  }
  
  // After the itemsByOrder loop, add:
  const allSkus = [...new Set(
    Object.values(itemsByOrder).flat().map((i: any) => i.sku)
  )];
  const variantTypeMap = new Map<string, string>();
  if (allSkus.length > 0) {
    const variantRows = await db.query<{ sku: string; product_type: string }>(
      `SELECT sku, product_type FROM variants WHERE sku IN (${allSkus.map(() => '?').join(',')})`,
      allSkus
    );
    for (const v of variantRows) variantTypeMap.set(v.sku, v.product_type ?? 'physical');
  }

  // Then update the items map call:
  const items = orderList.map((order) =>
    formatOrder(order, itemsByOrder[order.id] || [], variantTypeMap)
  );  

  
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].created_at : null;

  return c.json({ items, pagination: { has_more: hasMore, next_cursor: nextCursor } }, 200);
});

const getOrder = createRoute({
  method: 'get',
  path: '/{orderId}',
  tags: ['Orders'],
  summary: 'Get order by ID',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: OrderIdParam },
  responses: {
    200: { content: { 'application/json': { schema: OrderResponse } }, description: 'Order details' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Order not found' },
  },
});

app.openapi(getOrder, async (c) => {
  const { orderId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');

  const orderItems = await db.query<any>(
    `SELECT * FROM order_items WHERE order_id = ?`, [order.id]
  );

  const skus = orderItems.map((i: any) => i.sku);
  const variants = skus.length > 0
    ? await db.query<{ sku: string; product_type: string }>(
        `SELECT sku, product_type FROM variants WHERE sku IN (${skus.map(() => '?').join(',')})`,
        skus
      )
    : [];
  const variantTypes = new Map(variants.map(v => [v.sku, v.product_type ?? 'physical']));

  return c.json(formatOrder(order, orderItems, variantTypes), 200);
});

const updateOrder = createRoute({
  method: 'patch',
  path: '/{orderId}',
  tags: ['Orders'],
  summary: 'Update order status/tracking',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: OrderIdParam,
    body: { content: { 'application/json': { schema: UpdateOrderBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: OrderResponse } }, description: 'Updated order' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Order not found' },
  },
});

app.openapi(updateOrder, async (c) => {
  const { orderId } = c.req.valid('param');
  const { status, tracking_number, tracking_url } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');

  const updates: string[] = [];
  const params: unknown[] = [];

  if (status !== undefined) {
    updates.push('status = ?');
    params.push(status);

    if (status === 'shipped' && !order.shipped_at) {
      updates.push('shipped_at = ?');
      params.push(now());
    }
  }

  if (tracking_number !== undefined) {
    updates.push('tracking_number = ?');
    params.push(tracking_number || null);
  }

  if (tracking_url !== undefined) {
    updates.push('tracking_url = ?');
    params.push(tracking_url || null);
  }

  if (updates.length === 0) {
    throw ApiError.invalidRequest('No fields to update');
  }

  params.push(orderId);
  await db.run(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, params);

  const [updated] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  const orderItems = await db.query<any>(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
  const formattedOrder = formatOrder(updated, orderItems);

  if (status !== undefined && status !== order.status) {
    let eventType: WebhookEventType = 'order.updated';
    if (status === 'shipped') eventType = 'order.shipped';

    await dispatchWebhooks(c.var.db, c.executionCtx, eventType, {
      order: formattedOrder,
      previous_status: order.status,
    });
  }

  return c.json(formattedOrder, 200);
});

const refundOrder = createRoute({
  method: 'post',
  path: '/{orderId}/refund',
  tags: ['Orders'],
  summary: 'Refund an order',
  description: 'Full or partial refund via Stripe',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: OrderIdParam,
    body: { content: { 'application/json': { schema: RefundOrderBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: RefundResponse } }, description: 'Refund result' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request or Stripe error' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Order not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Already refunded' },
  },
});

app.openapi(refundOrder, async (c) => {
  const { orderId } = c.req.valid('param');
  const { amount_cents } = c.req.valid('json');

  const stripeSecretKey = c.get('auth').stripeSecretKey;
  if (!stripeSecretKey) throw ApiError.invalidRequest('Stripe not connected');

  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status === 'refunded') throw ApiError.conflict('Order already refunded');
  if (!order.stripe_payment_intent_id) {
    throw ApiError.invalidRequest('Cannot refund test orders (no Stripe payment)');
  }

  const stripe = new Stripe(stripeSecretKey);

  try {
    const refund = await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
      amount: amount_cents,
    });

    await db.run(
      `INSERT INTO refunds (id, order_id, stripe_refund_id, amount_cents, status) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), order.id, refund.id, refund.amount, refund.status ?? 'succeeded']
    );

    if (!amount_cents || amount_cents >= order.total_cents) {
      await db.run(`UPDATE orders SET status = 'refunded' WHERE id = ?`, [orderId]);

      const [refundedOrder] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
      const orderItems = await db.query<any>(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);

      await dispatchWebhooks(c.var.db, c.executionCtx, 'order.refunded', {
        order: formatOrder(refundedOrder, orderItems),
        refund: { stripe_refund_id: refund.id, amount_cents: refund.amount },
      });
    }

    return c.json({ stripe_refund_id: refund.id, status: refund.status ?? 'succeeded' }, 200);
  } catch (e: any) {
    throw ApiError.stripeError(e.message || 'Refund failed');
  }
});

const createTestOrder = createRoute({
  method: 'post',
  path: '/test',
  tags: ['Orders'],
  summary: 'Create test order',
  description: 'Creates an order without Stripe payment (for testing)',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    body: { content: { 'application/json': { schema: CreateTestOrderBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: OrderResponse } }, description: 'Created order' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'SKU or discount not found' },
  },
});

app.openapi(createTestOrder, async (c) => {
  const { customer_email, items, discount_code } = c.req.valid('json');
  const db = getDb(c.var.db);

  let subtotal = 0;
  const orderItems = [];

  for (const { sku, qty } of items) {
    const [variant] = await db.query<any>(`SELECT * FROM variants WHERE sku = ?`, [sku]);
    if (!variant) throw ApiError.notFound(`SKU not found: ${sku}`);

    const [inv] = await db.query<any>(`SELECT * FROM inventory WHERE sku = ?`, [sku]);
    const available = (inv?.on_hand ?? 0) - (inv?.reserved ?? 0);
    if (available < qty) throw ApiError.insufficientInventory(sku);

    subtotal += variant.price_cents * qty;
    orderItems.push({
      sku,
      title: variant.title,
      qty,
      unit_price_cents: variant.price_cents,
    });
  }

  let discountId = null;
  let discountCode = null;
  let discountAmountCents = 0;
  let discount: Discount | null = null;

  if (discount_code) {
    const normalizedCode = discount_code.toUpperCase().trim();
    const [discountRow] = await db.query<any>(`SELECT * FROM discounts WHERE code = ?`, [normalizedCode]);

    if (discountRow) {
      await validateDiscount(db, discountRow as Discount, subtotal, customer_email);
      discountAmountCents = calculateDiscount(discountRow as Discount, subtotal);
      discountId = discountRow.id;
      discountCode = discountRow.code;
      discount = discountRow as Discount;
    } else {
      throw ApiError.notFound('Discount code not found');
    }
  }

  const totalCents = subtotal - discountAmountCents;
  const timestamp = now();
  let customerId: string | null = null;

  const [existingCustomer] = await db.query<any>(
    `SELECT id, order_count, total_spent_cents FROM customers WHERE email = ?`,
    [customer_email]
  );

  if (existingCustomer) {
    customerId = existingCustomer.id;
    await db.run(
      `UPDATE customers SET 
        order_count = order_count + 1,
        total_spent_cents = total_spent_cents + ?,
        last_order_at = ?,
        updated_at = ?
      WHERE id = ?`,
      [totalCents, timestamp, timestamp, customerId]
    );
  } else {
    customerId = uuid();
    await db.run(
      `INSERT INTO customers (id, email, order_count, total_spent_cents, last_order_at)
       VALUES (?, ?, 1, ?, ?)`,
      [customerId, customer_email, totalCents, timestamp]
    );
  }

  if (discount && discountAmountCents > 0) {
    const currentTime = now();

    if (discount.usage_limit_per_customer !== null) {
      const [usage] = await db.query<any>(
        `SELECT COUNT(*) as count FROM discount_usage WHERE discount_id = ? AND customer_email = ?`,
        [discount.id, customer_email.toLowerCase()]
      );
      if (usage && usage.count >= discount.usage_limit_per_customer) {
        throw ApiError.invalidRequest('You have already used this discount');
      }
    }

    if (discount.usage_limit !== null) {
      const result = await db.run(
        `UPDATE discounts 
         SET usage_count = usage_count + 1, updated_at = ? 
         WHERE id = ? 
           AND status = 'active'
           AND (starts_at IS NULL OR starts_at <= ?)
           AND (expires_at IS NULL OR expires_at >= ?)
           AND usage_count < usage_limit`,
        [currentTime, discountId, currentTime, currentTime]
      );

      if (result.changes === 0) {
        throw ApiError.invalidRequest('Discount usage limit reached');
      }
    } else {
      const result = await db.run(
        `UPDATE discounts 
         SET updated_at = ? 
         WHERE id = ? 
           AND status = 'active'
           AND (starts_at IS NULL OR starts_at <= ?)
           AND (expires_at IS NULL OR expires_at >= ?)`,
        [currentTime, discountId, currentTime, currentTime]
      );

      if (result.changes === 0) {
        throw ApiError.invalidRequest('Discount is no longer valid');
      }
    }
  }

  const orderNumber = generateOrderNumber();
  const orderId = uuid();

  await db.run(
    `INSERT INTO orders (id, customer_id, number, status, customer_email, subtotal_cents, tax_cents, shipping_cents, total_cents, discount_code, discount_id, discount_amount_cents, created_at)
     VALUES (?, ?, ?, 'paid', ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
    [orderId, customerId, orderNumber, customer_email, subtotal, totalCents, discountCode, discountId, discountAmountCents, timestamp]
  );

  for (const item of orderItems) {
    await db.run(
      `INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), orderId, item.sku, item.title, item.qty, item.unit_price_cents]
    );

    await db.run(`UPDATE inventory SET on_hand = on_hand - ?, updated_at = ? WHERE sku = ?`, [
      item.qty,
      timestamp,
      item.sku,
    ]);
  }

  if (discount && discountAmountCents > 0) {
    const [existingUsage] = await db.query<any>(
      `SELECT id FROM discount_usage WHERE order_id = ? AND discount_id = ?`,
      [orderId, discountId]
    );

    if (!existingUsage) {
      await db.run(
        `INSERT INTO discount_usage (id, discount_id, order_id, customer_email, discount_amount_cents)
         VALUES (?, ?, ?, ?, ?)`,
        [uuid(), discountId, orderId, customer_email.toLowerCase(), discountAmountCents]
      );
    }
  }

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  return c.json(formatOrder(order, orderItems), 200);
});

function formatOrder(order: any, items: any[], variantTypes?: Map<string, string>) {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    customer_email: order.customer_email,
    customer_id: order.customer_id || null,
    shipping: {
      name: order.shipping_name || null,
      phone: order.shipping_phone || null,
      address: order.ship_to ? JSON.parse(order.ship_to) : null,
    },
    amounts: {
      subtotal_cents:  order.subtotal_cents,
      discount_cents:  order.discount_amount_cents || 0,
      tax_cents:       order.tax_cents,
      shipping_cents:  order.shipping_cents,
      total_cents:     order.total_cents,
      currency:        order.currency,
    },
    discount: order.discount_code
      ? { code: order.discount_code, amount_cents: order.discount_amount_cents || 0 }
      : null,
    tracking: {
      number:     order.tracking_number,
      url:        order.tracking_url,
      shipped_at: order.shipped_at,
    },
    stripe: {
      checkout_session_id: order.stripe_checkout_session_id,
      payment_intent_id:   order.stripe_payment_intent_id,
    },
    items: items.map((i) => ({
      sku:             i.sku,
      title:           i.title,
      qty:             i.qty,
      unit_price_cents: i.unit_price_cents,
      product_type:    variantTypes?.get(i.sku) ?? 'physical',
    })),
    created_at: order.created_at,
  };
}

// ── GET /v1/orders/:orderId/downloads ─────────────────────────────────────

const getOrderDownloads = createRoute({
  method: 'get',
  path: '/{orderId}/downloads',
  tags: ['Orders'],
  summary: 'Get download tokens for an order',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: OrderIdParam },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            order_id: z.string(),
            digital_items: z.array(z.object({
              sku:    z.string(),
              title:  z.string(),
              tokens: z.array(z.object({
                token_id:           z.string(),
                download_count:     z.number().int(),
                max_downloads:      z.number().int(),
                expires_at:         z.string(),
                last_downloaded_at: z.string().nullable(),
              })),
            })),
          }),
        },
      },
      description: 'Download tokens grouped by SKU',
    },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Order not found' },
  },
});

app.openapi(getOrderDownloads, async (c) => {
  const { orderId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT id FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');

  const orderItems = await db.query<any>(
    `SELECT oi.sku, oi.title, v.product_type
     FROM order_items oi
     LEFT JOIN variants v ON v.sku = oi.sku
     WHERE oi.order_id = ?`,
    [orderId]
  );

  const digitalItems = orderItems.filter(
    (i: any) => (i.product_type ?? 'physical') === 'digital'
  );

  const result = await Promise.all(
    digitalItems.map(async (item: any) => {
      const tokens = await db.query<any>(
        `SELECT id, download_count, max_downloads, expires_at, last_downloaded_at
         FROM download_tokens
         WHERE order_id = ? AND sku = ?
         ORDER BY expires_at DESC`,
        [orderId, item.sku]
      );

      return {
        sku:   item.sku,
        title: item.title,
        tokens: tokens.map((t: any) => ({
          token_id:           t.id,
          download_count:     t.download_count,
          max_downloads:      t.max_downloads,
          expires_at:         t.expires_at,
          last_downloaded_at: t.last_downloaded_at ?? null,
        })),
      };
    })
  );

  return c.json({ order_id: orderId, digital_items: result }, 200);
});

// ── POST /v1/orders/:orderId/downloads/:sku/reissue ───────────────────────

const ReissueParam = z.object({
  orderId: z.string(),
  sku:     z.string(),
});

const reissueDownload = createRoute({
  method: 'post',
  path: '/{orderId}/downloads/{sku}/reissue',
  tags: ['Orders'],
  summary: 'Reissue a download token for a digital item',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: ReissueParam },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            token:        z.string(),
            download_url: z.string(),
            expires_at:   z.string(),
          }),
        },
      },
      description: 'New download token issued',
    },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Order or item not found' },
  },
});

app.openapi(reissueDownload, async (c) => {
  const { orderId, sku } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT id FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');

  const [item] = await db.query<any>(
    `SELECT oi.sku FROM order_items oi
     JOIN variants v ON v.sku = oi.sku
     WHERE oi.order_id = ? AND oi.sku = ? AND v.product_type = 'digital'`,
    [orderId, sku]
  );
  if (!item) throw ApiError.notFound('Digital item not found in order');

  // Generate a fresh token using the same utility as order creation
  const { generateToken, hashToken, DOWNLOAD_DEFAULTS } = await import('../lib/downloads');

  const plainToken  = generateToken();
  const tokenHash   = await hashToken(plainToken);
  const expiresAt   = new Date(
    Date.now() + DOWNLOAD_DEFAULTS.expires_in_days * 86_400_000
  ).toISOString();

  await db.run(
    `INSERT INTO download_tokens (id, order_id, sku, token_hash, expires_at, max_downloads, download_count)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [uuid(), orderId, sku, tokenHash, expiresAt, DOWNLOAD_DEFAULTS.max_downloads]
  );

  // Build the download URL — read STORE_URL from env if available
  const storeBaseUrl = (c.env as any).STORE_URL ?? 'http://localhost:8787';
  const downloadUrl  = `${storeBaseUrl}/v1/downloads/${plainToken}`;

  return c.json({ token: plainToken, download_url: downloadUrl, expires_at: expiresAt }, 200);
});

export { app as orders };
