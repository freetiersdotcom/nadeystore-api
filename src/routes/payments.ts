import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { dispatchWebhooks } from '../lib/webhooks';
import { createOrderFromCart } from '../lib/orders';
import { recordPayment, paymentState, MANUAL_PAYMENT_METHODS } from '../lib/payments';
import { ErrorResponse } from '../schemas';

// =============================================================================
// Payments on an order + orders entered by hand
//
//   GET    /v1/orders/:orderId/payments
//   POST   /v1/orders/:orderId/payments            record cash / mobile money / transfer received
//   DELETE /v1/orders/:orderId/payments/:paymentId void a mistaken entry
//   POST   /v1/orders/manual                       merchant-entered order (counter sale, phone order…)
//
// All admin-only. Mounted next to the orders router at /v1/orders.
// =============================================================================

const OrderIdParam = z.object({ orderId: z.string().uuid().openapi({ param: { name: 'orderId', in: 'path' } }) });
const PaymentIdParam = z.object({
  orderId: z.string().uuid().openapi({ param: { name: 'orderId', in: 'path' } }),
  paymentId: z.string().openapi({ param: { name: 'paymentId', in: 'path' } }),
});

const PaymentMethodEnum = z.enum(MANUAL_PAYMENT_METHODS);

const PaymentRow = z.object({
  id: z.string(),
  amount_cents: z.number().int(),
  method: z.string(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
});

const PaymentsResponse = z.object({
  order_id: z.string(),
  status: z.string(),
  total_cents: z.number().int(),
  paid_cents: z.number().int(),
  balance_cents: z.number().int(),
  payment_status: z.enum(['unpaid', 'partial', 'paid']),
  payments: z.array(PaymentRow),
}).openapi('OrderPayments');

const RecordPaymentBody = z.object({
  amount_cents: z.number().int().positive().optional().openapi({ description: 'Defaults to the remaining balance.' }),
  method: PaymentMethodEnum,
  reference: z.string().max(200).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
}).openapi('RecordPayment');

async function loadPayments(db: ReturnType<typeof getDb>, orderId: string) {
  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');
  const rows = await db.query<any>(
    `SELECT id, amount_cents, method, reference, note, created_at FROM order_payments WHERE order_id = ? ORDER BY created_at, rowid`,
    [orderId]
  );
  const st = paymentState(order);
  return {
    order_id: order.id as string,
    status: order.status as string,
    total_cents: Number(order.total_cents),
    ...st,
    payments: rows.map((r) => ({
      id: r.id as string,
      amount_cents: Number(r.amount_cents),
      method: r.method as string,
      reference: (r.reference ?? null) as string | null,
      note: (r.note ?? null) as string | null,
      created_at: r.created_at as string,
    })),
  };
}

export const payments = new OpenAPIHono<HonoEnv>();
payments.use('*', authMiddleware);

// ── GET payments ────────────────────────────────────────────────────────────
const listPayments = createRoute({
  method: 'get',
  path: '/{orderId}/payments',
  tags: ['Orders'],
  summary: 'List the payments received on an order',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: OrderIdParam },
  responses: {
    200: { content: { 'application/json': { schema: PaymentsResponse } }, description: 'Payments' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Order not found' },
  },
});

payments.openapi(listPayments, async (c) => {
  const { orderId } = c.req.valid('param');
  return c.json(await loadPayments(getDb(c.var.db), orderId), 200);
});

// ── POST payment ────────────────────────────────────────────────────────────
const addPayment = createRoute({
  method: 'post',
  path: '/{orderId}/payments',
  tags: ['Orders'],
  summary: 'Record a payment received outside the payment provider',
  description: 'Cash, mobile money, bank transfer… Partial amounts are fine; the order is marked paid when the balance reaches zero.',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: OrderIdParam,
    body: { content: { 'application/json': { schema: RecordPaymentBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: PaymentsResponse } }, description: 'Updated payments' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid amount or order state' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Order not found' },
  },
});

payments.openapi(addPayment, async (c) => {
  const { orderId } = c.req.valid('param');
  const body = c.req.valid('json');
  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status === 'canceled' || order.status === 'refunded') {
    throw ApiError.invalidRequest(`Cannot record a payment on a ${order.status} order.`);
  }

  const { balance_cents } = paymentState(order);
  if (balance_cents <= 0) throw ApiError.invalidRequest('This order is already fully paid.');
  const amount = body.amount_cents ?? balance_cents;
  if (amount > balance_cents) {
    throw ApiError.invalidRequest(`Amount exceeds the balance due (${balance_cents}).`);
  }

  const result = await recordPayment(db, order, {
    amount_cents: amount,
    method: body.method,
    reference: body.reference,
    note: body.note,
  });

  const out = await loadPayments(db, orderId);
  await dispatchWebhooks(c.var.db, c.executionCtx, 'order.updated', {
    order: { id: order.id, number: order.number, status: out.status, payment_status: out.payment_status,
             paid_cents: out.paid_cents, balance_cents: out.balance_cents },
    payment: { id: result.id, amount_cents: amount, method: body.method },
    previous_status: order.status,
  });
  return c.json(out, 200);
});

// ── DELETE payment (void) ───────────────────────────────────────────────────
const voidPayment = createRoute({
  method: 'delete',
  path: '/{orderId}/payments/{paymentId}',
  tags: ['Orders'],
  summary: 'Void a payment entered by mistake',
  description: 'Only manually recorded payments can be voided. Money taken by the payment provider is refunded, not voided.',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: PaymentIdParam },
  responses: {
    200: { content: { 'application/json': { schema: PaymentsResponse } }, description: 'Updated payments' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not voidable' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});

payments.openapi(voidPayment, async (c) => {
  const { orderId, paymentId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');
  const [pay] = await db.query<any>(`SELECT * FROM order_payments WHERE id = ? AND order_id = ?`, [paymentId, orderId]);
  if (!pay) throw ApiError.notFound('Payment not found');
  if (pay.method === 'online') throw ApiError.invalidRequest('Online payments cannot be voided; refund the order instead.');

  await db.run(`DELETE FROM order_payments WHERE id = ?`, [paymentId]);
  const [sum] = await db.query<{ total: number }>(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM order_payments WHERE order_id = ?`, [orderId]
  );
  const newPaid = Number(sum?.total ?? 0);
  const sets = ['amount_paid_cents = ?'];
  const params: unknown[] = [newPaid];
  if (newPaid < Number(order.total_cents)) {
    sets.push('paid_at = NULL');
    if (order.status === 'paid') sets.push(`status = 'pending'`);
  }
  params.push(orderId);
  await db.run(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, params);

  return c.json(await loadPayments(db, orderId), 200);
});

// ── POST /manual: order entered by the merchant ─────────────────────────────
const ManualOrderBody = z.object({
  customer_email: z.string().email(),
  customer_name: z.string().max(200).optional(),
  address: z.object({
    line1: z.string().min(1),
    line2: z.string().nullable().optional(),
    city: z.string().min(1),
    state: z.string().nullable().optional(),
    postal_code: z.string().min(1).openapi({ description: 'Phone number or postal code (same convention as the storefront form).' }),
    country: z.string().length(2),
  }).optional(),
  currency: z.string().length(3).toUpperCase().default('XOF'),
  locale: z.enum(['fr', 'en']).default('fr'),
  items: z.array(z.object({
    sku: z.string().min(1),
    qty: z.number().int().positive(),
    unit_price_cents: z.number().int().nonnegative().optional().openapi({ description: 'Override the catalog price (negotiated price).' }),
  })).min(1),
  payment: z.object({
    amount_cents: z.number().int().positive(),
    method: PaymentMethodEnum,
    reference: z.string().max(200).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
  }).optional(),
}).openapi('ManualOrder');

const ManualOrderResponse = z.object({
  order_id: z.string(),
  order_number: z.string(),
  status: z.string(),
  total_cents: z.number().int(),
  paid_cents: z.number().int(),
  balance_cents: z.number().int(),
  payment_status: z.enum(['unpaid', 'partial', 'paid']),
}).openapi('ManualOrderResult');

const createManual = createRoute({
  method: 'post',
  path: '/manual',
  tags: ['Orders'],
  summary: 'Create an order entered by the merchant',
  description: 'For counter sales, phone or WhatsApp orders. Stock is taken for physical items; an optional first payment is recorded. No email is sent.',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { body: { content: { 'application/json': { schema: ManualOrderBody } } } },
  responses: {
    200: { content: { 'application/json': { schema: ManualOrderResponse } }, description: 'Order created' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid items or payment' },
  },
});

payments.openapi(createManual, async (c) => {
  const body = c.req.valid('json');
  const db = getDb(c.var.db);

  // Resolve variants and check stock before touching anything.
  const lines: Array<{ sku: string; title: string; qty: number; price: number; type: string }> = [];
  const wanted = new Map<string, number>(); // physical qty per sku, to catch duplicates
  for (const it of body.items) {
    const [v] = await db.query<any>(
      `SELECT v.sku, v.title, v.price_cents, v.product_type, p.title AS product_title
         FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ? LIMIT 1`,
      [it.sku]
    );
    if (!v) throw ApiError.invalidRequest(`Unknown SKU: ${it.sku}`);
    const type = v.product_type ?? 'physical';
    if (type === 'digital') throw ApiError.invalidRequest(`${it.sku}: digital products cannot be added to a manual order.`);
    if (type === 'physical') wanted.set(it.sku, (wanted.get(it.sku) ?? 0) + it.qty);
    const title = v.product_title && v.product_title !== v.title ? `${v.product_title} — ${v.title}` : v.title;
    lines.push({ sku: it.sku, title, qty: it.qty, price: it.unit_price_cents ?? Number(v.price_cents), type });
  }
  for (const [sku, qty] of wanted) {
    const [inv] = await db.query<{ on_hand: number; reserved: number }>(
      `SELECT on_hand, reserved FROM inventory WHERE sku = ?`, [sku]
    );
    if ((inv?.on_hand ?? 0) - (inv?.reserved ?? 0) < qty) throw ApiError.insufficientInventory(sku);
  }

  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  if (body.payment && body.payment.amount_cents > total) {
    throw ApiError.invalidRequest(`Payment exceeds the order total (${total}).`);
  }

  // Build a checked-out cart with reserved stock, then reuse the normal order
  // creation (customer upsert, stock, webhooks) so there is a single code path.
  const cartId = uuid();
  const { line1, line2, city, state, postal_code, country } = body.address ?? {} as any;
  await db.run(
    `INSERT INTO carts (id, status, customer_email, currency, ship_to, shipping_name, locale, expires_at)
     VALUES (?, 'checked_out', ?, ?, ?, ?, ?, ?)`,
    [cartId, body.customer_email, body.currency,
     body.address ? JSON.stringify({ line1, line2: line2 ?? null, city, state: state ?? null, postal_code, country }) : null,
     body.customer_name ?? null, body.locale, new Date(Date.now() + 3600_000).toISOString()]
  );
  for (const l of lines) {
    await db.run(
      `INSERT INTO cart_items (id, cart_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), cartId, l.sku, l.title, l.qty, l.price]
    );
    if (l.type === 'physical') {
      await db.run(`UPDATE inventory SET reserved = reserved + ?, updated_at = ? WHERE sku = ?`, [l.qty, now(), l.sku]);
    }
  }

  const storeBaseUrl = (c.env as any).STORE_URL ?? 'https://yourstore.com';
  let result;
  try {
    result = await createOrderFromCart(db, c.var.db, c.executionCtx, cartId, {
      provider: 'manual',
      providerRef: cartId,
      storeBaseUrl,
      storeName: c.env.STORE_NAME ?? 'Your Store',
      paymentMethod: 'manual',
      skipEmail: true,
    });
  } catch (err) {
    const [existing] = await db.query<{ id: string }>(`SELECT id FROM orders WHERE cart_id = ? LIMIT 1`, [cartId]);
    if (!existing) {
      for (const l of lines) {
        if (l.type === 'physical') {
          await db.run(`UPDATE inventory SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE sku = ?`, [l.qty, now(), l.sku]);
        }
      }
    }
    throw err;
  }
  if (!result) throw ApiError.invalidRequest('Could not create the order.');

  let [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [result.orderId]);
  if (body.payment) {
    await recordPayment(db, order, body.payment);
    [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [result.orderId]);
  }

  return c.json({
    order_id: order.id as string,
    order_number: order.number as string,
    status: order.status as string,
    total_cents: Number(order.total_cents),
    ...paymentState(order),
  }, 200);
});
