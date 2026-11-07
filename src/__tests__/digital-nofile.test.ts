// =============================================================================
// A digital product with no file (a WiFi voucher) gets no download token; one with a file still does.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { mockFetch, MOCK_RESPONSES, seedApiKeys, seedProduct, seedCart, seedEmailConfig } from './setup';
import { createOrderFromCart } from '../lib/orders';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let sent: any[] = []; let adminKey = ''; let ip = 0; let restore: () => void = () => {}; let voucher = ''; let ebook = '';
const call = (path: string, json: unknown) => SELF.fetch(`http://localhost${path}`, {
  method: 'POST', body: JSON.stringify(json),
  headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.113.${(++ip % 250) + 1}` },
});

beforeEach(async () => {
  const d = db();
  for (const t of ['download_tokens', 'refunds', 'order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'customer_addresses', 'customers', 'inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) { try { await d.run(`DELETE FROM ${t}`); } catch { /* absent */ } }
  adminKey = (await seedApiKeys(d)).adminKey;
  voucher = (await seedProduct(d, { price_cents: 300, on_hand: 0 })).sku; ebook = (await seedProduct(d, { price_cents: 5000, on_hand: 0 })).sku;
  await d.run(`UPDATE variants SET product_type = 'digital' WHERE sku IN (?, ?)`, [voucher, ebook]);
  await d.run(`UPDATE variants SET digital_asset_key = 'assets/x/book.pdf' WHERE sku = ?`, [ebook]);
  sent = [];
  restore = mockFetch((url, init) => { if (url.includes('resend.com')) { sent.push(JSON.parse(String(init?.body))); return MOCK_RESPONSES.resendSend(); } return new Response('{}', { status: 200 }); });
});
afterEach(() => restore());

const fakeCtx = { waitUntil: (p: Promise<any>) => p, passThroughOnException: () => {} } as ExecutionContext;
const orderCtx = { provider: 'test', providerRef: 'ref_1', storeBaseUrl: 'https://teststore.com', storeName: 'Test Store' };
async function checkout(items: { sku: string; qty: number; price_cents: number }[]) {
  const stub = env.MERCHANT.get(env.MERCHANT.idFromName('default')); const d = getDb(stub as any);
  await seedEmailConfig(d);
  const cartId = await seedCart(d, items, { currency: 'XOF', email: 'buyer@example.com' });
  await d.run(`UPDATE carts SET status = 'checked_out' WHERE id = ?`, [cartId]);
  return createOrderFromCart(d, stub as any, fakeCtx, cartId, orderCtx);
}

describe('digital items without a file', () => {
  it('only the product that has a file gets a download token, and the e-mail links only to that one', async () => {
    const r = await checkout([{ sku: voucher, qty: 1, price_cents: 300 }, { sku: ebook, qty: 1, price_cents: 5000 }]);
    expect(r).not.toBeNull();
    expect((await db().query<{ sku: string }>(`SELECT sku FROM download_tokens`)).map((x) => x.sku)).toEqual([ebook]);
    const mail = sent.find((m) => /order|commande/i.test(m.subject ?? '')) ?? sent[0];
    expect((String(mail?.html ?? '').match(/telechargements|downloads\//g) ?? []).length).toBeGreaterThan(0);
    expect((String(mail?.html ?? '').match(/\/(fr\/telechargements|en\/downloads)\//g) ?? []).length).toBe(1);
  });
  it('a voucher-only order has no token and no download link', async () => {
    const r = await checkout([{ sku: voucher, qty: 2, price_cents: 300 }]);
    expect(r).not.toBeNull();
    expect(await db().query(`SELECT 1 FROM download_tokens`)).toHaveLength(0);
    expect(sent.map((m) => String(m.html ?? '')).join('')).not.toMatch(/telechargements|\/downloads\//);
  });
});

describe('counter sales (manual orders)', () => {
  const manual = (sku: string, amount: number) => call('/v1/orders/manual', { items: [{ sku, qty: 1 }], payment: { amount_cents: amount, method: 'cash' } });
  it('accept a digital product with no file (a voucher) and still refuse one with a file', async () => {
    expect((await manual(voucher, 300)).status).toBe(200);
    const r = await manual(ebook, 5000); expect(r.status).toBe(400); expect(await r.text()).toMatch(/digital products cannot/);
  });
});
