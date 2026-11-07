// =============================================================================
// Shop details printed on receipts and quotes.
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys } from './setup';
import { roleCanRequest } from '../auth/permissions';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let ip = 0;
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'PUT' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.111.${(++ip % 250) + 1}` },
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const full = { name: 'Santé Natur’', address: 'Fidjrossè, Cotonou', phone: '+229 01 00 00 00 00', email: 'hello@example.com', tax_id: 'IFU 123', footer_fr: 'Merci !', footer_en: 'Thank you!', paper: 'a4' };

beforeEach(async () => {
  const d = db(); await d.run(`DELETE FROM api_keys`); await d.run(`DELETE FROM config WHERE key = 'shop_profile'`); await d.run(`DELETE FROM audit_log WHERE action = 'shop.profile'`);
  adminKey = (await seedApiKeys(d)).adminKey;
});

describe('shop profile', () => {
  it('starts from the store name, then returns what was saved', async () => {
    const first = await j(await call('/v1/shop-profile'));
    expect(first).toMatchObject({ name: 'Test Store', address: '', paper: 'ticket' });
    expect((await call('/v1/shop-profile', { json: full })).status).toBe(200);
    expect(await j(await call('/v1/shop-profile'))).toEqual(full);
    expect((await db().query<any>(`SELECT 1 FROM audit_log WHERE action = 'shop.profile'`)).length).toBe(1);
  });
  it('an empty name falls back to the store name; bad input is refused', async () => {
    await call('/v1/shop-profile', { json: { ...full, name: '' } });
    expect((await j(await call('/v1/shop-profile'))).name).toBe('Test Store');
    expect((await call('/v1/shop-profile', { json: { ...full, address: 'x'.repeat(301) } })).status).toBe(400);
    expect((await call('/v1/shop-profile', { json: { ...full, paper: 'letter' } })).status).toBe(400);
    expect((await call('/v1/shop-profile', { json: { name: 'only' } })).status).toBe(400);
  });
  it('anyone who reads orders can read it; only settings access can change it; no key is refused', async () => {
    expect(roleCanRequest('staff', 'GET', '/v1/shop-profile').ok).toBe(true);
    expect(roleCanRequest('staff', 'PUT', '/v1/shop-profile').ok).toBe(false);
    expect(roleCanRequest('manager', 'GET', '/v1/shop-profile').ok).toBe(true);
    expect(roleCanRequest('owner', 'PUT', '/v1/shop-profile').ok).toBe(true);
    expect((await call('/v1/shop-profile', { key: null })).status).toBe(401);
  });
});
