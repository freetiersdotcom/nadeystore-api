// =============================================================================
// Printing a quotation: the admin print page, and the print button on the public page.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { mockFetch, seedApiKeys, seedProduct } from './setup';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let ip = 0; let sku = ''; let restore: () => void = () => {};
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.112.${(++ip % 250) + 1}` },
    redirect: 'manual',
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const sha = async (t: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))));
const shop = { name: 'Santé Natur’', address: 'Rue <b>12</b>, Cotonou', phone: '+229 01', email: '', tax_id: 'IFU 9', footer_fr: '', footer_en: '', paper: 'a4' };

beforeEach(async () => {
  const d = db();
  await d.run(`DROP TABLE IF EXISTS quotes`);
  await d.run(`DELETE FROM config WHERE key IN ('modules', 'email', 'shop_profile')`);
  for (const t of ['order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'customer_addresses', 'customers', 'inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) { try { await d.run(`DELETE FROM ${t}`); } catch { /* absent */ } }
  adminKey = (await seedApiKeys(d)).adminKey;
  sku = (await seedProduct(d, { price_cents: 450000, on_hand: 20 })).sku;
  restore = mockFetch(() => new Response('{}', { status: 200 }));
  await call('/v1/modules/quotes', { method: 'PUT', json: { enabled: true } });
  await call('/v1/shop-profile', { method: 'PUT', json: shop });
});
afterEach(() => restore());

const newQuote = async () => j(await call('/v1/m/quotes', { json: { currency: 'XOF', items: [{ sku, qty: 2 }], customer_name: 'Ama <i>Kossi</i>', note: 'Livraison <script>x</script>' } }));

describe('printing a quote', () => {
  it('the admin gets a printable page, also for a draft, with the shop details and no buttons or scripts', async () => {
    const q = await newQuote(); expect(q.status).toBe('draft');
    const r = await call(`/v1/m/quotes/${q.id}/print`, { method: 'GET' }); expect(r.status).toBe(200);
    const { html } = await j(r);
    expect(html).toContain('Santé Natur’'); expect(html).toContain('Cotonou'); expect(html).toContain('IFU 9'); expect(html).toContain(q.number);
    expect(html).not.toMatch(/<form|<button|<script/i);
    expect(html).not.toContain('<b>12</b>'); expect(html).not.toContain('<i>Kossi</i>'); expect(html).toContain('&lt;b&gt;12&lt;/b&gt;');
    expect((await call(`/v1/m/quotes/${q.id}/print`, { method: 'GET', key: null })).status).toBe(401);
    expect((await call(`/v1/m/quotes/nope/print`, { method: 'GET' })).status).toBe(404);
  });
  it('the public page of a sent quote shows the shop details and a print button, allowed by its own script hash only', async () => {
    const q = await newQuote(); await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' });
    const token = (await j(await call(`/v1/m/quotes/${q.id}`, { method: 'GET' }))).public_url.split('/q/')[1];
    const r = await call(`/m/quotes/q/${token}`, { method: 'GET', key: null }); expect(r.status).toBe(200);
    const html = await r.text(); const csp = r.headers.get('Content-Security-Policy') ?? '';
    expect(html).toContain('id="pr"'); expect(html).toContain('IFU 9'); expect(html).toContain('Cotonou'); expect(html).toContain('class="row noprint"');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    expect(csp).toContain(`script-src 'sha256-${await sha(script)}'`);
    expect(html.match(/<script/g)).toHaveLength(1);                         // nothing from the data became a script
    expect(html).not.toContain('<script>x</script>'); expect(html).not.toContain('<b>12</b>');
    expect(/script-src ([^;]*)/.exec(csp)![1]).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);   // scripts are never opened up broadly
    expect(csp).toContain("default-src 'none'");
  });
  it('a draft has no public page (unchanged), and an accepted quote can still be printed', async () => {
    const q = await newQuote(); const token = (await j(await call(`/v1/m/quotes/${q.id}`, { method: 'GET' }))).public_url.split('/q/')[1];
    expect((await call(`/m/quotes/q/${token}`, { method: 'GET', key: null })).status).toBe(404);
    await call(`/v1/m/quotes/${q.id}/send`, { method: 'POST' }); await call(`/m/quotes/q/${token}/accept`, { key: null, method: 'POST' });
    const html = await (await call(`/m/quotes/q/${token}`, { method: 'GET', key: null })).text();
    expect(html).toContain('id="pr"'); expect(html).not.toContain('/accept"');
  });
});
