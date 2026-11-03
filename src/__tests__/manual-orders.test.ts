// =============================================================================
// Manual (counter / phone) orders: walk-in sales without an email, and delivery lines.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { mockFetch, MOCK_RESPONSES, seedApiKeys, seedEmailConfig, seedProduct } from './setup';
import { getEmailProvider } from '../lib/email/index';
import { WALK_IN_EMAIL } from '../lib/walk-in';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let sku = ''; let sent: any[] = []; let restore: () => void;
let ip = 0;
async function api(path: string, method = 'GET', body?: unknown) {
  const res = await SELF.fetch(`http://localhost${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminKey}`, 'CF-Connecting-IP': `198.51.100.${(++ip % 250) + 1}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json };
}
const COTONOU = { line1: '12 rue des Palmiers', city: 'Cotonou', country: 'BJ', phone: '+22961000000' };

beforeEach(async () => {
  const d = db();
  for (const t of ['order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'customer_addresses', 'customers', 'inventory', 'variants', 'products', 'api_keys', 'shipping_rates', 'shipping_zones']) await d.run(`DELETE FROM ${t}`);
  await d.run(`DELETE FROM config WHERE key IN ('email', 'shipping')`);
  adminKey = (await seedApiKeys(d)).adminKey;
  sku = (await seedProduct(d, { price_cents: 450000, on_hand: 20 })).sku;
  await d.run(`UPDATE variants SET weight_g = 300 WHERE sku = ?`, [sku]);
  await seedEmailConfig(d);
  sent = [];
  restore = mockFetch((url, init) => {
    if (url.includes('api.resend.com')) { sent.push(JSON.parse(String(init?.body))); return MOCK_RESPONSES.resendSend(); }
    return new Response('{}', { status: 200 });
  });
});
afterEach(async () => { await new Promise((r) => setTimeout(r, 100)); restore(); });

const rows = <T = any>(q: string, a: unknown[] = []) => db().query<T>(q, a);

describe('walk-in sales (no email)', () => {
  it('records the order on one shared walk-in customer and sends nothing', async () => {
    const a = await api('/v1/orders/manual', 'POST', { items: [{ sku, qty: 1 }], payment: { amount_cents: 450000, method: 'cash' } });
    expect(a.status).toBe(200);
    const b = await api('/v1/orders/manual', 'POST', { items: [{ sku, qty: 2 }], customer_name: 'Mme Kossi', address: COTONOU });
    expect(b.status).toBe(200);
    const cust = await rows(`SELECT * FROM customers`);
    expect(cust).toHaveLength(1);
    expect(cust[0]).toMatchObject({ email: WALK_IN_EMAIL, order_count: 2 });
    expect((await rows(`SELECT * FROM customer_addresses`))).toHaveLength(0); // no pile of strangers' addresses on one record
    const o = await rows(`SELECT customer_email, shipping_name, ship_to FROM orders WHERE number = ?`, [b.json.order_number]);
    expect(o[0].customer_email).toBe(WALK_IN_EMAIL);
    expect(o[0].shipping_name).toBe('Mme Kossi');           // the delivery details stay on the order itself
    expect(JSON.parse(o[0].ship_to).city).toBe('Cotonou');
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(0);
  });

  it('blank email counts as no email; a real email still works as before (and keeps the address)', async () => {
    expect((await api('/v1/orders/manual', 'POST', { customer_email: '  ', items: [{ sku, qty: 1 }] })).status).toBe(400); // not a valid email
    const ok = await api('/v1/orders/manual', 'POST', { customer_email: 'ama@shop.test', items: [{ sku, qty: 1 }], address: COTONOU });
    expect(ok.status).toBe(200);
    expect((await rows(`SELECT email FROM customers`)).map((c: any) => c.email)).toEqual(['ama@shop.test']);
    expect(await rows(`SELECT * FROM customer_addresses`)).toHaveLength(1);
  });

  it('the order list marks it as a walk-in, and the shared customer cannot be edited', async () => {
    const a = await api('/v1/orders/manual', 'POST', { items: [{ sku, qty: 1 }] });
    const list = await api('/v1/orders');
    const o = list.json.items.find((x: any) => x.number === a.json.order_number);
    expect(o.walk_in).toBe(true);
    const [c] = await rows(`SELECT id FROM customers`);
    const detail = await api(`/v1/customers/${c.id}`);
    expect(detail.json.walk_in).toBe(true);
    expect((await api(`/v1/customers/${c.id}`, 'PATCH', { name: 'X' })).status).toBe(409);
  });

  it('nothing is ever mailed to an undeliverable address, whatever the code path', async () => {
    const provider = (await getEmailProvider(db()))!;
    await provider.send({ to: WALK_IN_EMAIL, subject: 's', html: 'h' });
    await provider.send({ to: 'erased+abc@erased.invalid', subject: 's', html: 'h' });
    expect(sent).toHaveLength(0);
    await provider.send({ to: 'real@shop.test', subject: 's', html: 'h' });
    expect(sent).toHaveLength(1);
  });
});

describe('delivery line on manual orders', () => {
  it('has no delivery line unless one is asked for (counter sales are unchanged)', async () => {
    const r = await api('/v1/orders/manual', 'POST', { customer_email: 'a@shop.test', items: [{ sku, qty: 1 }] });
    expect(r.json.total_cents).toBe(450000);
    const [o] = await rows(`SELECT shipping_cents, shipping_label FROM orders WHERE number = ?`, [r.json.order_number]);
    expect(o).toMatchObject({ shipping_cents: 0, shipping_label: null });
  });

  it('a custom delivery price is added to the total, named on the order, and counts for the payment limit', async () => {
    const body = { customer_email: 'a@shop.test', items: [{ sku, qty: 1 }], address: COTONOU, shipping: { custom_cents: 150000, label: 'Coursier (convenu)' } };
    const r = await api('/v1/orders/manual', 'POST', { ...body, payment: { amount_cents: 600000, method: 'cash' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ total_cents: 600000, paid_cents: 600000, payment_status: 'paid' });
    const [o] = await rows(`SELECT shipping_cents, shipping_label, total_cents FROM orders WHERE number = ?`, [r.json.order_number]);
    expect(o).toMatchObject({ shipping_cents: 150000, shipping_label: 'Coursier (convenu)', total_cents: 600000 });
    expect((await api('/v1/orders/manual', 'POST', { ...body, payment: { amount_cents: 600001, method: 'cash' } })).status).toBe(400);
    const got = await api(`/v1/orders/${r.json.order_id}`);
    expect(got.json.delivery_option).toBe('Coursier (convenu)');
    expect(got.json.amounts.shipping_cents).toBe(150000);
  });

  describe('with a stored delivery option', () => {
    beforeEach(async () => {
      await api('/v1/shipping/starter', 'POST');
    });
    const quote = (country = 'BJ', city = 'Cotonou') => api('/v1/orders/manual/quote', 'POST', { items: [{ sku, qty: 2 }], address: { country, city } });

    it('offers the same options customers would see, even while delivery is off for the storefront', async () => {
      const q = await quote();
      expect(q.status).toBe(200);
      expect(q.json.deliverable).toBe(true);
      expect(q.json.options.map((o: any) => o.kind).sort()).toEqual(['pickup', 'weight']);
    });

    it('prices the chosen option (courier) and freezes its name in the order language', async () => {
      const q = await quote();
      const courier = q.json.options.find((o: any) => o.kind === 'weight');
      const r = await api('/v1/orders/manual', 'POST', { customer_email: 'a@shop.test', items: [{ sku, qty: 2 }], address: COTONOU, locale: 'en', shipping: { rate_id: courier.id } });
      expect(r.status).toBe(200);
      expect(r.json.total_cents).toBe(900000 + courier.cents);
      const [o] = await rows(`SELECT shipping_cents, shipping_label FROM orders WHERE number = ?`, [r.json.order_number]);
      expect(o).toMatchObject({ shipping_cents: courier.cents, shipping_label: 'Courier delivery' });
    });

    it('pickup costs nothing and is named', async () => {
      const pickup = (await quote()).json.options.find((o: any) => o.kind === 'pickup');
      const r = await api('/v1/orders/manual', 'POST', { customer_email: 'a@shop.test', items: [{ sku, qty: 1 }], address: COTONOU, shipping: { rate_id: pickup.id } });
      expect(r.json.total_cents).toBe(450000);
      const [o] = await rows(`SELECT shipping_label FROM orders WHERE number = ?`, [r.json.order_number]);
      expect(o.shipping_label).toBe('Retrait en boutique');
    });

    it('refuses an option that does not fit: no address, unknown, another zone, both kinds at once', async () => {
      const courier = (await quote()).json.options.find((o: any) => o.kind === 'weight');
      const base = { customer_email: 'a@shop.test', items: [{ sku, qty: 1 }] };
      expect((await api('/v1/orders/manual', 'POST', { ...base, shipping: { rate_id: courier.id } })).status).toBe(400);
      expect((await api('/v1/orders/manual', 'POST', { ...base, address: COTONOU, shipping: { rate_id: 'nope' } })).status).toBe(400);
      const paris = { line1: '1 rue X', city: 'Paris', country: 'FR', postal_code: '75001' };
      expect((await api('/v1/orders/manual', 'POST', { ...base, address: paris, shipping: { rate_id: courier.id } })).status).toBe(400);
      expect((await api('/v1/orders/manual', 'POST', { ...base, address: COTONOU, shipping: { rate_id: courier.id, custom_cents: 5 } })).status).toBe(400);
      expect(await rows(`SELECT * FROM orders`)).toHaveLength(0);                 // nothing half-created
      expect((await rows(`SELECT reserved FROM inventory WHERE sku = ?`, [sku]))[0].reserved).toBe(0);
    });
  });

  it('delivery routes need an admin key', async () => {
    const res = await SELF.fetch('http://localhost/v1/orders/manual/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});
