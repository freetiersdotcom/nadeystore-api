// =============================================================================
// Backups: export, daily run to the private bucket, download, restore into an empty deployment.
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct } from './setup';
import { buildBackup, gzip, gunzipIfNeeded, restoreBackup, runBackup } from '../lib/backup';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let publicKey = ''; let ip = 0;
async function call(path: string, init: RequestInit & { key?: string | null } = {}) {
  const { key = adminKey, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'CF-Connecting-IP': `198.51.101.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
  });
}
async function wipeShop() {
  const d = db();
  for (const t of ['order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'customer_addresses', 'customers', 'inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) {
    try { await d.run(`DELETE FROM ${t}`); } catch { /* table may not exist */ }
  }
}
async function emptyBucket() {
  const l = await env.BACKUPS!.list({ prefix: 'backups/' });
  for (const o of l.objects) await env.BACKUPS!.delete(o.key);
}

beforeEach(async () => {
  await wipeShop(); await emptyBucket();
  const k = await seedApiKeys(db()); adminKey = k.adminKey; publicKey = (k as any).publicKey ?? '';
});

describe('export', () => {
  it('contains the shop data, a meta line with counts, and none of the live credentials', async () => {
    const p = await seedProduct(db(), { price_cents: 450000, on_hand: 7 });
    await db().run(`INSERT OR REPLACE INTO auth_throttle (key, count, window_start) VALUES ('probe', 1, 1)`);
    expect((await db().query(`SELECT 1 FROM auth_throttle WHERE key = 'probe'`)).length).toBe(1);
    const { text, tables } = await buildBackup(db());
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: 'meta', format: 1 });
    expect(tables.products).toBe(1);
    expect(lines.some((l) => l.t === 'variants' && l.r.sku === p.sku)).toBe(true);
    for (const t of ['sessions', 'login_tokens', 'customer_codes', 'customer_sessions', 'webauthn_challenges', 'oauth_tokens', 'auth_throttle']) {
      expect(lines.some((l) => l.t === t)).toBe(false);
    }
  });

  it('round-trips through gzip', async () => {
    await seedProduct(db());
    const { text } = await buildBackup(db());
    expect(await gunzipIfNeeded(await gzip(text))).toBe(text);
    expect(await gunzipIfNeeded(new TextEncoder().encode(text).buffer as ArrayBuffer)).toBe(text);
  });
});

describe('restore', () => {
  it('puts back exactly what was exported (foreign keys included)', async () => {
    const p = await seedProduct(db(), { price_cents: 450000, on_hand: 7 });
    const { text } = await buildBackup(db());
    await wipeShop();
    expect((await db().query(`SELECT 1 FROM products`)).length).toBe(0);
    const r = await restoreBackup(db(), text);
    expect(r.restored).toBeGreaterThan(2);
    expect(r.skipped).toBe(0);
    const [v] = await db().query<any>(`SELECT price_cents FROM variants WHERE sku = ?`, [p.sku]);
    const [inv] = await db().query<any>(`SELECT on_hand FROM inventory WHERE sku = ?`, [p.sku]);
    expect(v.price_cents).toBe(450000);
    expect(inv.on_hand).toBe(7);
  });

  it('rejects files that are not a backup', async () => {
    await expect(restoreBackup(db(), '')).rejects.toThrow();
    await expect(restoreBackup(db(), '{"kind":"meta","format":99}\n')).rejects.toThrow(/not a backup/);
  });

  it('ignores tables and columns it does not know, and counts them as skipped', async () => {
    const text = '{"kind":"meta","format":1}\n{"t":"no_such_table","r":{"a":1}}\n';
    const r = await restoreBackup(db(), text);
    expect(r).toMatchObject({ restored: 0, skipped: 1 });
  });
});

describe('daily backup to the private bucket', () => {
  it('writes a dated file and keeps only the newest N', async () => {
    await seedProduct(db());
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']) await env.BACKUPS!.put(`backups/${d}.ndjson.gz`, 'x');
    const r = await runBackup({ ...env, BACKUP_KEEP: '3' } as any, db());
    expect(r!.key).toBe(`backups/${new Date().toISOString().slice(0, 10)}.ndjson.gz`);
    const keys = (await env.BACKUPS!.list({ prefix: 'backups/' })).objects.map((o) => o.key);
    expect(keys.length).toBe(3);
    expect(keys).toContain(r!.key);
  });

  it('does nothing without a bucket', async () => {
    expect(await runBackup({ ...env, BACKUPS: undefined } as any, db())).toBeNull();
  });
});

describe('routes', () => {
  it('need an admin sign-in', async () => {
    expect((await call('/v1/backup', { key: null })).status).toBe(401);
    if (publicKey) expect((await call('/v1/backup', { key: publicKey })).status).toBe(403);
  });

  it('run → list → download a stored file → download live', async () => {
    await seedProduct(db());
    const run = await call('/v1/backup/run', { method: 'POST' });
    expect(run.status).toBe(200);
    const list = await (await call('/v1/backup')).json() as any;
    expect(list.configured).toBe(true);
    expect(list.backups).toHaveLength(1);
    const stored = await call(`/v1/backup/files/${list.backups[0].name}`);
    expect(stored.status).toBe(200);
    expect(await gunzipIfNeeded(await stored.arrayBuffer())).toContain('"t":"variants"');
    const live = await call('/v1/backup/download');
    expect(live.headers.get('content-disposition')).toMatch(/attachment; filename="backup-.*\.ndjson\.gz"/);
    expect(await gunzipIfNeeded(await live.arrayBuffer())).toContain('"kind":"meta"');
    const audit = await db().query<any>(`SELECT action FROM audit_log WHERE action LIKE 'backup.%'`);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['backup.run', 'backup.download']));
  });

  it('downloads keep their CORS headers, so the admin can fetch them from its own origin', async () => {
    await seedProduct(db());
    await call('/v1/backup/run', { method: 'POST' });
    const name = new Date().toISOString().slice(0, 10) + '.ndjson.gz';
    for (const path of ['/v1/backup/download', `/v1/backup/files/${name}`]) {
      const r = await call(path, { headers: { Origin: 'https://admin.test.com' } });
      expect(r.status).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBe('https://admin.test.com');
      expect(r.headers.get('access-control-allow-credentials')).toBe('true');
      expect(r.headers.get('access-control-expose-headers')).toContain('Content-Disposition');
      expect(r.headers.get('content-disposition')).toContain('attachment');
    }
  });

  it('refuses odd file names (no path tricks)', async () => {
    expect((await call('/v1/backup/files/..%2Fsecret')).status).toBe(404);
    expect((await call('/v1/backup/files/anything.txt')).status).toBe(404);
  });
});

describe('POST /v1/setup/restore', () => {
  const post = (body: BodyInit, token: string | null = 'test-setup-token') =>
    SELF.fetch('http://localhost/v1/setup/restore', { method: 'POST', body, headers: { ...(token ? { 'X-Setup-Token': token } : {}), 'CF-Connecting-IP': `198.51.102.${(++ip % 250) + 1}` } });

  it('needs the setup token', async () => {
    expect((await post('x', null)).status).toBe(401);
    expect((await post('x', 'wrong')).status).toBe(401);
  });

  it('refuses a deployment that already has data', async () => {
    await seedProduct(db());
    const r = await post('{"kind":"meta","format":1}\n');
    expect(r.status).toBe(409);
  });

  it('restores a gzip backup into an empty deployment', async () => {
    const p = await seedProduct(db(), { price_cents: 321000 });
    const { text } = await buildBackup(db());
    await wipeShop();
    const r = await post(await gzip(text));
    expect(r.status).toBe(200);
    const [v] = await db().query<any>(`SELECT price_cents FROM variants WHERE sku = ?`, [p.sku]);
    expect(v.price_cents).toBe(321000);
    // and the API key from the backup works again
    expect((await db().query(`SELECT 1 FROM api_keys`)).length).toBeGreaterThan(0);
  });

  it('answers 400 for a file that is not a backup', async () => {
    await wipeShop();
    expect((await post('hello')).status).toBe(400);
  });
});
