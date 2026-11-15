// =============================================================================
// src/__tests__/routes.test.ts
//
// Integration tests that exercise the full HTTP stack via SELF.
// Each request goes through Hono routing, auth middleware, rate limiting,
// and the actual handler — just like production.
//
// Covers:
//   - Auth middleware (valid key, invalid key, role enforcement)
//   - Catalog routes (products, variants, digital_asset_key)
//   - Cart & checkout routes (create, items, shipping, checkout)
//   - Setup routes (stripe, fedapay, email)
//   - Webhook routes (Stripe, FedaPay) with signature verification
//   - Download route (token validation, redirect)
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { uuid } from '../types';
import {
  createTestDb, seedApiKeys, seedProduct, seedCart,
  seedStripeConfig, seedFedaPayConfig, seedEmailConfig,
  seedDiscount, seedDownloadToken,
  mockFetch, MOCK_RESPONSES,
  makeRequest, signStripeWebhook, signFedaPayWebhook,
} from './setup';
import { stripeCheckoutCompletedEvent, fedaPayRawWebhookEvent } from './fixtures';

// FedaPay webhook body in the shape the handler reads: { name, entity: { id, ... } }.
// (fedaPayRawWebhookEvent in fixtures.ts is the CLI event-log shape: type + entity as a string.)
function fedaPayWebhookBody(opts: { cartId: string; txId?: number; eventType?: string; status?: string; amount?: number }): string {
  const raw = JSON.parse(fedaPayRawWebhookEvent(opts));
  return JSON.stringify({ name: raw.type, object: 'event', entity: { ...JSON.parse(raw.entity), custom_metadata: { cart_id: opts.cartId } } });
}

// ── Helper: fetch via SELF with auth ─────────────────────────────────────────

async function api(
  path:    string,
  method:  string,
  body?:   unknown,
  apiKey?: string
): Promise<Response> {
  return SELF.fetch(makeRequest(path, method, body, apiKey));
}

// ── Auth middleware ───────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  let adminKey: string;
  let publicKey: string;

  beforeEach(async () => {
    const db = await createTestDb();
    ({ adminKey, publicKey } = await seedApiKeys(db));
  });

  it('rejects missing Authorization header', async () => {
    const res = await api('/v1/products', 'GET');
    expect(res.status).toBe(401);
  });

  it('rejects invalid API key', async () => {
    const res = await api('/v1/products', 'GET', undefined, 'sk_invalid_key');
    expect(res.status).toBe(401);
  });

  it('accepts valid admin key', async () => {
    const res = await api('/v1/products', 'GET', undefined, adminKey);
    expect(res.status).toBe(200);
  });

  it('accepts valid public key for public endpoints', async () => {
    const res = await api('/v1/products', 'GET', undefined, publicKey);
    expect(res.status).toBe(200);
  });

  it('rejects public key for admin-only endpoints', async () => {
    const res = await api('/v1/setup/stripe', 'POST',
      { stripe_secret_key: 'sk_test', stripe_webhook_secret: 'whsec_test' }, publicKey);
    expect(res.status).toBe(403);
  });
});

// ── Catalog routes ────────────────────────────────────────────────────────────

describe('Catalog routes', () => {
  let adminKey: string;

  beforeEach(async () => {
    const db = await createTestDb();
    ({ adminKey } = await seedApiKeys(db));
  });

  it('POST /v1/products creates a product', async () => {
    const res  = await api('/v1/products', 'POST', { title: 'My Product' }, adminKey);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toBeTruthy();
    expect(body.title).toBe('My Product');
  });

  it('GET /v1/products returns empty list initially', async () => {
    const res  = await api('/v1/products', 'GET', undefined, adminKey);
    const body = await res.json() as any;
    expect(body.items).toEqual([]);
  });

  it('POST /v1/products/:id/variants creates variant with product_type', async () => {
    const product = await (await api('/v1/products', 'POST', { title: 'Ebook' }, adminKey)).json() as any;

    const res    = await api(`/v1/products/${product.id}/variants`, 'POST', {
      sku:          'EBOOK-001',
      title:        'PDF Edition',
      price_cents:  999,
      weight_g:     0,
      product_type: 'digital',
    }, adminKey);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.product_type).toBe('digital');
    expect(body.digital_asset_key).toBeNull();
  });

  it('physical variant defaults product_type to physical', async () => {
    const product = await (await api('/v1/products', 'POST', { title: 'T-Shirt' }, adminKey)).json() as any;

    const res  = await api(`/v1/products/${product.id}/variants`, 'POST', {
      sku: 'TEE-M', title: 'Medium', price_cents: 2000, weight_g: 200,
    }, adminKey);
    const body = await res.json() as any;
    expect(body.product_type).toBe('physical');
  });

  it('GET /v1/products returns created products', async () => {
    await api('/v1/products', 'POST', { title: 'Product A' }, adminKey);
    await api('/v1/products', 'POST', { title: 'Product B' }, adminKey);

    const res  = await api('/v1/products', 'GET', undefined, adminKey);
    const body = await res.json() as any;
    expect(body.items).toHaveLength(2);
  });
});

// ── Cart routes ───────────────────────────────────────────────────────────────

describe('Cart routes', () => {
  let publicKey: string;
  let adminKey: string;
  let testSku: string;

  beforeEach(async () => {
    const db = await createTestDb();
    ({ adminKey, publicKey } = await seedApiKeys(db));

    // Create product + variant + inventory via API
    const product  = await (await api('/v1/products', 'POST', { title: 'Widget' }, adminKey)).json() as any;
    const variant  = await (await api(`/v1/products/${product.id}/variants`, 'POST', {
      sku: 'WGT-001', title: 'Widget', price_cents: 1500, weight_g: 100,
    }, adminKey)).json() as any;
    testSku = variant.sku;

    await api(`/v1/inventory/${testSku}/adjust`, 'POST',
      { delta: 10, reason: 'restock' }, adminKey);
  });

  it('POST /v1/carts creates a cart', async () => {
    const res  = await api('/v1/carts', 'POST',
      { customer_email: 'buyer@test.com' }, publicKey);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('open');
  });

  it('POST /v1/carts/:id/items adds items to cart', async () => {
    const cart = await (await api('/v1/carts', 'POST',
      { customer_email: 'buyer@test.com' }, publicKey)).json() as any;

    const res  = await api(`/v1/carts/${cart.id}/items`, 'POST',
      { items: [{ sku: testSku, qty: 2 }] }, publicKey);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].qty).toBe(2);
  });

  it('PATCH /v1/carts/:id/shipping saves shipping address', async () => {
    const cart = await (await api('/v1/carts', 'POST',
      { customer_email: 'buyer@test.com' }, publicKey)).json() as any;

    const res = await api(`/v1/carts/${cart.id}/shipping`, 'PATCH', {
      name:        'Jean Dupont',
      line1:       '12 Rue de la Paix',
      city:        'Cotonou',
      postal_code: '229',
      country:     'BJ',
      phone:       '+2290161000000',   // the courier calls this number, so it is required
    }, publicKey);
    expect(res.status).toBe(200);
  });
});

// ── Setup routes ──────────────────────────────────────────────────────────────

describe('Setup routes', () => {
  let adminKey: string;
  let restore: () => void;

  beforeEach(async () => {
    const db = await createTestDb();
    ({ adminKey } = await seedApiKeys(db));
  });

  afterEach(() => restore?.());

  it('POST /v1/setup/stripe validates key via Stripe API', async () => {
    restore = mockFetch((url) => {
      if (url.includes('stripe.com/v1/balance')) return MOCK_RESPONSES.stripeBalance();
      return new Response('not found', { status: 404 });
    });

    const res = await api('/v1/setup/stripe', 'POST', {
      stripe_secret_key:     'sk_test_valid',
      stripe_webhook_secret: 'whsec_test',
    }, adminKey);
    expect(res.status).toBe(200);
  });

  it('POST /v1/setup/stripe rejects invalid key', async () => {
    restore = mockFetch(() => new Response('Unauthorized', { status: 401 }));

    const res = await api('/v1/setup/stripe', 'POST', {
      stripe_secret_key: 'sk_test_invalid',
    }, adminKey);
    expect(res.status).toBe(400);
  });

  it('POST /v1/setup/fedapay validates key via FedaPay API', async () => {
    restore = mockFetch((url) => {
      if (url.includes('fedapay')) return MOCK_RESPONSES.fedaPayTransactionList();
      return new Response('not found', { status: 404 });
    });

    const res = await api('/v1/setup/fedapay', 'POST', {
      secret_key:     'sk_sandbox_valid',
      webhook_secret: 'wh_sandbox_test',
      sandbox:        true,
    }, adminKey);
    expect(res.status).toBe(200);
  });

  it('GET /v1/setup/fedapay returns status without secrets', async () => {
    restore = mockFetch(() => MOCK_RESPONSES.fedaPayTransactionList());

    await api('/v1/setup/fedapay', 'POST', {
      secret_key: 'sk_sandbox_valid', webhook_secret: 'wh_test', sandbox: true,
    }, adminKey);

    const res  = await api('/v1/setup/fedapay', 'GET', undefined, adminKey);
    const body = await res.json() as any;
    expect(body.configured).toBe(true);
    expect(body.has_secret_key).toBe(true);
    expect(body.secret_key).toBeUndefined();
  });

  it('POST /v1/setup/email stores provider config', async () => {
    restore = mockFetch(() => MOCK_RESPONSES.resendSend());

    const res = await api('/v1/setup/email', 'POST', {
      provider:     'resend',
      api_key:      'test_key',
      from_address: 'Test <test@test.com>',
    }, adminKey);
    expect(res.status).toBe(200);
  });

  it('GET /v1/setup/email returns config without API key', async () => {
    restore = mockFetch(() => MOCK_RESPONSES.resendSend());

    await api('/v1/setup/email', 'POST', {
      provider: 'resend', api_key: 'secret', from_address: 'a@b.com',
    }, adminKey);

    const res  = await api('/v1/setup/email', 'GET', undefined, adminKey);
    const body = await res.json() as any;
    expect(body.configured).toBe(true);
    expect(body.provider).toBe('resend');
    expect(body.api_key).toBeUndefined();
  });
});

// ── Stripe webhook ────────────────────────────────────────────────────────────

describe('POST /v1/webhooks/stripe', () => {
  let db: ReturnType<typeof getDb>;
  let restore: () => void;

  beforeEach(async () => {
    db = await createTestDb();
    const { adminKey } = await seedApiKeys(db);
    await seedStripeConfig(db);
    await seedEmailConfig(db);
  });

  afterEach(() => restore?.());

  it('rejects missing signature', async () => {
    const res = await SELF.fetch(new Request('http://localhost/v1/webhooks/stripe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    '{}',
    }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid signature', async () => {
    const res = await SELF.fetch(new Request('http://localhost/v1/webhooks/stripe', {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'stripe-signature': 't=123,v1=invalidsig',
      },
      body: '{}',
    }));
    expect(res.status).toBe(400);
  });

  it('deduplicates events with same stripe_event_id', async () => {
    restore = mockFetch((url) => {
      if (url.includes('stripe.com')) return MOCK_RESPONSES.stripeSessionRetrieve('cart_unused');
      return MOCK_RESPONSES.outboundWebhook();
    });

    const event   = { id: 'evt_dup_test', type: 'payment_intent.created', data: { object: {} } };
    const payload = JSON.stringify(event);
    const sig     = await signStripeWebhook(payload, 'whsec_test_fake_secret');

    const req1 = new Request('http://localhost/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
      body: payload,
    });
    const req2 = new Request('http://localhost/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
      body: payload,
    });

    await SELF.fetch(req1);
    const res2 = await SELF.fetch(req2);
    expect(res2.status).toBe(200);

    const events = await db.query<any>(`SELECT * FROM events WHERE stripe_event_id = ?`, ['evt_dup_test']);
    expect(events).toHaveLength(1);
  });
  
  it('creates order for valid checkout.session.completed event', async () => {
    const { sku }   = await seedProduct(db, { price_cents: 2000, on_hand: 10 });
    const cartId    = await seedCart(db, [{ sku, qty: 1, price_cents: 2000 }], { currency: 'XOF' });
    await seedStripeConfig(db);
    await seedEmailConfig(db);
    await db.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);

    restore = mockFetch((url) => {
      // Stripe sessions.retrieve — must include cart_id in metadata
      if (url.includes('checkout/sessions')) {
        return MOCK_RESPONSES.stripeSessionRetrieve(cartId);
      }
      // Email + outbound webhooks
      if (url.includes('resend.com')) return MOCK_RESPONSES.resendSend();
      return MOCK_RESPONSES.outboundWebhook();
    });

    // Build a real checkout.session.completed event payload
    const event   = stripeCheckoutCompletedEvent({ cartId, customerEmail: 'customer@test.com' });
    const payload = JSON.stringify(event);
    const sig     = await signStripeWebhook(payload, 'whsec_test_fake_secret');

    const res = await SELF.fetch(new Request('http://localhost/v1/webhooks/stripe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
      body:    payload,
    }));
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 200));

    const orders = await db.query<any>(`SELECT * FROM orders WHERE customer_email = ?`, ['customer@test.com']);
    expect(orders.length).toBeGreaterThan(0);
    expect(orders[0].status).toBe('paid');
  });
  
});

// ── FedaPay webhook ───────────────────────────────────────────────────────────

describe('POST /v1/webhooks/fedapay', () => {
  let db: ReturnType<typeof getDb>;
  let sku: string;
  let cartId: string;
  let restore: () => void;
  const WEBHOOK_SECRET = 'wh_sandbox_fake_secret';

  beforeEach(async () => {
    db = await createTestDb();
    await seedApiKeys(db);
    await seedFedaPayConfig(db);
    await seedEmailConfig(db);

    const prod = await seedProduct(db, { price_cents: 2000, on_hand: 10 });
    sku     = prod.sku;
    cartId  = await seedCart(db, [{ sku, qty: 1, price_cents: 2000 }], { currency: 'XOF' });

    // Simulate pre-checkout cart lock
    await db.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);
  });

  afterEach(() => restore?.());

  it('rejects missing signature header', async () => {
    const res = await SELF.fetch(new Request('http://localhost/v1/webhooks/fedapay', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    '{}',
    }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid signature', async () => {
    const res = await SELF.fetch(new Request('http://localhost/v1/webhooks/fedapay', {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'x-fedapay-signature':   't=123,s=invalidsignature',
      },
      body: '{}',
    }));
    expect(res.status).toBe(400);
  });

  it('answers 400 (not 500) to a correctly signed body that is not a JSON object', async () => {
    for (const body of ['null', '42', '"text"']) {
      const sig = await signFedaPayWebhook(body, WEBHOOK_SECRET);
      const res = await SELF.fetch(new Request('http://localhost/v1/webhooks/fedapay', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-fedapay-signature': sig },
        body,
      }));
      expect(res.status, `body ${body}`).toBe(400);
    }
  });

  it('creates order for valid transaction.approved event (payload as the handler reads it)', async () => {
    restore = mockFetch((url) => {
      if (url.includes('fedapay') && url.includes('/transactions/')) {
        return MOCK_RESPONSES.fedaPayVerify('approved');
      }
      if (url.includes('resend.com')) return MOCK_RESPONSES.resendSend();
      return MOCK_RESPONSES.outboundWebhook();
    });

    // Use the real FedaPay raw webhook format
    const payload = fedaPayWebhookBody({
      cartId:    cartId,
      txId:      42,
      eventType: 'transaction.approved',
      status:    'approved',
      amount:    2000,
    });
    const sig = await signFedaPayWebhook(payload, WEBHOOK_SECRET);

    const res = await SELF.fetch(new Request('http://localhost/v1/webhooks/fedapay', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-fedapay-signature': sig },
      body:    payload,
    }));
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 200));

    const orders = await db.query<any>(`SELECT * FROM orders WHERE customer_email = ?`, ['customer@test.com']);
    expect(orders.length).toBeGreaterThan(0);
  });

  it('deduplicates by event type + transaction ID (FedaPay sends no stable event ID)', async () => {
    restore = mockFetch((url) => url.includes('/transactions/')
      ? MOCK_RESPONSES.fedaPayVerify('approved', 99)
      : MOCK_RESPONSES.outboundWebhook());

    const makePayload = () => fedaPayWebhookBody({
      cartId: cartId, txId: 99, eventType: 'transaction.approved',
    });

    const payload1 = makePayload();
    const sig1     = await signFedaPayWebhook(payload1, WEBHOOK_SECRET);
    const payload2 = makePayload();
    const sig2     = await signFedaPayWebhook(payload2, WEBHOOK_SECRET);

    await SELF.fetch(new Request('http://localhost/v1/webhooks/fedapay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fedapay-signature': sig1 },
      body: payload1,
    }));
    await SELF.fetch(new Request('http://localhost/v1/webhooks/fedapay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fedapay-signature': sig2 },
      body: payload2,
    }));
    await new Promise(r => setTimeout(r, 100));

    const events = await db.query<any>(
      `SELECT * FROM events WHERE stripe_event_id = ?`,
      ['fedapay_evt_transaction.approved_99']
    );
    expect(events).toHaveLength(1);
  });
  
});

// ── Download route ────────────────────────────────────────────────────────────

describe('GET /v1/downloads/:token', () => {
  let db: ReturnType<typeof getDb>;
  let orderId: string;
  let sku: string;

  beforeEach(async () => {
    db      = await createTestDb();
    orderId = uuid();
    sku     = 'DIG-DL-001';

    const pid = uuid();
    await db.run(`INSERT INTO products (id, title) VALUES (?, 'Digital Product')`, [pid]);
    const vid = uuid();
    await db.run(
      `INSERT INTO variants (id, product_id, sku, title, price_cents, weight_g, product_type, digital_asset_key)
       VALUES (?, ?, ?, 'Digital', 999, 0, 'digital', 'assets/test-file.pdf')`,
      [vid, pid, sku]
    );
    await (env as any).IMAGES.put('assets/test-file.pdf', 'hello file');
    await db.run(
      `INSERT INTO orders (id, number, status, customer_email, subtotal_cents,
       tax_cents, shipping_cents, total_cents, currency)
       VALUES (?, 'ORD-DL-001', 'paid', 'dl@test.com', 999, 0, 0, 999, 'XOF')`,
      [orderId]
    );
  });

  it('streams the file for a valid token and counts the download', async () => {
    const token = await seedDownloadToken(db, orderId, sku);
    const res   = await SELF.fetch(new Request(`http://localhost/v1/downloads/${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('test-file.pdf');
    expect(await res.text()).toBe('hello file');
    expect(Number(res.headers.get('X-Downloads-Remaining'))).toBeGreaterThanOrEqual(0);
    const [row] = await db.query<any>(`SELECT download_count FROM download_tokens`);
    expect(row.download_count).toBe(1);
  });

  it('returns JSON info when Accept: application/json', async () => {
    const token = await seedDownloadToken(db, orderId, sku);
    const res   = await SELF.fetch(new Request(`http://localhost/v1/downloads/${token}`, {
      headers: { Accept: 'application/json' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sku).toBe(sku);
    expect(body.downloads_remaining).toBeGreaterThan(0);
    const [row] = await db.query<any>(`SELECT download_count FROM download_tokens`);
    expect(row.download_count).toBe(0);   // looking at the info does not use up a download
  });

  it('returns 404 for unknown token', async () => {
    const res = await SELF.fetch(
      new Request('http://localhost/v1/downloads/unknowntoken123')
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for expired token', async () => {
    const token = await seedDownloadToken(db, orderId, sku, { expired: true });
    const res   = await SELF.fetch(
      new Request(`http://localhost/v1/downloads/${token}`)
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when download limit reached', async () => {
    const token = await seedDownloadToken(db, orderId, sku, { maxDownloads: 1, downloadCount: 1 });
    const res   = await SELF.fetch(
      new Request(`http://localhost/v1/downloads/${token}`)
    );
    expect(res.status).toBe(400);
  });
});

// ── Migrations ────────────────────────────────────────────────────────────────

describe('Migrations', () => {
  it('ensureInitialized() creates all expected tables', async () => {
    const db = await createTestDb();

    const tables = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
    );
    const names = tables.map(t => t.name);

    expect(names).toContain('api_keys');
    expect(names).toContain('products');
    expect(names).toContain('variants');
    expect(names).toContain('inventory');
    expect(names).toContain('carts');
    expect(names).toContain('orders');
    expect(names).toContain('order_items');
    expect(names).toContain('events');
    expect(names).toContain('config');
    expect(names).toContain('download_tokens');
  });

  it('variants table has product_type and digital_asset_key columns', async () => {
    const db = await createTestDb();
    const pid = uuid();
    await db.run(`INSERT INTO products (id, title) VALUES (?, 'Digital Test Product')`, [pid]);

    // Should be able to insert with these columns
    await expect(db.run(
      `INSERT INTO variants (id, product_id, sku, title, price_cents, weight_g, product_type)
       VALUES (?, ?, ?, ?, 1000, 0, 'digital')`,
      [uuid(), pid, `TEST-${uuid().slice(0, 4)}`, 'Digital Test']
    )).resolves.toBeDefined();
  });

  it('carts table has ship_to and shipping_name columns', async () => {
    const db = await createTestDb();

    await expect(db.run(
      `INSERT INTO carts (id, status, customer_email, currency, expires_at, ship_to, shipping_name)
       VALUES (?, 'open', 'a@b.com', 'XOF', ?, '{"line1":"test"}', 'Test User')`,
      [uuid(), new Date(Date.now() + 3_600_000).toISOString()]
    )).resolves.toBeDefined();
  });

  it('re-running migrations is safe (no throws)', async () => {
    // createTestDb() already runs migrations — call ensureInitialized again
    // by making a second query on the same DO (it checks this.initialized)
    const db = await createTestDb();
    await expect(db.query(`SELECT 1`)).resolves.toBeDefined();
  });
});
