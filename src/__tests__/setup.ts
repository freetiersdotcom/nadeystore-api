// =============================================================================
// src/__tests__/setup.ts
//
// Shared test infrastructure. Imported by vitest.config.ts as setupFiles.
// Provides:
//   - createTestDb()    fresh in-memory DO database per test
//   - seedDb()          seed helpers for common fixtures
//   - mockFetch()       intercept outbound fetch calls
//   - makeRequest()     build authenticated HTTP requests to SELF
//   - sign helpers      generate valid webhook signatures for tests
// =============================================================================

import { env, SELF } from 'cloudflare:test';
import { MerchantDO } from '../do';
import { getDb } from '../db';
import { uuid, now } from '../types';
import { hashKey, generateApiKey } from '../middleware/auth';
import { hashToken } from '../lib/downloads';

import {
  stripeCheckoutCompletedEvent,
  stripeSessionRetrieved,
  fedaPayRawWebhookEvent,
  fedaPayTransactionVerifyResponse,
  fedaPayCreateTransactionResponse,
  fedaPayTokenResponse,
  fedaPayTransactionListResponse,
} from './fixtures';

// ── Database factory ──────────────────────────────────────────────────────────
// Returns a fresh Database instance backed by an isolated DO for each test.
// Storage is automatically wiped between test files by the pool.

export async function createTestDb() {
  const id   = env.MERCHANT.newUniqueId();
  const stub = env.MERCHANT.get(id) as any;
  return getDb(stub);
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

export interface TestKeys {
  adminKey:  string;
  publicKey: string;
}

export async function seedApiKeys(db: ReturnType<typeof getDb>): Promise<TestKeys> {
  const adminKey  = generateApiKey('sk');
  const publicKey = generateApiKey('pk');

  await db.run(
    `INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES (?, ?, ?, 'admin')`,
    [uuid(), await hashKey(adminKey), adminKey.slice(0, 8)]
  );
  await db.run(
    `INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES (?, ?, ?, 'public')`,
    [uuid(), await hashKey(publicKey), publicKey.slice(0, 8)]
  );

  return { adminKey, publicKey };
}

export interface TestProduct {
  productId: string;
  variantId: string;
  sku:       string;
}

export async function seedProduct(
  db: ReturnType<typeof getDb>,
  opts: {
    product_type?: 'physical' | 'digital';
    price_cents?:  number;
    on_hand?:      number;
  } = {}
): Promise<TestProduct> {
  const productId = uuid();
  const variantId = uuid();
  const sku       = `SKU-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  await db.run(
    `INSERT INTO products (id, title, status) VALUES (?, 'Test Product', 'active')`,
    [productId]
  );
  await db.run(
    `INSERT INTO variants (id, product_id, sku, title, price_cents, weight_g, product_type)
     VALUES (?, ?, ?, 'Test Variant', ?, 0, ?)`,
    [variantId, productId, sku, opts.price_cents ?? 1000, opts.product_type ?? 'physical']
  );
  await db.run(
    `INSERT INTO inventory (id, sku, on_hand, reserved) VALUES (?, ?, ?, 0)`,
    [uuid(), sku, opts.on_hand ?? 10]
  );

  return { productId, variantId, sku };
}

export async function seedCart(
  db: ReturnType<typeof getDb>,
  items: Array<{ sku: string; qty: number; price_cents: number }>,
  opts: { email?: string; currency?: string } = {}
): Promise<string> {
  const cartId = uuid();
  const email  = opts.email ?? 'customer@test.com';
  const expiry = new Date(Date.now() + 3_600_000).toISOString();

  await db.run(
    `INSERT INTO carts (id, status, customer_email, currency, expires_at)
     VALUES (?, 'open', ?, ?, ?)`,
    [cartId, email, opts.currency ?? 'XOF', expiry]
  );

  for (const item of items) {
    const [variant] = await db.query<{ title: string }>(
      `SELECT title FROM variants WHERE sku = ? LIMIT 1`, [item.sku]
    );
    await db.run(
      `INSERT INTO cart_items (id, cart_id, sku, title, qty, unit_price_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), cartId, item.sku, variant?.title ?? item.sku, item.qty, item.price_cents]
    );
  }

  return cartId;
}

export async function seedStripeConfig(db: ReturnType<typeof getDb>) {
  const config = JSON.stringify({
    secret_key:     'sk_test_fake_key',
    webhook_secret: 'whsec_test_fake_secret',
  });
  await db.run(
    `INSERT INTO config (key, value, updated_at) VALUES ('stripe', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
    [config, now(), config, now()]
  );
}

export async function seedFedaPayConfig(db: ReturnType<typeof getDb>) {
  const config = JSON.stringify({
    secret_key:     'sk_sandbox_fake_key',
    webhook_secret: 'wh_sandbox_fake_secret',
    sandbox:        true,
  });
  await db.run(
    `INSERT INTO config (key, value, updated_at) VALUES ('fedapay', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
    [config, now(), config, now()]
  );
}

export async function seedEmailConfig(db: ReturnType<typeof getDb>) {
  const config = JSON.stringify({
    provider:     'resend',
    api_key:      'test_resend_key',
    from_address: 'Test Store <noreply@test.com>',
  });
  await db.run(
    `INSERT INTO config (key, value, updated_at) VALUES ('email', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
    [config, now(), config, now()]
  );
}

export async function seedDiscount(
  db: ReturnType<typeof getDb>,
  opts: {
    code?:          string;
    type?:          'percentage' | 'fixed_amount';
    value?:         number;
    usage_limit?:   number | null;
  } = {}
): Promise<string> {
  const discountId = uuid();
  await db.run(
    `INSERT INTO discounts
       (id, code, type, value, status, usage_count, usage_limit_per_customer)
     VALUES (?, ?, ?, ?, 'active', 0, 1)`,
    [
      discountId,
      opts.code  ?? `TEST${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      opts.type  ?? 'fixed_amount',
      opts.value ?? 200,
    ]
  );
  if (opts.usage_limit !== undefined && opts.usage_limit !== null) {
    await db.run(
      `UPDATE discounts SET usage_limit = ? WHERE id = ?`,
      [opts.usage_limit, discountId]
    );
  }
  return discountId;
}

// ── Mock fetch ────────────────────────────────────────────────────────────────
// Intercept outbound fetch() calls in tests.
// Returns a restore function — call in afterEach.

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function mockFetch(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (url: RequestInfo | URL, init?: RequestInit) => {
    return Promise.resolve(handler(url.toString(), init));
  };
  return () => { globalThis.fetch = original; };
}

// Common mock responses
export const MOCK_RESPONSES = {
  // Stripe
  stripeBalance: () =>
    new Response(JSON.stringify({ object: 'balance' }), { status: 200 }),

  stripeCheckoutSession: (cartId: string, opts = {}) =>
    new Response(JSON.stringify({
      id:         'cs_test_abc123',
      url:        'https://checkout.stripe.com/c/pay/cs_test_abc123',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }), { status: 200 }),

  // Returns full session shape matching what Merchant's webhook handler reads
  stripeSessionRetrieve: (cartId: string, opts: {
    amountTotal?: number;
    currency?:    string;
    withShipping?: boolean;
  } = {}) =>
    new Response(JSON.stringify(stripeSessionRetrieved({
      cartId,
      customerEmail: 'customer@test.com',
      sessionId:     'cs_test_abc123',
      ...opts,
    })), { status: 200 }),

  // FedaPay
  fedaPayTransactionList: () =>
    new Response(JSON.stringify(fedaPayTransactionListResponse()), { status: 200 }),

  fedaPayCreateTransaction: (txId = 16851) =>
    new Response(JSON.stringify(fedaPayCreateTransactionResponse(txId)), { status: 200 }),

  fedaPayToken: (txId = 16851) =>
    new Response(JSON.stringify(fedaPayTokenResponse(txId)), { status: 200 }),

  fedaPayVerify: (status = 'approved', txId = 16851) =>
    new Response(JSON.stringify(fedaPayTransactionVerifyResponse({ txId, status })), { status: 200 }),

  // Email providers
  resendSend: () =>
    new Response(JSON.stringify({ id: 'email_test_123' }), { status: 200 }),
  sendgridSend: () =>
    new Response('', { status: 202 }),
  mailgunSend: () =>
    new Response(JSON.stringify({ id: 'mg_test_123', message: 'Queued' }), { status: 200 }),
  postmarkSend: () =>
    new Response(JSON.stringify({ MessageID: 'pm_test_123', ErrorCode: 0 }), { status: 200 }),

  // Outbound webhook deliveries
  outboundWebhook: () =>
    new Response('OK', { status: 200 }),
};


// ── Request builder ───────────────────────────────────────────────────────────
// Build requests to the Worker (SELF) with auth headers baked in.

export function makeRequest(
  path:    string,
  method:  string,
  body?:   unknown,
  apiKey?: string
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

// ── Webhook signature helpers ─────────────────────────────────────────────────

export async function signStripeWebhook(
  payload:       string,
  webhookSecret: string
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signed    = `${timestamp}.${payload}`;
  const encoder   = new TextEncoder();
  const key       = await crypto.subtle.importKey(
    'raw', encoder.encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(signed));
  const sig = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${sig}`;
}

export async function signFedaPayWebhook(
  payload:       string,
  webhookSecret: string
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signed    = `${timestamp}.${payload}`;
  const encoder   = new TextEncoder();
  const key       = await crypto.subtle.importKey(
    'raw', encoder.encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(signed));
  const sig = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},s=${sig}`;
}

// ── Download token helper ─────────────────────────────────────────────────────

export async function seedDownloadToken(
  db: ReturnType<typeof getDb>,
  orderId: string,
  sku: string,
  opts: { expired?: boolean; maxDownloads?: number; downloadCount?: number } = {}
): Promise<string> {
  const plainToken = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const tokenHash  = await hashToken(plainToken);
  const expiresAt  = opts.expired
    ? new Date(Date.now() - 1000).toISOString()
    : new Date(Date.now() + 86_400_000 * 7).toISOString();

  await db.run(
    `INSERT INTO download_tokens
       (id, order_id, sku, token_hash, expires_at, max_downloads, download_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), orderId, sku, tokenHash, expiresAt,
     opts.maxDownloads ?? 5, opts.downloadCount ?? 0]
  );

  return plainToken;
}

// ── Global test config ────────────────────────────────────────────────────────

// Increase timeout for integration tests that exercise multiple DB operations
vi.setConfig({ testTimeout: 10_000 });
