// =============================================================================
// Stripe checkout: delivery as its own line, and a fixed-amount coupon when a code is used.
// Stripe itself is mocked; what is checked is exactly what we send it.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { stripeCheckoutCompletedEvent } from './fixtures';
import { MOCK_RESPONSES, mockFetch, signStripeWebhook, seedApiKeys, seedCart, seedDiscount, seedProduct, seedStripeConfig } from './setup';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let publicKey = ''; let sku = ''; let restore: () => void;
let retrieveCart = '';
let stripeCalls: Array<{ path: string; form: URLSearchParams }> = [];
let ip = 0;

async function call(path: string, method: string, key: string, body?: unknown) {
  const res = await SELF.fetch(`http://localhost${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'CF-Connecting-IP': `203.0.113.${(++ip % 250) + 1}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json };
}

beforeEach(async () => {
  const d = db();
  for (const t of ['order_payments', 'order_items', 'discount_usage', 'orders', 'customer_addresses', 'customers', 'cart_items', 'carts', 'inventory', 'variants', 'products', 'api_keys', 'shipping_rates', 'shipping_zones', 'discounts', 'discount_usage']) await d.run(`DELETE FROM ${t}`);
  await d.run(`DELETE FROM config WHERE key IN ('stripe', 'shipping')`);
  const keys = await seedApiKeys(d); adminKey = keys.adminKey; publicKey = keys.publicKey;
  await seedStripeConfig(d);
  sku = (await seedProduct(d, { price_cents: 4500, on_hand: 50 })).sku;
  await d.run(`UPDATE variants SET weight_g = 300 WHERE sku = ?`, [sku]);
  stripeCalls = [];
  let n = 0;
  restore = mockFetch((url, init) => {
    if (url.includes('api.stripe.com')) {
      const path = new URL(url).pathname;
      stripeCalls.push({ path, form: new URLSearchParams(String(init?.body ?? '')) });
      if (path === '/v1/coupons') return new Response(JSON.stringify({ id: `coupon_${++n}`, object: 'coupon' }), { status: 200 });
      if (init?.method === 'GET' || !init?.method) { if (path.startsWith('/v1/checkout/sessions/')) return MOCK_RESPONSES.stripeSessionRetrieve(retrieveCart); }
      if (path === '/v1/checkout/sessions') return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
});
afterEach(() => restore());

async function shippingOn() {
  await call('/v1/shipping/settings', 'PUT', adminKey, { enabled: true });
  await call('/v1/shipping/starter', 'POST', adminKey);
}
/** A cart for Cotonou: 2 x EUR 45.00 (9 000 cents), optionally with a discount. Stripe has no XOF: diaspora buyers pay in EUR, delivery is priced in XOF and converted. */
async function cartFor(opts: { discountId?: string; locale?: 'fr' | 'en'; city?: string } = {}) {
  const cartId = await seedCart(db(), [{ sku, qty: 2, price_cents: 4500 }], { currency: 'EUR' });
  await db().run(`UPDATE carts SET ship_to = ?, shipping_name = 'Ama', locale = ?, discount_id = ? WHERE id = ?`,
    [JSON.stringify({ line1: '12 rue', city: opts.city ?? 'Cotonou', country: 'BJ', postal_code: '', phone: '+22961000000' }), opts.locale ?? 'fr', opts.discountId ?? null, cartId]);
  return cartId;
}
const checkout = (cartId: string, extra: object = {}) =>
  call(`/v1/carts/${cartId}/checkout`, 'POST', publicKey, { success_url: 'https://store.test/ok', cancel_url: 'https://store.test/no', ...extra });
const sessionForm = () => stripeCalls.find((c) => c.path === '/v1/checkout/sessions')!.form;
const couponForm = () => stripeCalls.find((c) => c.path === '/v1/coupons')?.form;
const lines = (f: URLSearchParams) => {
  const out: Array<{ name: string; amount: number; qty: number; currency: string }> = [];
  for (let i = 0; f.has(`line_items[${i}][quantity]`); i++) {
    out.push({ name: f.get(`line_items[${i}][price_data][product_data][name]`)!, amount: Number(f.get(`line_items[${i}][price_data][unit_amount]`)),
      qty: Number(f.get(`line_items[${i}][quantity]`)), currency: f.get(`line_items[${i}][price_data][currency]`)! });
  }
  return out;
};
const sum = (ls: ReturnType<typeof lines>) => ls.reduce((s, l) => s + l.amount * l.qty, 0);

describe('Stripe checkout with delivery', () => {
  it('Stripe cannot take XOF: such a cart is refused before anything is sent', async () => {
    await shippingOn();
    const cartId = await seedCart(db(), [{ sku, qty: 1, price_cents: 450000 }], { currency: 'XOF' });
    const r = await checkout(cartId);
    expect(r.status).toBe(400);
    expect(stripeCalls).toHaveLength(0);
  });

  it('sends delivery as a separate line named like the option, in the cart currency', async () => {
    await shippingOn();
    const r = await checkout(await cartFor());
    expect(r.status).toBe(200);
    expect(r.json.checkout_url).toContain('checkout.stripe.com');
    const ls = lines(sessionForm());
    expect(ls).toHaveLength(2);
    expect(ls[0]).toMatchObject({ amount: 4500, qty: 2, currency: 'eur' });
    expect(ls[1]).toMatchObject({ name: 'Livraison par coursier', amount: 152, qty: 1, currency: 'eur' }); // 1 000 XOF at 655.957
    expect(sessionForm().has('discounts[0][coupon]')).toBe(false);
  });

  it('uses the English option name for an English cart', async () => {
    await shippingOn();
    await checkout(await cartFor({ locale: 'en' }));
    expect(lines(sessionForm())[1].name).toBe('Courier delivery');
  });

  it('no delivery line when delivery is off, and none for pickup (nothing to charge)', async () => {
    await checkout(await cartFor());
    expect(lines(sessionForm())).toHaveLength(1);
    stripeCalls = [];
    await shippingOn();
    const cartId = await cartFor();
    const [pickup] = await db().query<any>(`SELECT id FROM shipping_rates WHERE kind = 'pickup' LIMIT 1`);
    await db().run(`UPDATE carts SET shipping_rate_id = ? WHERE id = ?`, [pickup.id, cartId]);
    await checkout(cartId);
    expect(lines(sessionForm())).toHaveLength(1);
  });

  it('a fixed-amount code becomes an exact coupon, and lines minus coupon equal what the order will total', async () => {
    await shippingOn();
    const code = await seedDiscount(db(), { type: 'fixed_amount', value: 500 });
    const cartId = await cartFor({ discountId: code });
    expect((await checkout(cartId)).status).toBe(200);
    const c = couponForm()!;
    expect(c.get('amount_off')).toBe('500'); expect(c.get('currency')).toBe('eur'); expect(c.get('duration')).toBe('once');
    expect(c.has('percent_off')).toBe(false);
    expect(sessionForm().get('discounts[0][coupon]')).toBe('coupon_1');
    const [cart] = await db().query<any>(`SELECT shipping_cents, discount_amount_cents FROM carts WHERE id = ?`, [cartId]);
    expect(sum(lines(sessionForm())) - Number(c.get('amount_off'))).toBe(9000 + cart.shipping_cents - cart.discount_amount_cents);
    expect(cart).toMatchObject({ shipping_cents: 152, discount_amount_cents: 500 });
  });

  it('a percentage code is sent as an exact amount of the GOODS only, so delivery is not discounted', async () => {
    await shippingOn();
    const code = await seedDiscount(db(), { type: 'percentage', value: 10 });
    await checkout(await cartFor({ discountId: code }));
    const c = couponForm()!;
    expect(c.get('amount_off')).toBe('900');           // 10% of the 9 000 goods, not of 9 152
    expect(c.has('percent_off')).toBe(false);
  });

  it('without delivery, a percentage code stays a percentage coupon', async () => {
    const code = await seedDiscount(db(), { type: 'percentage', value: 10 });
    await checkout(await cartFor({ discountId: code }));
    expect(couponForm()!.get('percent_off')).toBe('10');
    expect(couponForm()!.has('amount_off')).toBe(false);
  });

  it('does not offer a free "Standard Shipping" choice next to a priced delivery line', async () => {
    await shippingOn();
    await checkout(await cartFor(), { collect_shipping: true, shipping_countries: ['BJ'] });
    expect(sessionForm().has('shipping_options[0][shipping_rate_data][display_name]')).toBe(false);
    expect(sessionForm().get('shipping_address_collection[allowed_countries][0]')).toBe('BJ');
  });

  it('keeps the legacy default option when there is no delivery line at all', async () => {
    await checkout(await cartFor(), { collect_shipping: true, shipping_countries: ['BJ'] });
    expect(sessionForm().get('shipping_options[0][shipping_rate_data][display_name]')).toBe('Standard Shipping');
  });

  it('once paid, the order keeps the delivery amount and option name, and totals goods - code + delivery', async () => {
    await shippingOn();
    const code = await seedDiscount(db(), { type: 'fixed_amount', value: 500 });
    const cartId = await cartFor({ discountId: code });
    await checkout(cartId);
    retrieveCart = cartId;
    const payload = JSON.stringify(stripeCheckoutCompletedEvent({ cartId, customerEmail: 'customer@test.com', currency: 'eur', amountTotal: 8652 }));
    const res = await SELF.fetch(new Request('http://localhost/v1/webhooks/stripe', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': await signStripeWebhook(payload, 'whsec_test_fake_secret') }, body: payload,
    }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    const [o] = await db().query<any>(`SELECT subtotal_cents, shipping_cents, shipping_label, discount_amount_cents, total_cents, status FROM orders WHERE cart_id = ?`, [cartId]);
    expect(o).toMatchObject({ subtotal_cents: 9000, shipping_cents: 152, shipping_label: 'Livraison par coursier', discount_amount_cents: 500, total_cents: 8652, status: 'paid' });
  });

  it('puts the cart id in the metadata so the webhook can find the order, and releases stock if Stripe refuses', async () => {
    await shippingOn();
    const cartId = await cartFor();
    expect((await checkout(cartId)).status).toBe(200);
    expect(sessionForm().get('metadata[cart_id]')).toBe(cartId);
    restore();
    restore = mockFetch((url) => url.includes('api.stripe.com') ? new Response(JSON.stringify({ error: { message: 'boom', type: 'api_error' } }), { status: 500 }) : new Response('{}'));
    const cart2 = await cartFor();
    const bad = await checkout(cart2);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const [inv] = await db().query<any>(`SELECT reserved FROM inventory WHERE sku = ?`, [sku]);
    expect(inv.reserved).toBe(2); // only the first (successful) cart still holds stock
  });
});
