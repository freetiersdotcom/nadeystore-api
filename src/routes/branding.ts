// → src/routes/branding.ts
//   GET /v1/branding   no sign-in needed (the admin login page shows it): name, logo, colour, language of the admin
//   PUT /v1/branding   owner / manager with settings access (agency too)
// Stored in `config` under "branding". The name falls back to the shop profile name, then STORE_NAME, then "Admin".
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, type Database } from '../db';
import { authMiddleware } from '../middleware/auth';
import { audit } from '../auth/service';
import { ApiError, type HonoEnv } from '../types';
import { getShopProfile } from './shop';

export type Branding = { name: string; logo_url: string; favicon_url: string; primary_color: string; locale: 'auto' | 'fr' | 'en' };

const assetUrl = z.string().trim().max(500).refine((v) => v === '' || /^(https:\/\/|\/)\S+$/.test(v), { message: 'must be an https:// address, or a path starting with /' });
const Body = z.object({
  name: z.string().trim().max(60),
  logo_url: assetUrl,
  favicon_url: assetUrl,
  primary_color: z.string().trim().refine((v) => v === '' || /^#[0-9a-fA-F]{6}$/.test(v), { message: 'must look like #0F6B4B, or be empty' }),
  locale: z.enum(['auto', 'fr', 'en']),
});

export async function getBranding(db: Database, storeName?: string): Promise<Branding> {
  const [r] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'branding'`);
  let saved: Partial<Branding> = {};
  try { saved = r?.value ? JSON.parse(r.value) : {}; } catch { /* ignore a damaged value */ }
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const name = s(saved.name) || (await getShopProfile(db, storeName)).name || 'Admin';
  return { name, logo_url: s(saved.logo_url), favicon_url: s(saved.favicon_url), primary_color: s(saved.primary_color), locale: saved.locale === 'fr' || saved.locale === 'en' ? saved.locale : 'auto' };
}

export const brandingRoutes = new Hono<HonoEnv>();

brandingRoutes.get('/', async (c) => {
  c.header('Cache-Control', 'public, max-age=60');
  return c.json(await getBranding(getDb(c.var.db), c.env.STORE_NAME));
});

brandingRoutes.put('/', authMiddleware, async (c) => {
  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw ApiError.invalidRequest(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  const db = getDb(c.var.db);
  await db.run(`INSERT INTO config (key, value) VALUES ('branding', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(parsed.data)]);
  const a = c.get('auth');
  await audit(db, { action: 'branding.update', actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', target: 'branding', ip: c.req.header('CF-Connecting-IP') ?? null });
  return c.json(await getBranding(db, c.env.STORE_NAME));
});
