// =============================================================================
// Launch readiness: automatic checks on real shop content + manual ticks.
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct, seedEmailConfig } from './setup';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let publicKey = ''; let ip = 0;
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'PUT' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.108.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const get = async () => j(await call('/v1/launch'));
const chk = (d: any, id: string) => d.checks.find((c: any) => c.id === id);

async function emptyBucket() { const l = await env.BACKUPS!.list({ prefix: 'backups/' }); for (const o of l.objects) await env.BACKUPS!.delete(o.key); }

beforeEach(async () => {
  const d = db();
  for (const t of ['inventory_logs', 'inventory', 'variants', 'products', 'api_keys', 'shipping_rates', 'shipping_zones']) { try { await d.run(`DELETE FROM ${t}`); } catch { /* absent */ } }
  await d.run(`DELETE FROM config WHERE key IN ('stripe', 'fedapay', 'email', 'shipping', 'launch_manual')`);
  await d.run(`DELETE FROM audit_log WHERE action LIKE 'launch.%'`);
  await emptyBucket();
  const k = await seedApiKeys(d); adminKey = k.adminKey; publicKey = (k as any).publicKey ?? '';
});

describe('launch: automatic checks', () => {
  it('an empty shop fails the must-haves', async () => {
    const d = await get();
    expect(chk(d, 'products').ok).toBe(false); expect(d.ready).toBe(false);
    expect(chk(d, 'shipping')).toBeUndefined();   // nothing physical on sale: not asked
    expect(chk(d, 'email').ok).toBe(false); expect(chk(d, 'backup_recent').ok).toBe(false);
  });
  it('flags products without image, placeholder images, free items, missing weight/description/stock, with examples', async () => {
    const p = await seedProduct(db(), { price_cents: 0, on_hand: 0 });
    let d = await get();
    expect(chk(d, 'products').ok).toBe(true);
    expect(chk(d, 'images_missing')).toMatchObject({ ok: false, count: 1, sample: ['Test Product'] });
    expect(chk(d, 'price_zero')).toMatchObject({ ok: false, sample: [p.sku] });
    expect(chk(d, 'weight_missing').ok).toBe(false); expect(chk(d, 'stock_zero').ok).toBe(false); expect(chk(d, 'description_missing').ok).toBe(false);
    await db().run(`UPDATE products SET image_url = 'https://images.unsplash.com/photo-1', description_fr = 'Un savon' WHERE id = ?`, [p.productId]);
    await db().run(`UPDATE variants SET price_cents = 1500, weight_g = 120 WHERE sku = ?`, [p.sku]); await db().run(`UPDATE inventory SET on_hand = 5 WHERE sku = ?`, [p.sku]);
    d = await get();
    expect(chk(d, 'images_missing').ok).toBe(true); expect(chk(d, 'images_placeholder')).toMatchObject({ ok: false, count: 1 });
    expect(chk(d, 'price_zero').ok).toBe(true); expect(chk(d, 'weight_missing').ok).toBe(true); expect(chk(d, 'stock_zero').ok).toBe(true); expect(chk(d, 'description_missing').ok).toBe(true);
    await db().run(`UPDATE products SET image_url = 'https://assets.teststore.com/a.jpg' WHERE id = ?`, [p.productId]);
    expect(chk(await get(), 'images_placeholder').ok).toBe(true);
  });
  it('a real image on the variant counts; drafts are ignored; services may be free', async () => {
    const a = await seedProduct(db()); const b = await seedProduct(db(), { price_cents: 0 });
    await db().run(`UPDATE variants SET image_url = 'https://assets.teststore.com/v.jpg' WHERE sku = ?`, [a.sku]);
    await db().run(`UPDATE products SET status = 'draft' WHERE id = ?`, [b.productId]);
    const d = await get(); expect(chk(d, 'images_missing').ok).toBe(true); expect(chk(d, 'price_zero').ok).toBe(true);
    await db().run(`UPDATE products SET status = 'active' WHERE id = ?`, [b.productId]); await db().run(`UPDATE variants SET product_type = 'digital' WHERE sku = ?`, [b.sku]);
    expect(chk(await get(), 'price_zero').ok).toBe(false);   // digital and free still flagged
  });
  it('shipping must be on with a zone and a rate when something physical is sold', async () => {
    await seedProduct(db());
    expect(chk(await get(), 'shipping').ok).toBe(false);
    await db().run(`INSERT INTO config (key, value) VALUES ('shipping', ?)`, [JSON.stringify({ enabled: true })]);
    await db().run(`INSERT INTO shipping_zones (id, name, countries, regions, active, position, created_at) VALUES ('z1', 'Benin', '["BJ"]', '[]', 1, 0, 'x')`);
    expect(chk(await get(), 'shipping').ok).toBe(false);
    await db().run(`INSERT INTO shipping_rates (id, zone_id, name_fr, name_en, kind, flat_cents, active, position) VALUES ('r1', 'z1', 'Livraison', 'Delivery', 'flat', 1000, 1, 0)`);
    expect(chk(await get(), 'shipping').ok).toBe(true);
  });
  it('every currency on sale needs a connected provider', async () => {
    const p = await seedProduct(db()); await db().run(`UPDATE variants SET currency = 'XOF' WHERE sku = ?`, [p.sku]);
    expect(chk(await get(), 'payments')).toMatchObject({ ok: false, sample: ['XOF'] });
    await db().run(`INSERT INTO config (key, value) VALUES ('fedapay', ?)`, [JSON.stringify({ secret_key: 'sk_x', env: 'sandbox' })]);
    expect(chk(await get(), 'payments').ok).toBe(true);
    await db().run(`UPDATE variants SET currency = 'EUR' WHERE sku = ?`, [p.sku]);
    expect(chk(await get(), 'payments').ok).toBe(false);
  });
  it('e-mail, identity and backups', async () => {
    let d = await get(); expect(chk(d, 'store_name').ok).toBe(true); expect(chk(d, 'store_url').ok).toBe(true);
    expect(chk(d, 'email').ok).toBe(false); await seedEmailConfig(db()); expect(chk(await get(), 'email').ok).toBe(true);
    expect(chk(await get(), 'backup_recent').ok).toBe(false);
    await env.BACKUPS!.put('backups/2026-11-05.ndjson.gz', 'x');
    expect(chk(await get(), 'backup_recent').ok).toBe(true);
  });
});

describe('launch: manual items and access', () => {
  it('ticks are saved with who and when, can be undone, and unknown ids are refused', async () => {
    expect((await call('/v1/launch/manual/mail_dns', { json: { done: true } })).status).toBe(200);
    let d = await get(); const m = d.manual.find((x: any) => x.id === 'mail_dns'); expect(m.done).toBe(true); expect(m.at).toBeTruthy(); expect(m.must).toBe(true);
    expect((await call('/v1/launch/manual/mail_dns', { json: { done: false } })).status).toBe(200);
    expect((await get()).manual.find((x: any) => x.id === 'mail_dns').done).toBe(false);
    expect((await call('/v1/launch/manual/nope', { json: { done: true } })).status).toBe(404);
    expect((await call('/v1/launch/manual/mail_dns', { json: { done: 'yes' } })).status).toBe(400);
    expect((await db().query(`SELECT COUNT(*) n FROM audit_log WHERE action = 'launch.manual'`))[0].n).toBe(2);
  });
  it('ready only when every must-have is green and every required manual item is ticked', async () => {
    const p = await seedProduct(db()); await db().run(`UPDATE products SET image_url = 'https://assets.teststore.com/a.jpg', description_fr = 'x' WHERE id = ?`, [p.productId]);
    await db().run(`UPDATE variants SET currency = 'XOF', weight_g = 100 WHERE sku = ?`, [p.sku]);
    await db().run(`INSERT INTO config (key, value) VALUES ('fedapay', ?)`, [JSON.stringify({ secret_key: 'sk_x' })]);
    await db().run(`INSERT INTO config (key, value) VALUES ('shipping', ?)`, [JSON.stringify({ enabled: true })]);
    await db().run(`INSERT INTO shipping_zones (id, name, countries, regions, active, position, created_at) VALUES ('z1', 'Benin', '["BJ"]', '[]', 1, 0, 'x')`);
    await db().run(`INSERT INTO shipping_rates (id, zone_id, name_fr, name_en, kind, flat_cents, active, position) VALUES ('r1', 'z1', 'L', 'D', 'flat', 1000, 1, 0)`);
    await seedEmailConfig(db()); await env.BACKUPS!.put('backups/today.ndjson.gz', 'x');
    let d = await get(); expect(d.checks.filter((c: any) => c.must && !c.ok)).toEqual([]); expect(d.ready).toBe(false);
    for (const m of d.manual.filter((x: any) => x.must)) await call(`/v1/launch/manual/${m.id}`, { json: { done: true } });
    d = await get(); expect(d.ready).toBe(true);
    await db().run(`UPDATE products SET image_url = NULL WHERE id = ?`, [p.productId]);
    expect((await get()).ready).toBe(false);
  });
  it('is for owners only: public keys and no key are refused', async () => {
    expect((await call('/v1/launch', { key: null })).status).toBe(401);
    if (publicKey) expect([401, 403]).toContain((await call('/v1/launch', { key: publicKey })).status);
  });
});
