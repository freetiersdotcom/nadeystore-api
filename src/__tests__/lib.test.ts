// =============================================================================
// src/__tests__/lib.test.ts
//
// Tests for the core library functions:
//   - lib/checkout.ts (prepareCheckout, setCartShipping)
//   - lib/orders.ts   (createOrderFromCart)
//   - lib/downloads.ts (createDownloadTokens, validateDownloadToken, incrementDownloadCount)
//   - lib/fedapay.ts  (verifyFedaPaySignature, createFedaPayCheckout)
//   - lib/email/index.ts (getEmailProvider)
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { getDb } from '../db';
import { uuid, now } from '../types';
import {
  createTestDb, seedApiKeys, seedProduct, seedCart,
  seedStripeConfig, seedFedaPayConfig, seedEmailConfig,
  seedDiscount, seedDownloadToken,
  mockFetch, MOCK_RESPONSES,
  signFedaPayWebhook,
} from './setup';
import { prepareCheckout, setCartShipping } from '../lib/checkout';
import { createOrderFromCart } from '../lib/orders';
import {
  createDownloadTokens,
  validateDownloadToken,
  incrementDownloadCount,
} from '../lib/downloads';
import { verifyFedaPaySignature, createFedaPayCheckout } from '../lib/fedapay';
import { getEmailProvider } from '../lib/email/index';

// ── prepareCheckout ───────────────────────────────────────────────────────────

describe('prepareCheckout()', () => {
  let db: ReturnType<typeof getDb>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it('locks cart and returns correct amounts for a basic cart', async () => {
    const { sku } = await seedProduct(db, { price_cents: 2000, on_hand: 5 });
    const cartId  = await seedCart(db, [{ sku, qty: 2, price_cents: 2000 }], { currency: 'XOF' });

    const result = await prepareCheckout(db, cartId, 'fedapay');

    expect(result.subtotal_cents).toBe(4000);
    expect(result.discount_amount_cents).toBe(0);
    expect(result.final_amount_cents).toBe(4000);
    expect(result.currency).toBe('XOF');

    // Cart should be locked
    const [cart] = await db.query<{ status: string }>(
      `SELECT status FROM carts WHERE id = ? LIMIT 1`, [cartId]
    );
    expect(cart.status).toBe('checked_out');
  });

  it('rejects non-existent cart', async () => {
    await expect(prepareCheckout(db, uuid(), 'fedapay')).rejects.toThrow();
  });

  it('rejects already-checked-out cart', async () => {
    const { sku } = await seedProduct(db, { on_hand: 5 });
    const cartId  = await seedCart(db, [{ sku, qty: 1, price_cents: 1000 }]);
    await db.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);

    await expect(prepareCheckout(db, cartId, 'fedapay')).rejects.toThrow();
  });

  it('rejects empty cart', async () => {
    const cartId = uuid();
    await db.run(
      `INSERT INTO carts (id, status, customer_email, currency, expires_at)
       VALUES (?, 'open', 'a@b.com', 'XOF', ?)`,
      [cartId, new Date(Date.now() + 3_600_000).toISOString()]
    );

    await expect(prepareCheckout(db, cartId, 'fedapay')).rejects.toThrow('empty');
  });

  it('reserves inventory during checkout', async () => {
    const { sku } = await seedProduct(db, { price_cents: 1000, on_hand: 3 });
    const cartId  = await seedCart(db, [{ sku, qty: 2, price_cents: 1000 }]);

    await prepareCheckout(db, cartId, 'fedapay');

    const [inv] = await db.query<{ reserved: number }>(
      `SELECT reserved FROM inventory WHERE sku = ? LIMIT 1`, [sku]
    );
    expect(inv.reserved).toBe(2);
  });

  it('rejects when insufficient inventory', async () => {
    const { sku } = await seedProduct(db, { price_cents: 1000, on_hand: 1 });
    const cartId  = await seedCart(db, [{ sku, qty: 5, price_cents: 1000 }]);

    await expect(prepareCheckout(db, cartId, 'fedapay'))
      .rejects.toThrow(/inventory/i);
  });

  it('rolls back cart status on inventory failure', async () => {
    const { sku } = await seedProduct(db, { price_cents: 1000, on_hand: 1 });
    const cartId  = await seedCart(db, [{ sku, qty: 5, price_cents: 1000 }]);

    try { await prepareCheckout(db, cartId, 'fedapay'); } catch {}

    const [cart] = await db.query<{ status: string }>(
      `SELECT status FROM carts WHERE id = ? LIMIT 1`, [cartId]
    );
    expect(cart.status).toBe('open');
  });

  it('applies fixed discount correctly', async () => {
    const { sku }        = await seedProduct(db, { price_cents: 2000, on_hand: 5 });
    const discountId     = await seedDiscount(db, { type: 'fixed_amount', value: 300 });
    const [discountRow]  = await db.query<{ code: string }>(`SELECT code FROM discounts WHERE id = ?`, [discountId]);
    const cartId         = await seedCart(db, [{ sku, qty: 1, price_cents: 2000 }]);

    await db.run(
      `UPDATE carts SET discount_id = ?, discount_code = ? WHERE id = ?`,
      [discountId, discountRow.code, cartId]
    );

    const result = await prepareCheckout(db, cartId, 'fedapay');

    expect(result.discount_amount_cents).toBe(300);
    expect(result.final_amount_cents).toBe(1700);
  });

  it('rejects unsupported currency for provider', async () => {
    const { sku } = await seedProduct(db, { price_cents: 1000, on_hand: 5 });
    // FedaPay supports XOF, EUR, USD, GBP — not NGN
    const cartId  = await seedCart(db, [{ sku, qty: 1, price_cents: 1000 }], { currency: 'NGN' });

    await expect(prepareCheckout(db, cartId, 'fedapay'))
      .rejects.toThrow(/NGN/);
  });

  it('rollback() releases inventory reservation', async () => {
    const { sku } = await seedProduct(db, { price_cents: 1000, on_hand: 5 });
    const cartId  = await seedCart(db, [{ sku, qty: 2, price_cents: 1000 }]);
    const result  = await prepareCheckout(db, cartId, 'fedapay');

    await result.rollback();

    const [inv] = await db.query<{ reserved: number }>(
      `SELECT reserved FROM inventory WHERE sku = ? LIMIT 1`, [sku]
    );
    expect(inv.reserved).toBe(0);

    const [cart] = await db.query<{ status: string }>(
      `SELECT status FROM carts WHERE id = ? LIMIT 1`, [cartId]
    );
    expect(cart.status).toBe('open');
  });
});

// ── setCartShipping ───────────────────────────────────────────────────────────

describe('setCartShipping()', () => {
  let db: ReturnType<typeof getDb>;

  beforeEach(async () => { db = await createTestDb(); });

  it('saves shipping address to cart', async () => {
    const cartId = uuid();
    await db.run(
      `INSERT INTO carts (id, status, customer_email, currency, expires_at)
       VALUES (?, 'open', 'a@b.com', 'XOF', ?)`,
      [cartId, new Date(Date.now() + 3_600_000).toISOString()]
    );

    await setCartShipping(db, cartId, {
      name:        'Jean Dupont',
      line1:       '12 Rue de la Paix',
      city:        'Cotonou',
      postal_code: '00229',
      country:     'BJ',
    });

    const [cart] = await db.query<{ ship_to: string; shipping_name: string }>(
      `SELECT ship_to, shipping_name FROM carts WHERE id = ? LIMIT 1`, [cartId]
    );
    const addr = JSON.parse(cart.ship_to);
    expect(addr.line1).toBe('12 Rue de la Paix');
    expect(addr.country).toBe('BJ');
    expect(cart.shipping_name).toBe('Jean Dupont');
  });
});

// ── createOrderFromCart ───────────────────────────────────────────────────────

describe('createOrderFromCart()', () => {
  let db: ReturnType<typeof getDb>;
  let doStub: any;
  let restore: () => void;

  beforeEach(async () => {
    const id = env.MERCHANT.newUniqueId();
    doStub   = env.MERCHANT.get(id);
    db       = getDb(doStub);
    await seedEmailConfig(db);

    // Mock outbound fetch (email + webhooks)
    restore = mockFetch((url) => {
      if (url.includes('resend.com')) return MOCK_RESPONSES.resendSend();
      return MOCK_RESPONSES.outboundWebhook();
    });
  });

  afterEach(() => restore());

  const fakeCtx = {
    waitUntil: (p: Promise<any>) => p,
    passThroughOnException: () => {},
  } as ExecutionContext;

  const orderCtx = {
    provider:     'test',
    providerRef:  'ref_123',
    storeBaseUrl: 'https://teststore.com',
    storeName:    'Test Store',
  };

  it('creates order with correct amounts from cart', async () => {
    const { sku }   = await seedProduct(db, { price_cents: 3000, on_hand: 5 });
    const cartId    = await seedCart(db, [{ sku, qty: 2, price_cents: 3000 }], { currency: 'XOF' });

    // Simulate checkout lock
    await db.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);

    const result = await createOrderFromCart(db, doStub, fakeCtx, cartId, orderCtx);

    expect(result).not.toBeNull();
    expect(result!.orderNumber).toMatch(/^ORD-/);

    const [order] = await db.query<any>(
      `SELECT * FROM orders WHERE id = ? LIMIT 1`, [result!.orderId]
    );
    expect(order.status).toBe('paid');
    expect(order.subtotal_cents).toBe(6000);
    expect(order.total_cents).toBe(6000);
    expect(order.currency).toBe('XOF');
  });

  it('creates customer record for new email', async () => {
    const { sku } = await seedProduct(db, { price_cents: 1000, on_hand: 5 });
    const cartId  = await seedCart(db, [{ sku, qty: 1, price_cents: 1000 }],
      { email: 'new@customer.com' });
    await db.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);

    const result = await createOrderFromCart(db, doStub, fakeCtx, cartId, orderCtx);

    const [customer] = await db.query<any>(
      `SELECT * FROM customers WHERE email = 'new@customer.com' LIMIT 1`
    );
    expect(customer).toBeDefined();
    expect(customer.order_count).toBe(1);
  });

  it('increments existing customer order_count', async () => {
    const { sku } = await seedProduct(db, { price_cents: 1000, on_hand: 10 });
    const email   = 'returning@customer.com';

    // First order
    const cart1 = await seedCart(db, [{ sku, qty: 1, price_cents: 1000 }], { email });
    await db.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cart1]);
    await createOrderFromCart(db, doStub, fakeCtx, cart1, orderCtx);

    // Second order
    const cart2 = await seedCart(db, [{ sku, qty: 1, price_cents: 1000 }], { email });
    await db.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cart2]);
    await createOrderFromCart(db, doStub, fakeCtx, cart2, orderCtx);

    const [customer] = await db.query<any>(
      `SELECT order_count FROM customers WHERE email = ? LIMIT 1`, [email]
    );
    expect(customer.order_count).toBe(2);
  });

  it('creates order items and deducts inventory', async () => {
    const { sku } = await seedProduct(db, { price_cents: 1000, on_hand: 5 });
    const cartId  = await seedCart(db, [{ sku, qty: 3, price_cents: 1000 }]);
    await db.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);

    const result = await createOrderFromCart(db, doStub, fakeCtx, cartId, orderCtx);

    const items = await db.query<any>(
      `SELECT * FROM order_items WHERE order_id = ?`, [result!.orderId]
    );
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(3);

    const [inv] = await db.query<any>(`SELECT on_hand FROM inventory WHERE sku = ?`, [sku]);
    expect(inv.on_hand).toBe(2); // 5 - 3
  });

  it('generates download tokens for digital items', async () => {
    const { sku } = await seedProduct(db, { product_type: 'digital', price_cents: 500, on_hand: 100 });
    await db.run(`UPDATE variants SET digital_asset_key = 'assets/test.pdf' WHERE sku = ?`, [sku]);
    const cartId  = await seedCart(db, [{ sku, qty: 1, price_cents: 500 }]);
    await db.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);

    const result = await createOrderFromCart(db, doStub, fakeCtx, cartId, orderCtx);

    const tokens = await db.query<any>(
      `SELECT * FROM download_tokens WHERE order_id = ?`, [result!.orderId]
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0].sku).toBe(sku);
    expect(tokens[0].token_hash).toBeTruthy();
    expect(tokens[0].max_downloads).toBe(5);
  });

  it('does not generate tokens for physical items', async () => {
    const { sku } = await seedProduct(db, { product_type: 'physical', price_cents: 1000, on_hand: 5 });
    const cartId  = await seedCart(db, [{ sku, qty: 1, price_cents: 1000 }]);
    await db.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);

    const result = await createOrderFromCart(db, doStub, fakeCtx, cartId, orderCtx);

    const tokens = await db.query<any>(
      `SELECT * FROM download_tokens WHERE order_id = ?`, [result!.orderId]
    );
    expect(tokens).toHaveLength(0);
  });

  it('records discount usage', async () => {
    const { sku }        = await seedProduct(db, { price_cents: 2000, on_hand: 5 });
    const discountId     = await seedDiscount(db, { type: 'fixed_amount', value: 300 });
    const [discountRow]  = await db.query<{ code: string }>(`SELECT code FROM discounts WHERE id = ?`, [discountId]);
    const cartId         = await seedCart(db, [{ sku, qty: 1, price_cents: 2000 }]);

    await db.run(
      `UPDATE carts SET status = 'checked_out', discount_id = ?, discount_code = ?,
       discount_amount_cents = 300 WHERE id = ?`,
      [discountId, discountRow.code, cartId]
    );

    const result = await createOrderFromCart(db, doStub, fakeCtx, cartId, orderCtx);

    const [usage] = await db.query<any>(
      `SELECT * FROM discount_usage WHERE order_id = ?`, [result!.orderId]
    );
    expect(usage).toBeDefined();
    expect(usage.discount_amount_cents).toBe(300);
  });

  it('skips already-processed cart (expired status)', async () => {
    const { sku } = await seedProduct(db, { price_cents: 1000, on_hand: 5 });
    const cartId  = await seedCart(db, [{ sku, qty: 1, price_cents: 1000 }]);
    await db.run(`UPDATE carts SET status = 'expired' WHERE id = ?`, [cartId]);

    const result = await createOrderFromCart(db, doStub, fakeCtx, cartId, orderCtx);
    expect(result).toBeNull();
  });

  it('marks cart expired after order creation', async () => {
    const { sku } = await seedProduct(db, { price_cents: 1000, on_hand: 5 });
    const cartId  = await seedCart(db, [{ sku, qty: 1, price_cents: 1000 }]);
    await db.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);

    await createOrderFromCart(db, doStub, fakeCtx, cartId, orderCtx);

    const [cart] = await db.query<{ status: string }>(
      `SELECT status FROM carts WHERE id = ? LIMIT 1`, [cartId]
    );
    expect(cart.status).toBe('expired');
  });

  it('includes shipping address in order when set on cart', async () => {
    const { sku } = await seedProduct(db, { price_cents: 1000, on_hand: 5 });
    const cartId  = await seedCart(db, [{ sku, qty: 1, price_cents: 1000 }]);

    const addr = { line1: '12 Rue Test', city: 'Cotonou', postal_code: '229', country: 'BJ' };
    await db.run(
      `UPDATE carts SET status = 'checked_out', ship_to = ?, shipping_name = ? WHERE id = ?`,
      [JSON.stringify(addr), 'Jean Dupont', cartId]
    );

    const result = await createOrderFromCart(db, doStub, fakeCtx, cartId, orderCtx);

    const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [result!.orderId]);
    expect(order.shipping_name).toBe('Jean Dupont');
    const saved = JSON.parse(order.ship_to);
    expect(saved.country).toBe('BJ');
  });
});

// ── Download token utilities ──────────────────────────────────────────────────

describe('download token utilities', () => {
  let db: ReturnType<typeof getDb>;
  let orderId: string;
  let sku: string;

  beforeEach(async () => {
    db      = await createTestDb();
    orderId = uuid();
    sku     = 'DIG-001';

    await db.run(`INSERT INTO products (id, title) VALUES (?, 'Digital')`, [uuid()]);
    const pid = uuid();
    await db.run(
      `INSERT INTO variants (id, product_id, sku, title, price_cents, weight_g, product_type)
       VALUES (?, ?, ?, 'Digital', 1000, 0, 'digital')`,
      [pid, pid, sku]
    );
    await db.run(
      `INSERT INTO orders (id, number, status, customer_email, subtotal_cents,
       tax_cents, shipping_cents, total_cents, currency)
       VALUES (?, 'ORD-TEST-001', 'paid', 'a@b.com', 1000, 0, 0, 1000, 'XOF')`,
      [orderId]
    );
  });

  it('createDownloadTokens inserts hashed token', async () => {
    const records = await createDownloadTokens(db, orderId, [{ sku }]);

    expect(records).toHaveLength(1);
    expect(records[0].plain_token).toHaveLength(64);
    expect(records[0].sku).toBe(sku);

    const rows = await db.query<any>(`SELECT * FROM download_tokens WHERE order_id = ?`, [orderId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(records[0].plain_token); // hash != plain
  });

  it('validateDownloadToken returns ok for valid token', async () => {
    const plainToken = await seedDownloadToken(db, orderId, sku);
    const result     = await validateDownloadToken(db, plainToken);

    expect(result.ok).toBe(true);
  });

  it('validateDownloadToken returns not_found for unknown token', async () => {
    const result = await validateDownloadToken(db, 'invalid_token_that_does_not_exist');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('validateDownloadToken returns expired for old token', async () => {
    const plainToken = await seedDownloadToken(db, orderId, sku, { expired: true });
    const result     = await validateDownloadToken(db, plainToken);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('validateDownloadToken returns limit_reached when exhausted', async () => {
    const plainToken = await seedDownloadToken(db, orderId, sku, {
      maxDownloads: 2, downloadCount: 2,
    });
    const result = await validateDownloadToken(db, plainToken);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('limit_reached');
  });

  it('incrementDownloadCount increments counter', async () => {
    const plainToken = await seedDownloadToken(db, orderId, sku, { maxDownloads: 3 });
    const result     = await validateDownloadToken(db, plainToken);
    if (!result.ok) throw new Error('Token should be valid');

    const ok = await incrementDownloadCount(db, result.token.id, 3);
    expect(ok).toBe(true);

    const [row] = await db.query<any>(
      `SELECT download_count FROM download_tokens WHERE id = ?`, [result.token.id]
    );
    expect(row.download_count).toBe(1);
  });

  it('incrementDownloadCount returns false when limit reached', async () => {
    const plainToken = await seedDownloadToken(db, orderId, sku, {
      maxDownloads: 1, downloadCount: 1,
    });
    const result = await validateDownloadToken(db, plainToken);
    if (result.ok) {
      const ok = await incrementDownloadCount(db, result.token.id, 1);
      expect(ok).toBe(false);
    } else {
      // Token at limit — already not valid
      expect(result.reason).toBe('limit_reached');
    }
  });
});

// ── FedaPay signature verification ───────────────────────────────────────────

describe('verifyFedaPaySignature()', () => {
  const secret = 'test_webhook_secret';

  it('accepts valid signature', async () => {
    const body = JSON.stringify({ name: 'transaction.approved', object: { id: 1 } });
    const sig  = await signFedaPayWebhook(body, secret);
    await expect(verifyFedaPaySignature(body, sig, secret)).resolves.toBeUndefined();
  });

  it('rejects tampered body', async () => {
    const body    = JSON.stringify({ name: 'transaction.approved', object: { id: 1 } });
    const sig     = await signFedaPayWebhook(body, secret);
    const tampered = body + 'extra';
    await expect(verifyFedaPaySignature(tampered, sig, secret)).rejects.toThrow();
  });

  it('rejects wrong secret', async () => {
    const body = JSON.stringify({ name: 'transaction.approved' });
    const sig  = await signFedaPayWebhook(body, secret);
    await expect(verifyFedaPaySignature(body, sig, 'wrong_secret')).rejects.toThrow();
  });

  it('rejects missing header components', async () => {
    const body = '{}';
    await expect(verifyFedaPaySignature(body, 'malformed', secret)).rejects.toThrow(/missing/i);
  });

  it('rejects stale timestamp (>5 minutes)', async () => {
    const body      = '{}';
    const timestamp = Math.floor(Date.now() / 1000) - 400; // 6+ minutes ago
    const encoder   = new TextEncoder();
    const key       = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
    const sig = `t=${timestamp},s=${Array.from(new Uint8Array(mac))
      .map(b => b.toString(16).padStart(2, '0')).join('')}`;

    await expect(verifyFedaPaySignature(body, sig, secret)).rejects.toThrow(/old/i);
  });
});

// ── createFedaPayCheckout ─────────────────────────────────────────────────────

describe('createFedaPayCheckout()', () => {
  let restore: () => void;

  afterEach(() => restore?.());

  it('calls FedaPay API in correct order and returns checkout URL', async () => {
    const calls: string[] = [];
    restore = mockFetch((url) => {
       if (url.includes('/token')) return new Response(JSON.stringify(fedaPayTokenResponse()), { status: 200 });
       return new Response(JSON.stringify(fedaPayCreateTransactionResponse(99)), { status: 200 });
    });

    const result = await createFedaPayCheckout({
      cartId:        'cart_123',
      amountCents:   5000,
      currency:      'XOF',
      customerEmail: 'buyer@test.com',
      description:   'Test product',
      callbackUrl:   'https://store.com/success',
      config:        { secret_key: 'sk_test', webhook_secret: 'wh_test', sandbox: true },
    });

    expect(result.transaction_id).toBe(99);
    expect(result.checkout_url).toContain('checkout.fedapay.com');
    expect(calls[0]).toContain('sandbox-api.fedapay.com/v1/transactions');
    expect(calls[1]).toContain('/token');
  });

  it('sends merchant_reference as cartId', async () => {
    let capturedBody = '';
    restore = mockFetch((url, init) => {
      if (!url.includes('/token')) capturedBody = init?.body as string;
      return url.includes('/token')
        ? MOCK_RESPONSES.fedaPayToken()
        : MOCK_RESPONSES.fedaPayCreate();
    });

    await createFedaPayCheckout({
      cartId: 'my_cart_id',
      amountCents: 1000, currency: 'XOF',
      customerEmail: 'a@b.com', description: 'Test',
      callbackUrl: 'https://store.com/ok',
      config: { secret_key: 'sk', webhook_secret: 'wh', sandbox: true },
    });

    const body = JSON.parse(capturedBody);
    expect(body.merchant_reference).toBe('my_cart_id');
  });
});

// ── getEmailProvider ──────────────────────────────────────────────────────────

describe('getEmailProvider()', () => {
  let db: ReturnType<typeof getDb>;

  beforeEach(async () => { db = await createTestDb(); });

  it('returns null when email not configured', async () => {
    const provider = await getEmailProvider(db);
    expect(provider).toBeNull();
  });

  it('returns provider when configured', async () => {
    await seedEmailConfig(db);
    const provider = await getEmailProvider(db);
    expect(provider).not.toBeNull();
    expect(typeof provider!.send).toBe('function');
  });
});
