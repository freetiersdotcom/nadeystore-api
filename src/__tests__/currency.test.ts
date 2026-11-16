// =============================================================================
// Variant currency: audit + "align all variants to the store currency"
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct } from './setup';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let publicKey = ''; let ip = 0;
async function call(path: string, init: RequestInit & { key?: string | null } = {}) {
  const { key = adminKey, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'CF-Connecting-IP': `198.51.109.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
  });
}
const j = async (r: Response) => r.json() as Promise<any>;

beforeEach(async () => {
  const d = db();
  for (const t of ['inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) { try { await d.run(`DELETE FROM ${t}`); } catch { /* absent */ } }
  await d.run(`DELETE FROM config WHERE key = 'shipping'`);
  await d.run(`DELETE FROM audit_log WHERE action LIKE 'catalog.currency%'`);
  const k = await seedApiKeys(d); adminKey = k.adminKey; publicKey = (k as any).publicKey ?? '';
});

describe('variant currency', () => {
  it('counts the labels the variants carry against the store currency (XOF by default)', async () => {
    const a = await seedProduct(db()); const b = await seedProduct(db()); const c = await seedProduct(db());   // the test helper leaves the old default (USD)
    await db().run(`UPDATE variants SET currency = 'XOF' WHERE sku = ?`, [c.sku]);
    const r = await j(await call('/v1/catalog/currency'));
    expect(r).toMatchObject({ store_currency: 'XOF', total: 3, mismatched: 2, by_currency: [{ currency: 'USD', count: 2 }, { currency: 'XOF', count: 1 }] });
    expect(a.sku).not.toBe(b.sku);
  });

  it('align relabels every variant, leaves prices alone, and is written in the audit log', async () => {
    const a = await seedProduct(db(), { price_cents: 4500 }); await seedProduct(db());
    await db().run(`INSERT INTO variants (id, product_id, sku, title, price_cents, currency, weight_g, product_type, status) VALUES ('cv', ?, 'CUSTOM', 'Free-hand line', 0, 'USD', 0, 'digital', 'draft')`, [a.productId]);
    const res = await call('/v1/catalog/currency/align', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await j(res)).toEqual({ store_currency: 'XOF', updated: 2 });                   // the hidden CUSTOM line is aligned but not counted
    const rows = await db().query<{ currency: string; price_cents: number; sku: string }>(`SELECT sku, currency, price_cents FROM variants`);
    expect(rows.every((v) => v.currency === 'XOF')).toBe(true);
    expect(rows.find((v) => v.sku === a.sku)!.price_cents).toBe(4500);
    expect(await j(await call('/v1/catalog/currency'))).toMatchObject({ mismatched: 0, by_currency: [{ currency: 'XOF', count: 2 }] });
    const log = await db().query<{ meta: string; action: string }>(`SELECT action, meta FROM audit_log WHERE action = 'catalog.currency_align'`);
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0].meta)).toMatchObject({ to: 'XOF', updated: 2, from: [{ currency: 'USD', count: 2 }] });
  });

  it('a second run changes nothing and writes no second audit line', async () => {
    await seedProduct(db());
    await call('/v1/catalog/currency/align', { method: 'POST' });
    expect(await j(await call('/v1/catalog/currency/align', { method: 'POST' }))).toEqual({ store_currency: 'XOF', updated: 0 });
    expect(await db().query(`SELECT 1 FROM audit_log WHERE action = 'catalog.currency_align'`)).toHaveLength(1);
  });

  it('follows the store currency set in the shipping settings', async () => {
    await seedProduct(db());
    await db().run(`INSERT INTO config (key, value) VALUES ('shipping', ?)`, [JSON.stringify({ base_currency: 'eur' })]);
    expect(await j(await call('/v1/catalog/currency'))).toMatchObject({ store_currency: 'EUR', mismatched: 1 });
    expect(await j(await call('/v1/catalog/currency/align', { method: 'POST' }))).toEqual({ store_currency: 'EUR', updated: 1 });
    expect((await db().query<{ currency: string }>(`SELECT currency FROM variants`))[0].currency).toBe('EUR');
  });

  it('is closed to the public key and to anonymous callers', async () => {
    await seedProduct(db());
    for (const key of [publicKey, null]) {
      expect((await call('/v1/catalog/currency', { key })).status).toBeGreaterThanOrEqual(401);
      expect((await call('/v1/catalog/currency/align', { method: 'POST', key })).status).toBeGreaterThanOrEqual(401);
    }
    expect((await db().query<{ currency: string }>(`SELECT currency FROM variants`))[0].currency).toBe('USD');
  });
});
