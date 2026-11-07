// → src/routes/shop.ts
//   GET /v1/shop-profile    name, address, phone, e-mail, tax number, footers, default paper  (anyone who can read orders:
//                           it is printed on every receipt and quote)
//   PUT /v1/shop-profile    same fields, owner / manager with settings access only
// Stored in `config` under "shop_profile". The name falls back to STORE_NAME until one is saved.
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, type Database } from '../db';
import { authMiddleware } from '../middleware/auth';
import { audit } from '../auth/service';
import { ApiError, type HonoEnv } from '../types';

export type ShopProfile = { name: string; address: string; phone: string; email: string; tax_id: string; footer_fr: string; footer_en: string; paper: 'ticket' | 'a4' };

const Body = z.object({
  name: z.string().trim().max(120),
  address: z.string().trim().max(300),
  phone: z.string().trim().max(40),
  email: z.string().trim().max(120),
  tax_id: z.string().trim().max(80),
  footer_fr: z.string().trim().max(300),
  footer_en: z.string().trim().max(300),
  paper: z.enum(['ticket', 'a4']),
});

export async function getShopProfile(db: Database, storeName?: string): Promise<ShopProfile> {
  const [r] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'shop_profile'`);
  let saved: Partial<ShopProfile> = {};
  try { saved = r?.value ? JSON.parse(r.value) : {}; } catch { /* ignore a damaged value */ }
  const s = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
  return {
    name: s(saved.name) || storeName || '', address: s(saved.address), phone: s(saved.phone), email: s(saved.email), tax_id: s(saved.tax_id),
    footer_fr: s(saved.footer_fr), footer_en: s(saved.footer_en), paper: saved.paper === 'a4' ? 'a4' : 'ticket',
  };
}

export const shopRoutes = new Hono<HonoEnv>();
shopRoutes.use('*', authMiddleware);

shopRoutes.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await getShopProfile(getDb(c.var.db), (c.env as any).STORE_NAME));
});

shopRoutes.put('/', async (c) => {
  const b = Body.safeParse(await c.req.json().catch(() => null));
  if (!b.success) throw ApiError.invalidRequest('Check the shop details: some text is too long or a field is missing.');
  const db = getDb(c.var.db);
  await db.run(`INSERT INTO config (key, value) VALUES ('shop_profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(b.data)]);
  const a = c.get('auth') as any;
  await audit(db, { action: 'shop.profile', actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null });
  return c.json(await getShopProfile(db, (c.env as any).STORE_NAME));
});
