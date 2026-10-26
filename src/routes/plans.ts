import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, now, type HonoEnv } from '../types';
import { prepareCheckout } from '../lib/checkout';
import { resolveProvider, providerAvailable } from '../lib/providers';
import { minorFactor } from '../lib/currency';
import { paymentState } from '../lib/payments';
import {
  computeDeposit, getPlanSettings, savePlanSettings, ensurePayToken, payUrl, storeBase,
  sendPlanEmail, sweepPlans, startCharge, DEFAULT_PLAN_SETTINGS,
} from '../lib/plans';
import { CartIdParam, ErrorResponse } from '../schemas';

// =============================================================================
// Deposits & installments — HTTP surface
//
//   GET  /v1/carts/:cartId/deposit-quote        what would the deposit be? (storefront key)
//   POST /v1/carts/:cartId/checkout/deposit     pay the deposit online -> creates the order
//   GET  /v1/pay/:token                         customer's balance page data (storefront key)
//   POST /v1/pay/:token/checkout                pay any part of the balance online
//   POST /v1/orders/:orderId/pay-link           admin: get/create the pay link, set the due date, email it
//   GET|PUT /v1/payment-plans/settings          admin: due days, reminders, auto-cancel
//   POST /v1/payment-plans/sweep                admin: run the daily sweep now
// =============================================================================

const Quote = z.object({
  eligible: z.boolean(),
  reason: z.enum(['no_deposit_product', 'digital', 'no_provider', 'not_less_than_total']).optional(),
  total_cents: z.number().int(),
  deposit_cents: z.number().int(),
  balance_cents: z.number().int(),
  currency: z.string(),
  due_days: z.number().int(),
}).openapi('DepositQuote');

const j = (description: string, schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } }, description });
const err = (d: string) => j(d, ErrorResponse);

// ─────────────────────────────── carts ───────────────────────────────────────
export const depositRoutes = new OpenAPIHono<HonoEnv>();
depositRoutes.use('*', authMiddleware);

depositRoutes.openapi(createRoute({
  method: 'get', path: '/{cartId}/deposit-quote', tags: ['Checkout'],
  summary: 'Deposit the customer would pay now for this cart',
  request: { params: CartIdParam },
  responses: { 200: j('Quote', Quote), 404: err('Cart not found') },
}), async (c) => {
  const { cartId } = c.req.valid('param');
  const db = getDb(c.var.db);
  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');
  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
  const subtotal = items.reduce((s: number, i: any) => s + i.unit_price_cents * i.qty, 0);
  const total = subtotal - Number(cart.discount_amount_cents ?? 0);
  return c.json(await computeDeposit(db, c.env as any, items, subtotal, total, cart.currency ?? 'XOF', Number(cart.shipping_cents ?? 0)), 200);
});

const PreviewBody = z.object({
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  items: z.array(z.object({ sku: z.string().min(1), qty: z.number().int().positive().max(999) })).min(1).max(50),
  shipping_cents: z.number().int().min(0).optional().openapi({ description: 'Delivery price already quoted to the customer, shown in the balance (display only; checkout recomputes it).' }),
}).openapi('DepositPreviewBody');

depositRoutes.openapi(createRoute({
  method: 'post', path: '/deposit-preview', tags: ['Checkout'],
  summary: 'Deposit for a list of items, before any cart exists',
  description: 'Used by the storefront cart page (the cart is local until checkout). Prices are read from the catalog; discounts are not taken into account.',
  request: { body: { content: { 'application/json': { schema: PreviewBody } } } },
  responses: { 200: j('Quote', Quote), 400: err('Unknown SKU') },
}), async (c) => {
  const { items, currency: wanted, shipping_cents } = c.req.valid('json');
  const db = getDb(c.var.db);
  const lines: Array<{ sku: string; qty: number; unit_price_cents: number }> = [];
  let currency = wanted ? wanted.toUpperCase() : 'XOF';
  for (const it of items) {
    const [v] = await db.query<{ price_cents: number; currency: string | null }>(`SELECT price_cents, currency FROM variants WHERE sku = ? LIMIT 1`, [it.sku]);
    if (!v) throw ApiError.invalidRequest(`Unknown SKU: ${it.sku}`);
    if (!wanted && v.currency) currency = v.currency;
    lines.push({ sku: it.sku, qty: it.qty, unit_price_cents: Number(v.price_cents) });
  }
  const subtotal = lines.reduce((s, l) => s + l.unit_price_cents * l.qty, 0);
  return c.json(await computeDeposit(db, c.env as any, lines, subtotal, subtotal, currency, shipping_cents ?? 0), 200);
});

const DepositCheckoutBody = z.object({
  success_url: z.string().url(),
  cancel_url: z.string().url().optional(),
  provider: z.string().optional().openapi({ description: "Preferred provider ('fedapay' | 'stripe'). Falls back to any configured provider that supports the cart currency." }),
}).openapi('DepositCheckoutBody');

const DepositCheckoutResponse = z.object({
  checkout_url: z.string().url(),
  provider: z.string(),
  ref: z.string(),
  cart_id: z.string(),
  deposit_cents: z.number().int(),
  balance_cents: z.number().int(),
}).openapi('DepositCheckoutResponse');

depositRoutes.openapi(createRoute({
  method: 'post', path: '/{cartId}/checkout/deposit', tags: ['Checkout'],
  summary: 'Pay a deposit online',
  description: 'Reserves stock like a normal checkout, charges only the deposit; the order is created (status pending, partially paid) when the provider confirms.',
  request: { params: CartIdParam, body: { content: { 'application/json': { schema: DepositCheckoutBody } } } },
  responses: {
    200: j('Checkout URL', DepositCheckoutResponse), 400: err('Not eligible'),
    404: err('Cart not found'), 409: err('Cart not open'),
  },
}), async (c) => {
  const { cartId } = c.req.valid('param');
  const { success_url, cancel_url, provider: preferred } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [cartRow] = await db.query<{ currency: string | null }>(`SELECT currency FROM carts WHERE id = ?`, [cartId]);
  if (!cartRow) throw ApiError.notFound('Cart not found');
  const provider = await resolveProvider(db, c.env as any, cartRow.currency ?? 'XOF', preferred);

  const prepared = await prepareCheckout(db, cartId, provider.name);

  let quote;
  try {
    quote = await computeDeposit(db, c.env as any, prepared.items, prepared.subtotal_cents, prepared.final_amount_cents - prepared.shipping_cents, prepared.currency, prepared.shipping_cents);
    if (!quote.eligible) {
      throw ApiError.invalidRequest(`A deposit is not available for this cart (${quote.reason}).`);
    }
  } catch (e) {
    await prepared.rollback();
    throw e;
  }

  let result: { checkout_url: string; ref: string };
  try {
    result = await startCharge(db, c.env as any, provider, {
      amountCents: quote.deposit_cents, currency: prepared.currency, cartId, kind: 'deposit',
      customerEmail: prepared.cart.customer_email,
      description: ('Acompte — ' + prepared.items.map((i) => i.title).join(', ')).slice(0, 200),
      returnUrl: success_url, cancelUrl: cancel_url,
    });
  } catch (e: any) {
    await prepared.rollback();
    throw e instanceof ApiError ? e : ApiError.invalidRequest(`${provider.name} checkout error: ${e.message}`);
  }

  await db.run(
    `UPDATE carts SET discount_amount_cents = ?, updated_at = ? WHERE id = ?`,
    [prepared.discount_amount_cents, now(), cartId]
  );

  return c.json({
    checkout_url: result.checkout_url, provider: provider.name, ref: result.ref, cart_id: cartId,
    deposit_cents: quote.deposit_cents, balance_cents: quote.balance_cents,
  }, 200);
});

// ─────────────────────────────── pay links ───────────────────────────────────
export const payLinks = new OpenAPIHono<HonoEnv>();
payLinks.use('*', authMiddleware);

const TokenParam = z.object({ token: z.string().min(32).max(128).openapi({ param: { name: 'token', in: 'path' } }) });

const PayInfo = z.object({
  order_number: z.string(),
  status: z.string(),
  currency: z.string(),
  minor_factor: z.number().int().openapi({ description: 'Minor units per major unit: 1 for XOF, 100 for EUR.' }),
  total_cents: z.number().int(),
  paid_cents: z.number().int(),
  balance_cents: z.number().int(),
  payment_status: z.enum(['unpaid', 'partial', 'paid']),
  due_at: z.string().nullable(),
  overdue: z.boolean(),
  can_pay: z.boolean(),
  min_payment_cents: z.number().int(),
  locale: z.enum(['fr', 'en']),
  items: z.array(z.object({ title: z.string(), qty: z.number().int(), unit_price_cents: z.number().int() })),
  payments: z.array(z.object({ amount_cents: z.number().int(), method: z.string(), created_at: z.string() })),
}).openapi('PayInfo');

async function orderByToken(db: ReturnType<typeof getDb>, token: string) {
  const [order] = await db.query<any>(`SELECT * FROM orders WHERE pay_token = ? LIMIT 1`, [token]);
  if (!order) throw ApiError.notFound('Payment link not found');
  return order;
}

payLinks.openapi(createRoute({
  method: 'get', path: '/{token}', tags: ['Checkout'], summary: 'Balance of an order, by pay link',
  request: { params: TokenParam },
  responses: { 200: j('Order balance', PayInfo), 404: err('Not found') },
}), async (c) => {
  const { token } = c.req.valid('param');
  const db = getDb(c.var.db);
  const order = await orderByToken(db, token);
  const st = paymentState(order);
  const settings = await getPlanSettings(db);
  const items = await db.query<any>(`SELECT title, qty, unit_price_cents FROM order_items WHERE order_id = ?`, [order.id]);
  const pays = await db.query<any>(
    `SELECT amount_cents, method, created_at FROM order_payments WHERE order_id = ? ORDER BY created_at, rowid`, [order.id]
  );
  const dead = order.status === 'canceled' || order.status === 'refunded';
  return c.json({
    order_number: order.number, status: order.status, currency: order.currency,
    minor_factor: minorFactor(order.currency),
    total_cents: Number(order.total_cents), ...st,
    due_at: order.due_at ?? null,
    overdue: !!order.due_at && st.balance_cents > 0 && Date.parse(order.due_at) < Date.now(),
    can_pay: !dead && st.balance_cents > 0 && (await providerAvailable(db, c.env as any, String(order.currency))),
    min_payment_cents: settings.min_payment_cents,
    locale: (order.locale === 'en' ? 'en' : 'fr') as 'fr' | 'en',
    items: items.map((i: any) => ({ title: i.title, qty: Number(i.qty), unit_price_cents: Number(i.unit_price_cents) })),
    payments: pays.map((p: any) => ({ amount_cents: Number(p.amount_cents), method: p.method, created_at: p.created_at })),
  }, 200);
});

const PayCheckoutBody = z.object({
  amount_cents: z.number().int().positive().optional().openapi({ description: 'Defaults to the whole balance.' }),
  success_url: z.string().url(),
  cancel_url: z.string().url().optional(),
  provider: z.string().optional(),
}).openapi('PayCheckoutBody');

payLinks.openapi(createRoute({
  method: 'post', path: '/{token}/checkout', tags: ['Checkout'],
  summary: 'Pay all or part of the balance online',
  request: { params: TokenParam, body: { content: { 'application/json': { schema: PayCheckoutBody } } } },
  responses: {
    200: j('Checkout URL', z.object({ checkout_url: z.string().url(), provider: z.string(), ref: z.string(), amount_cents: z.number().int() })),
    400: err('Invalid amount or order'), 404: err('Not found'),
  },
}), async (c) => {
  const { token } = c.req.valid('param');
  const { amount_cents, success_url, cancel_url, provider: preferred } = c.req.valid('json');
  const db = getDb(c.var.db);
  const order = await orderByToken(db, token);

  if (order.status === 'canceled' || order.status === 'refunded') throw ApiError.invalidRequest('This order is no longer payable.');
  const { balance_cents } = paymentState(order);
  if (balance_cents <= 0) throw ApiError.invalidRequest('This order is already fully paid.');
  const provider = await resolveProvider(db, c.env as any, String(order.currency), preferred);

  const amount = amount_cents ?? balance_cents;
  if (amount > balance_cents) throw ApiError.invalidRequest(`Amount exceeds the balance (${balance_cents}).`);
  const settings = await getPlanSettings(db);
  if (amount < balance_cents && amount < settings.min_payment_cents) {
    throw ApiError.invalidRequest(`The minimum payment is ${settings.min_payment_cents}.`);
  }

  let result: { checkout_url: string; ref: string };
  try {
    result = await startCharge(db, c.env as any, provider, {
      amountCents: amount, currency: order.currency, cartId: order.cart_id ?? order.id,
      kind: 'payment', orderId: order.id, customerEmail: order.customer_email,
      description: `Commande ${order.number}`.slice(0, 200),
      returnUrl: success_url, cancelUrl: cancel_url,
    });
  } catch (e: any) {
    throw e instanceof ApiError ? e : ApiError.invalidRequest(`${provider.name} checkout error: ${e.message}`);
  }

  return c.json({ checkout_url: result.checkout_url, provider: provider.name, ref: result.ref, amount_cents: amount }, 200);
});

// ─────────────────────────── admin: order pay link ───────────────────────────
export const planAdmin = new OpenAPIHono<HonoEnv>();
planAdmin.use('*', authMiddleware);

const OrderIdParam = z.object({ orderId: z.string().uuid().openapi({ param: { name: 'orderId', in: 'path' } }) });

const PayLinkBody = z.object({
  due_at: z.string().datetime({ offset: true }).nullable().optional()
    .openapi({ description: 'Date the balance is expected (ISO). null removes it. Omit to leave unchanged.' }),
  send: z.boolean().optional().openapi({ description: 'Email the link (reminder wording) to the customer.' }),
}).openapi('PayLinkBody');

const PayLinkResponse = z.object({
  pay_url: z.string(), due_at: z.string().nullable(), emailed: z.boolean(),
}).openapi('PayLinkResponse');

planAdmin.openapi(createRoute({
  method: 'post', path: '/{orderId}/pay-link', tags: ['Orders'],
  summary: 'Get the order\'s pay link, set its due date, optionally email it',
  security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  request: { params: OrderIdParam, body: { content: { 'application/json': { schema: PayLinkBody } } } },
  responses: { 200: j('Link', PayLinkResponse), 400: err('Invalid'), 404: err('Order not found') },
}), async (c) => {
  const { orderId } = c.req.valid('param');
  const body = c.req.valid('json');
  const db = getDb(c.var.db);
  let [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status === 'canceled' || order.status === 'refunded') throw ApiError.invalidRequest(`The order is ${order.status}.`);

  if (body.due_at !== undefined) {
    // A new date restarts the reminder.
    await db.run(`UPDATE orders SET due_at = ?, reminder_sent_at = NULL WHERE id = ?`, [body.due_at, orderId]);
  }
  const token = await ensurePayToken(db, order);
  [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);

  const base = storeBase(c.env as any);
  const url = payUrl(base, order.locale, token);

  let emailed = false;
  if (body.send) {
    if (paymentState(order).balance_cents <= 0) throw ApiError.invalidRequest('Nothing left to pay on this order.');
    const overdue = !!order.due_at && Date.parse(order.due_at) < Date.now();
    await sendPlanEmail(db, order, overdue ? 'overdue' : 'reminder', { storeBaseUrl: base, storeName: c.env.STORE_NAME ?? 'Your Store' });
    emailed = true;
  }
  return c.json({ pay_url: url, due_at: order.due_at ?? null, emailed }, 200);
});

// ─────────────────────────── admin: settings & sweep ─────────────────────────
export const planSettings = new OpenAPIHono<HonoEnv>();
planSettings.use('*', authMiddleware);

const Settings = z.object({
  auto_cancel: z.boolean(),
  due_days: z.number().int().min(1).max(365),
  grace_days: z.number().int().min(0).max(90),
  reminder_days: z.number().int().min(0).max(60),
  min_payment_cents: z.number().int().min(0),
}).openapi('PaymentPlanSettings');

planSettings.openapi(createRoute({
  method: 'get', path: '/settings', tags: ['Orders'], summary: 'Deposit / installment settings',
  security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  responses: { 200: j('Settings', Settings) },
}), async (c) => c.json(await getPlanSettings(getDb(c.var.db)), 200));

planSettings.openapi(createRoute({
  method: 'put', path: '/settings', tags: ['Orders'], summary: 'Update deposit / installment settings',
  security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  request: { body: { content: { 'application/json': { schema: Settings.partial() } } } },
  responses: { 200: j('Settings', Settings) },
}), async (c) => {
  const db = getDb(c.var.db);
  const next = { ...(await getPlanSettings(db)), ...c.req.valid('json') };
  await savePlanSettings(db, next);
  return c.json(await getPlanSettings(db), 200);
});

planSettings.openapi(createRoute({
  method: 'post', path: '/sweep', tags: ['Orders'], summary: 'Send due reminders and auto-cancel overdue orders now',
  description: 'The same job the daily cron runs.',
  security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  responses: { 200: j('Result', z.object({ checked: z.number().int(), reminded: z.number().int(), canceled: z.number().int() })) },
}), async (c) => {
  const db = getDb(c.var.db);
  const r = await sweepPlans(db, { storeBaseUrl: storeBase(c.env as any), storeName: c.env.STORE_NAME ?? 'Your Store' });
  return c.json(r, 200);
});

export { DEFAULT_PLAN_SETTINGS };
