// =============================================================================
// A request the route schema refuses is answered in the API's usual error shape
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys } from './setup';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = '';
const post = (path: string, body: unknown, key: string | null = adminKey) => SELF.fetch(`http://localhost${path}`, {
  method: 'POST', headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(async () => { await db().run(`DELETE FROM api_keys`); adminKey = (await seedApiKeys(db())).adminKey; });

describe('validation errors', () => {
  it('a bad value answers 400 { error: { code, message } } and names the field', async () => {
    const res = await post('/v1/inventory/SKU-1/adjust', { delta: 1, reason: 'nonsense' });
    expect(res.status).toBe(400);
    const b: any = await res.json();
    expect(b.success).toBeUndefined();
    expect(b.error.code).toBe('invalid_request');
    expect(b.error.message).toMatch(/^reason: /);
    expect(b.error.details.issues[0].path).toEqual(['reason']);
  });

  it('several problems are all listed, with the field path', async () => {
    const b: any = await (await post('/v1/inventory/SKU-1/adjust', { reason: 'nonsense' })).json();
    expect(b.error.message).toContain('reason: ');
    expect(b.error.message).toContain('delta: ');
    expect(b.error.message).toContain('; ');
  });

  it('other 400s and other statuses keep their own answer', async () => {
    const gone = await post('/v1/inventory/NO-SUCH-SKU/adjust', { delta: 1, reason: 'restock' });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as any).error.code).toBe('not_found');
    expect((await post('/v1/inventory/SKU-1/adjust', { delta: 1, reason: 'x' }, null)).status).toBe(401);
  });
});
