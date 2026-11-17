// → src/routes/tier.ts
//   PUT /v1/tier           agency only (X-Setup-Token): choose the client's tier, what it sells, extra modules, limits
//   GET /v1/tier           agency only (X-Setup-Token): the tier list and what is stored
//   GET /v1/capabilities   anyone signed in (admin menu, storefront): what this client can use, and how much is used
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { audit } from '../auth/service';
import { ApiError, type HonoEnv } from '../types';
import { MODULES } from '../modules/registry';
import { KINDS, TIERS, countProducts, countStaff, getPlan, readStoredPlan, type StoredPlan } from '../lib/tiers';

export const tierAdmin = new Hono<HonoEnv>();

function needSetupToken(c: { env: { SETUP_TOKEN?: string }; req: { header: (n: string) => string | undefined } }) {
  if (!c.env.SETUP_TOKEN) throw ApiError.invalidRequest('SETUP_TOKEN is not configured.');
  if (c.req.header('X-Setup-Token') !== c.env.SETUP_TOKEN) throw ApiError.unauthorized('Missing or invalid X-Setup-Token header');
}

const Body = z.object({
  tier: z.string().refine((t) => t in TIERS, { message: `tier must be one of: ${Object.keys(TIERS).join(', ')}` }),
  sells: z.array(z.enum(KINDS as [string, ...string[]])).min(1).optional(),
  extra_modules: z.array(z.string().refine((id) => MODULES.some((m) => m.id === id), { message: 'unknown module id' })).optional(),
  max_products: z.number().int().min(0).nullable().optional(),
  max_staff: z.number().int().min(0).nullable().optional(),
});

tierAdmin.get('/tier', async (c) => {
  needSetupToken(c);
  return c.json({ tiers: TIERS, stored: await readStoredPlan(getDb(c.var.db)), modules: MODULES.map((m) => m.id) });
});

tierAdmin.put('/tier', async (c) => {
  needSetupToken(c);
  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw ApiError.invalidRequest(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  const db = getDb(c.var.db);
  const stored = parsed.data as StoredPlan;
  await db.run(`INSERT INTO config (key, value) VALUES ('tier', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(stored)]);
  await audit(db, { action: 'tier.set', actor_user_id: null, actor: 'agency', target: stored.tier, ip: c.req.header('CF-Connecting-IP') ?? null });
  return c.json({ stored, plan: await getPlan(db) });
});

tierAdmin.get('/capabilities', authMiddleware, async (c) => {
  const db = getDb(c.var.db);
  const plan = await getPlan(db);
  return c.json({
    tier: plan.tier, label: plan.label, sells: plan.sells, features: plan.features,
    modules: plan.modules === '*' ? MODULES.map((m) => m.id) : MODULES.map((m) => m.id).filter((id) => (plan.modules as string[]).includes(id)),
    limits: { max_products: plan.max_products, max_staff: plan.max_staff },
    usage: { products: await countProducts(db), staff: await countStaff(db) },
  });
});
