// =============================================================================
// Tiers (what a client's plan includes, enforced by the API) and branding.
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct } from './setup';
import { roleCanRequest } from '../auth/permissions';
import { resolvePlan, TIERS } from '../lib/tiers';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let ip = 0;
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown; headers?: Record<string, string> } = {}) {
  const { key = adminKey, json, headers = {}, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `10.55.${(++ip >> 8) & 255}.${ip & 255}`, ...headers },
    redirect: 'manual',
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const setTier = (body: Record<string, unknown>) => call('/v1/tier', { method: 'PUT', json: body, key: null, headers: { 'X-Setup-Token': 'test-setup-token' } });

beforeEach(async () => {
  const d = db();
  await d.run(`DELETE FROM config WHERE key IN ('tier', 'branding', 'modules', 'shop_profile')`);
  for (const t of ['order_items', 'orders', 'cart_items', 'carts', 'inventory', 'variants', 'products', 'api_keys']) await d.run(`DELETE FROM ${t}`);
  for (const t of ['sessions', 'login_tokens', 'identities', 'auth_throttle', 'audit_log', 'users']) await d.run(`DELETE FROM ${t}`);
  adminKey = (await seedApiKeys(d)).adminKey;
});

describe('the plan', () => {
  it('nothing stored means the top tier, so existing shops are unchanged', async () => {
    const r = await j(await call('/v1/capabilities'));
    expect(r).toMatchObject({ tier: 'pro', sells: ['physical', 'digital', 'service'], limits: { max_products: null, max_staff: null } });
    expect(Object.values(r.features).every(Boolean)).toBe(true);
    expect(r.modules).toContain('offers');
    expect((await call('/v1/modules/offers', { method: 'PUT', json: { enabled: true } })).status).toBe(200);
  });

  it('an unknown stored tier fails closed to the smallest one', () => {
    expect(resolvePlan({ tier: 'gone' }).tier).toBe('starter');
    expect(resolvePlan(null).tier).toBe('pro');
    expect(Object.keys(TIERS)).toEqual(['starter', 'standard', 'pro']);
  });

  it('only the agency (setup token) sets the tier, and the input is checked', async () => {
    expect((await call('/v1/tier', { method: 'PUT', json: { tier: 'starter' }, key: adminKey })).status).toBe(401); // even an admin key
    expect((await setTier({ tier: 'platinum' })).status).toBe(400);
    expect((await setTier({ tier: 'starter', sells: ['food'] })).status).toBe(400);
    expect((await setTier({ tier: 'starter', extra_modules: ['nope'] })).status).toBe(400);
    const ok = await setTier({ tier: 'starter', sells: ['physical'] });
    expect(ok.status).toBe(200);
    expect((await j(await call('/v1/tier', { key: null, headers: { 'X-Setup-Token': 'test-setup-token' } }))).stored).toMatchObject({ tier: 'starter', sells: ['physical'] });
    const audit = await db().query<any>(`SELECT action, target FROM audit_log WHERE action = 'tier.set'`);
    expect(audit).toHaveLength(1);
  });

  it('capabilities show the tier, the allowed modules, the limits and the usage', async () => {
    await setTier({ tier: 'starter', sells: ['physical', 'digital'] });
    await seedProduct(db(), { price_cents: 1000 });
    const r = await j(await call('/v1/capabilities'));
    expect(r).toMatchObject({ tier: 'starter', label: 'Starter', sells: ['physical', 'digital'], modules: ['lowstock'], limits: { max_products: 30, max_staff: 1 }, usage: { products: 1, staff: 0 } });
    expect(r.features).toEqual({ discounts: false, import_export: false, profit: false, backup: false });
    expect((await call('/v1/capabilities', { key: null })).status).toBe(401);
  });
});

describe('modules', () => {
  it('refuses to switch on a module the tier does not include, and lists it as not allowed', async () => {
    await setTier({ tier: 'starter' });
    const r = await call('/v1/modules/offers', { method: 'PUT', json: { enabled: true } });
    expect(r.status).toBe(403); expect((await j(r)).error.code).toBe('tier_limit');
    const list = (await j(await call('/v1/modules'))).items;
    expect(list.find((m: any) => m.id === 'offers')).toMatchObject({ allowed: false, enabled: false });
    expect(list.find((m: any) => m.id === 'lowstock').allowed).toBe(true);
    expect((await call('/v1/modules/lowstock', { method: 'PUT', json: { enabled: true } })).status).toBe(200);
  });

  it('a lowered tier closes a module that was already on, and extra modules open one', async () => {
    expect((await call('/v1/modules/offers', { method: 'PUT', json: { enabled: true } })).status).toBe(200);
    expect((await call('/v1/m/offers')).status).toBe(200);
    await setTier({ tier: 'starter' });
    expect((await call('/v1/m/offers')).status).toBe(404);
    expect((await j(await call('/v1/modules'))).items.find((m: any) => m.id === 'offers')).toMatchObject({ allowed: false, enabled: false });
    await setTier({ tier: 'starter', extra_modules: ['offers'] });
    expect((await call('/v1/m/offers')).status).toBe(200);
  });
});

describe('what the shop sells, and how many products', () => {
  it('refuses a product kind the shop does not sell (create and change)', async () => {
    await setTier({ tier: 'pro', sells: ['physical'] });
    const p = await seedProduct(db(), { price_cents: 1000 });
    const bad = await call(`/v1/products/${p.productId}/variants`, { json: { sku: 'DIG-1', title: 'Guide', price_cents: 500, product_type: 'digital' } });
    expect(bad.status).toBe(403); expect((await j(bad)).error.code).toBe('tier_limit');
    const good = await call(`/v1/products/${p.productId}/variants`, { json: { sku: 'PHY-2', title: 'Box', price_cents: 500, product_type: 'physical' } });
    expect(good.status).toBe(201);
    const upd = await call(`/v1/products/${p.productId}/variants/${p.variantId}`, { method: 'PATCH', json: { product_type: 'service' } });
    expect(upd.status).toBe(403);
  });

  it('stops creating products at the limit', async () => {
    await setTier({ tier: 'starter', max_products: 2 });
    await seedProduct(db(), { price_cents: 1000 }); await seedProduct(db(), { price_cents: 1000 });
    const r = await call('/v1/products', { json: { title: 'Third' } });
    expect(r.status).toBe(403); expect((await j(r)).error.details.max_products).toBe(2);
    await setTier({ tier: 'starter', max_products: null });
    expect((await call('/v1/products', { json: { title: 'Third' } })).status).toBe(201);
  });

  it('CSV import reports a kind that is not sold, and a file that would pass the limit', async () => {
    await setTier({ tier: 'starter', sells: ['physical'], max_products: 1 });
    const csv = 'handle,title,sku,price,type\nguide,Guide,GUIDE-1,1500,digital\n';
    const r = await call('/v1/import/products?dry_run=1', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } });
    // the starter tier has no import/export feature: closed before it reaches the importer
    expect(r.status).toBe(403);
    await setTier({ tier: 'standard', sells: ['physical'], max_products: 1 });
    const r2 = await j(await call('/v1/import/products?dry_run=1', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } }));
    expect(r2.ok).toBe(false); expect(r2.errors.map((e: any) => e.message).join(' ')).toContain('not sold');
    const two = 'handle,title,sku,price,type\na,A,A-1,1000,physical\nb,B,B-1,1000,physical\n';
    const r3 = await j(await call('/v1/import/products?dry_run=1', { method: 'POST', body: two, headers: { 'Content-Type': 'text/csv' } }));
    expect(r3.ok).toBe(false); expect(r3.errors.map((e: any) => e.message).join(' ')).toContain('allows 1 products');
  });
});

describe('admin areas a tier leaves out', () => {
  it('closes discounts, import/export, profit and backup on starter, and opens them on pro', async () => {
    await setTier({ tier: 'starter' });
    for (const p of ['/v1/discounts', '/v1/export/products.csv', '/v1/profit', '/v1/backup']) {
      const r = await call(p); expect(r.status, p).toBe(403); expect((await j(r)).error.code).toBe('tier_limit');
    }
    await setTier({ tier: 'pro' });
    for (const p of ['/v1/discounts', '/v1/export/products.csv']) expect((await call(p)).status, p).toBe(200);
  });

  it('standard keeps discounts and import/export but not profit', async () => {
    await setTier({ tier: 'standard' });
    expect((await call('/v1/discounts')).status).toBe(200);
    expect((await call('/v1/profit')).status).toBe(403);
  });
});

describe('staff accounts', () => {
  it('stops adding managers / staff at the limit (owners are not counted)', async () => {
    await setTier({ tier: 'starter' }); // 1 staff account
    const a = await call('/v1/auth/users', { json: { email: 'one@shop.test', role: 'manager' } });
    expect(a.status).toBe(201);
    const b = await call('/v1/auth/users', { json: { email: 'two@shop.test', role: 'staff' } });
    expect(b.status).toBe(403); expect((await j(b)).error.code).toBe('tier_limit');
    expect((await call('/v1/auth/users', { json: { email: 'boss@shop.test', role: 'owner' } })).status).toBe(201);
    expect((await j(await call('/v1/capabilities'))).usage.staff).toBe(1);
  });
});

describe('branding', () => {
  it('is public to read, defaults to the shop name, and is saved by someone with settings access', async () => {
    const d = await j(await call('/v1/branding', { key: null }));
    expect(d).toEqual({ name: 'Test Store', logo_url: '', favicon_url: '', primary_color: '', locale: 'auto' });
    expect((await call('/v1/branding', { method: 'PUT', key: null, json: d })).status).toBe(401);
    const saved = await call('/v1/branding', { method: 'PUT', json: { name: 'Acme Herbs', logo_url: 'https://cdn.acme.tg/logo.svg', favicon_url: '', primary_color: '#0F6B4B', locale: 'fr' } });
    expect(saved.status).toBe(200);
    expect(await j(await call('/v1/branding', { key: null }))).toMatchObject({ name: 'Acme Herbs', primary_color: '#0F6B4B', locale: 'fr' });
  });

  it('refuses a bad colour, an unsafe logo address and a name that is too long', async () => {
    const base = { name: 'A', logo_url: '', favicon_url: '', primary_color: '', locale: 'auto' };
    for (const bad of [{ primary_color: 'green' }, { logo_url: 'javascript:alert(1)' }, { logo_url: 'http://x.test/a.png' }, { name: 'x'.repeat(61) }, { locale: 'de' }]) {
      const r = await call('/v1/branding', { method: 'PUT', json: { ...base, ...bad } });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('follows the roles: owner and agency may change it, manager and staff may not', () => {
    expect(roleCanRequest('owner' as any, 'PUT', '/v1/branding').ok).toBe(true);
    expect(roleCanRequest('manager' as any, 'PUT', '/v1/branding').ok).toBe(false);
    expect(roleCanRequest('staff' as any, 'PUT', '/v1/branding').ok).toBe(false);
    for (const role of ['owner', 'manager', 'staff']) expect(roleCanRequest(role as any, 'GET', '/v1/capabilities').ok, role).toBe(true);
  });
});
