import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import Stripe from 'stripe';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, generateOrderNumber, type HonoEnv } from '../types';
import { validateDiscount, calculateDiscount, type Discount } from './discounts';
import { dispatchWebhooks, type WebhookEventType } from '../lib/webhooks';
import { recordPayment, paymentState } from '../lib/payments';
import { cancelOrderAppointments } from '../lib/appointments';
import {
  OrderIdParam,
  OrderStatus,
  OrderResponse,
  OrderListResponse,
  OrderQuery,
  UpdateOrderBody,
  RefundOrderBody,
  RefundResponse,
  ManualRefundBody,
  ManualRefundResponse,
  RefundListResponse,
  CreateTestOrderBody,
  ErrorResponse,
} from '../schemas';

type ProductType = 'physical' | 'digital' | 'service';

// The DB column is plain TEXT; narrow it to the literal union the response schema expects.
function toProductType(v: unknown): ProductType {
  return v === 'digital' || v === 'service' ? v : 'physical';
}

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
  const { limit: limitStr, cursor, status, email, needs_review, service_status, balance_due } = c.req.valid('query');
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

  if (service_status) {
    query += ` AND service_status = ?`;
    params.push(service_status);
  }

  if (needs_review !== undefined) {
    query += ` AND needs_review = ?`;
    params.push(needs_review ? 1 : 0);
  }

  if (balance_due) {
    query += ` AND amount_paid_cents < total_cents AND status NOT IN ('canceled', 'refunded')`;
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
  const variantTypeMap = new Map<string, ProductType>();
  if (allSkus.length > 0) {
    const variantRows = await db.query<{ sku: string; product_type: string }>(
      `SELECT sku, product_type FROM variants WHERE sku IN (${allSkus.map(() => '?').join(',')})`,
      allSkus
    );
    for (const v of variantRows) variantTypeMap.set(v.sku, toProductType(v.product_type));
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
  const variantTypes = new Map<string, ProductType>(variants.map((v) => [v.sku, toProductType(v.product_type)]));

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
  const { status, tracking_number, tracking_url, needs_review, service_status, service_note } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');

  const updates: string[] = [];
  const params: unknown[] = [];

  // Orders whose payment is collected later (pay on delivery, entered by the merchant).
  const isOffline = (order.payment_method ?? 'online') !== 'online';

  // A canceled offline order has released its stock and discount; reopening it
  // would silently oversell. The customer can simply place a new order.
  if (isOffline && order.status === 'canceled' && status !== undefined && status !== 'canceled') {
    throw ApiError.invalidRequest('A canceled order cannot be reopened.');
  }

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

  if (needs_review !== undefined) {
    updates.push('needs_review = ?');
    params.push(needs_review ? 1 : 0);
    if (!needs_review) {
      updates.push('review_reason = NULL');
    }
  }

  // Services: manual follow-up (to schedule → scheduled → completed).
  if (service_status !== undefined || service_note !== undefined) {
    if (!order.service_status) {
      throw ApiError.invalidRequest('This order has no service to follow up');
    }
    if (service_status !== undefined) {
      updates.push('service_status = ?');
      params.push(service_status);
    }
    if (service_note !== undefined) {
      updates.push('service_note = ?');
      params.push(service_note ? service_note.trim() : null);
    }
  }

  if (updates.length === 0) {
    throw ApiError.invalidRequest('No fields to update');
  }

  // Completing the service on an order that contains nothing to ship or download
  // closes the order (status 'delivered') so it no longer looks pending.
  let autoDelivered = false;
  if (service_status === 'completed' && status === undefined && ['paid', 'processing'].includes(order.status)) {
    const kinds = await db.query<{ product_type: string }>(
      `SELECT v.product_type FROM order_items oi JOIN variants v ON v.sku = oi.sku WHERE oi.order_id = ?`,
      [orderId]
    );
    if (kinds.length > 0 && kinds.every((k) => k.product_type === 'service')) {
      updates.push('status = ?');
      params.push('delivered');
      autoDelivered = true;
    }
  }

  params.push(orderId);
  await db.run(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, params);

  // Choosing "Paid" by hand on an offline order = the whole balance was collected in cash.
  if (isOffline && status === 'paid' && order.status !== 'canceled') {
    const { balance_cents } = paymentState(order);
    if (balance_cents > 0) {
      await recordPayment(db, order, { amount_cents: balance_cents, method: 'cash', note: 'Marked as paid' });
    }
  }

  // Canceling an offline order puts the goods back on the shelf. Money already
  // received (deposit…) stays on the order: refund it from the refund panel.
  if (isOffline && status === 'canceled' && order.status !== 'canceled') {
    await releaseOfflineOrder(db, order);
  }

  // A canceled order frees its appointment slot.
  if (status === 'canceled' && order.status !== 'canceled') {
    await cancelOrderAppointments(db, orderId);
  }

  const [updated] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  const orderItems = await db.query<any>(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
  const formattedOrder = formatOrder(updated, orderItems);

  if (autoDelivered) {
    await dispatchWebhooks(c.var.db, c.executionCtx, 'order.updated', {
      order: formattedOrder,
      previous_status: order.status,
    });
  }

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

// Undo what createOrderFromCart() committed for an offline order that will
// never be completed: stock, discount usage and the customer's lifetime counters.
export async function releaseOfflineOrder(db: ReturnType<typeof getDb>, order: any) {
  const items = await db.query<{ sku: string; qty: number }>(
    `SELECT oi.sku, oi.qty FROM order_items oi
       JOIN variants v ON v.sku = oi.sku
      WHERE oi.order_id = ? AND v.product_type = 'physical'`,
    [order.id]
  );
  for (const it of items) {
    await db.run(
      `UPDATE inventory SET on_hand = on_hand + ?, updated_at = ? WHERE sku = ?`,
      [it.qty, now(), it.sku]
    );
    await db.run(
      `INSERT INTO inventory_logs (id, sku, delta, reason) VALUES (?, ?, ?, 'return')`,
      [uuid(), it.sku, it.qty]
    );
  }

  if (order.discount_id) {
    const removed = await db.query<{ id: string }>(
      `SELECT id FROM discount_usage WHERE order_id = ? AND discount_id = ?`,
      [order.id, order.discount_id]
    );
    if (removed.length > 0) {
      await db.run(`DELETE FROM discount_usage WHERE order_id = ? AND discount_id = ?`, [order.id, order.discount_id]);
      await db.run(
        `UPDATE discounts SET usage_count = MAX(usage_count - 1, 0), updated_at = ? WHERE id = ?`,
        [now(), order.discount_id]
      );
    }
  }

  if (order.customer_id) {
    await db.run(
      `UPDATE customers SET
         order_count = MAX(order_count - 1, 0),
         total_spent_cents = MAX(total_spent_cents - ?, 0),
         updated_at = ?
       WHERE id = ?`,
      [order.total_cents, now(), order.customer_id]
    );
  }
}

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

// 'pending' and 'canceled' qualify too: a deposit may have been paid before the order was canceled.
const REFUNDABLE_STATUSES = ['pending', 'paid', 'processing', 'shipped', 'delivered', 'canceled'];

async function refundTotals(db: ReturnType<typeof getDb>, orderId: string, totalCents: number) {
  const [row] = await db.query<{ refunded: number }>(
    `SELECT COALESCE(SUM(amount_cents), 0) AS refunded FROM refunds WHERE order_id = ? AND status != 'failed'`,
    [orderId]
  );
  const refunded = Number(row?.refunded ?? 0);
  return { refunded, remaining: Math.max(totalCents - refunded, 0) };
}

function formatRefund(r: any) {
  return {
    id: r.id as string,
    source: (r.source === 'manual' ? 'manual' : 'stripe') as 'stripe' | 'manual',
    method: (r.method ?? null) as string | null,
    reference: (r.reference ?? null) as string | null,
    note: (r.note ?? null) as string | null,
    amount_cents: Number(r.amount_cents),
    status: r.status as string,
    created_at: r.created_at as string,
  };
}

const listOrderRefunds = createRoute({
  method: 'get',
  path: '/{orderId}/refunds',
  tags: ['Orders'],
  summary: 'List refunds recorded for an order',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: OrderIdParam },
  responses: {
    200: { content: { 'application/json': { schema: RefundListResponse } }, description: 'Refunds' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Order not found' },
  },
});

app.openapi(listOrderRefunds, async (c) => {
  const { orderId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT id, total_cents FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');

  const rows = await db.query<any>(
    `SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC`,
    [orderId]
  );
  const { refunded, remaining } = await refundTotals(db, orderId, order.total_cents);

  return c.json(
    { items: rows.map(formatRefund), refunded_cents: refunded, remaining_cents: remaining },
    200
  );
});

const recordManualRefund = createRoute({
  method: 'post',
  path: '/{orderId}/refunds/manual',
  tags: ['Orders'],
  summary: 'Record a refund made outside the API',
  description:
    'Records a refund the merchant already paid out by hand (e.g. FedaPay dashboard MTN MoMo refund, ' +
    'mobile money or bank transfer). No call is made to any payment provider.',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: OrderIdParam,
    body: { content: { 'application/json': { schema: ManualRefundBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: ManualRefundResponse } }, description: 'Refund recorded' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid amount or order state' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Order not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Already fully refunded' },
  },
});

app.openapi(recordManualRefund, async (c) => {
  const { orderId } = c.req.valid('param');
  const { amount_cents, method, reference, note } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status === 'refunded') throw ApiError.conflict('Order already refunded');
  if (!REFUNDABLE_STATUSES.includes(order.status)) {
    throw ApiError.invalidRequest(`Cannot record a refund for an order with status "${order.status}"`);
  }

  // Only what was actually paid can be refunded.
  const paidCents = Number(order.amount_paid_cents ?? order.total_cents);
  if (paidCents <= 0) throw ApiError.invalidRequest('Nothing has been paid on this order, so there is nothing to refund.');
  const { refunded, remaining } = await refundTotals(db, orderId, paidCents);
  if (remaining <= 0) throw ApiError.conflict('Order already fully refunded');

  const amount = amount_cents ?? remaining;
  if (amount > remaining) {
    throw ApiError.invalidRequest(`Amount exceeds the refundable balance (${remaining})`);
  }

  const id = uuid();
  await db.run(
    `INSERT INTO refunds (id, order_id, stripe_refund_id, amount_cents, status, source, method, reference, note)
     VALUES (?, ?, ?, ?, 'succeeded', 'manual', ?, ?, ?)`,
    [id, order.id, `manual_${id}`, amount, method, reference ?? null, note ?? null]
  );

  const newRefunded = refunded + amount;
  const fullyRefunded = newRefunded >= paidCents;
  let orderStatus: string = order.status;

  if (fullyRefunded) {
    // A full refund also closes any pending manual-review flag.
    await db.run(`UPDATE orders SET status = 'refunded', needs_review = 0 WHERE id = ?`, [orderId]);
    orderStatus = 'refunded';

    const [refundedOrder] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
    const orderItems = await db.query<any>(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
    await dispatchWebhooks(c.var.db, c.executionCtx, 'order.refunded', {
      order: formatOrder(refundedOrder, orderItems),
      refund: { manual: true, method, amount_cents: amount },
    });
  }

  const [row] = await db.query<any>(`SELECT * FROM refunds WHERE id = ?`, [id]);

  return c.json(
    {
      refund: formatRefund(row),
      order_status: orderStatus as z.infer<typeof OrderStatus>,
      refunded_cents: newRefunded,
      remaining_cents: Math.max(paidCents - newRefunded, 0),
    },
    200
  );
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


    // Digital and service variants have no stock; only physical items are checked.
    if ((variant.product_type ?? 'physical') === 'physical') {
      const [inv] = await db.query<any>(`SELECT * FROM inventory WHERE sku = ?`, [sku]);
      const available = (inv?.on_hand ?? 0) - (inv?.reserved ?? 0);
      if (available < qty) throw ApiError.insufficientInventory(sku);
    }

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

function formatOrder(order: any, items: any[], variantTypes?: Map<string, ProductType>) {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    payment_method: (['cod', 'manual', 'deposit'].includes(order.payment_method) ? order.payment_method : 'online') as 'online' | 'cod' | 'manual' | 'deposit',
    ...paymentState(order),
    paid_at: (order.paid_at ?? null) as string | null,
    due_at: (order.due_at ?? null) as string | null,
    needs_review: !!order.needs_review,
    review_reason: order.review_reason ?? null,
    service_status: order.service_status ?? null,
    service_note: order.service_note ?? null,
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
      product_type:    (variantTypes?.get(i.sku) ?? 'physical') as ProductType,
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

  const [order] = await db.query<any>(`SELECT id, locale FROM orders WHERE id = ?`, [orderId]);
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
  // Same language as the order's emails (orders.locale; older orders fall back to French).
  const storeBaseUrl = String((c.env as any).STORE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
  const dlPath = order.locale === 'en' ? '/en/downloads/' : '/fr/telechargements/';
  const downloadUrl = `${storeBaseUrl}${dlPath}?token=${plainToken}`;

  return c.json({ token: plainToken, download_url: downloadUrl, expires_at: expiresAt }, 200);
});

export { app as orders };
