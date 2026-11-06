// → src/routes/launch.ts
//   GET /v1/launch                 launch readiness: automatic checks on the shop's real content and settings,
//                                  plus the manual items only a person can verify (with who ticked them, when)
//   PUT /v1/launch/manual/:id      { done: boolean }   tick or untick a manual item
// Owner / agency only (settings.manage). Read-only on everything except the ticks.
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, type Database } from '../db';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { audit } from '../auth/service';
import { ApiError, now, type HonoEnv } from '../types';
import { parseConfig } from '../lib/config-secrets';
import { PROVIDER_CURRENCIES } from '../lib/checkout';
import { getShippingSettings } from '../lib/shipping';
import { ensurePushTables } from '../lib/push';

const app = new Hono<HonoEnv>();
app.use('*', authMiddleware, requirePermission('settings.manage'));

/** Things only a person can check. The wording lives in the admin screen; ids are the contract. */
export const MANUAL_ITEMS = [
  { id: 'pay_live_fedapay', must: true },      // one real (small) mobile-money payment, then a refund note
  { id: 'pay_test_stripe', must: false },      // Stripe in test mode (only if EUR/USD are sold)
  { id: 'pay_cod', must: false },              // a cash-on-delivery order, marked paid
  { id: 'mail_dns', must: true },              // SPF, DKIM (and DMARC) so e-mails do not land in spam
  { id: 'mail_receive', must: true },          // order e-mail received on a Gmail and an Outlook/Yahoo inbox
  { id: 'phone_test', must: true },            // browse + order from a real phone on mobile data
  { id: 'backup_private', must: true },        // BACKUPS bucket has no public access and no custom domain
  { id: 'backup_restore', must: false },       // restored a backup on a scratch deployment once
  { id: 'legal_review', must: true },          // client has read terms, privacy, refund policy, FAQ, about
  { id: 'real_rates', must: true },            // real shipping rates entered (not estimates)
  { id: 'domain_https', must: true },          // final domain, HTTPS, PASSKEY_RP_ID / STORE_ORIGINS / ADMIN_ORIGINS match it
  { id: 'push_phone', must: false },           // admin app installed on the owner's phone, test notification received
  { id: 'demo_removed', must: false },         // old demo pages removed, sitemap/robots checked
  { id: 'team_roles', must: false },           // staff accounts created with the right roles
] as const;
const MANUAL_IDS = new Set<string>(MANUAL_ITEMS.map((m) => m.id));

type Check = { id: string; ok: boolean; must: boolean; count?: number; sample?: string[] };
const PLACEHOLDER = ['unsplash.com', 'placehold.co', 'picsum.photos', 'placeholder.com', 'via.placeholder', 'lorempixel'];

async function configRow(db: Database, key: string): Promise<any | null> {
  const [r] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = ?`, [key]);
  if (!r?.value) return null;
  try { return await parseConfig(key, r.value); } catch { return null; }
}

app.get('/', async (c) => {
  const db = getDb(c.var.db);
  const checks: Check[] = [];
  const add = (id: string, must: boolean, bad: { count: number; sample?: string[] } | null) => checks.push({ id, must, ok: !bad || bad.count === 0, ...(bad && bad.count ? { count: bad.count, sample: (bad.sample ?? []).slice(0, 5) } : {}) });

  // ── Catalog ───────────────────────────────────────────────────────────────
  const products = await db.query<{ id: string; title: string; image_url: string | null; description: string | null; description_fr: string | null; description_en: string | null }>(
    `SELECT id, title, image_url, description, description_fr, description_en FROM products WHERE status = 'active'`);
  const variants = await db.query<{ sku: string; product_id: string; title: string; price_cents: number; currency: string; weight_g: number | null; image_url: string | null; product_type: string | null; available: number | null }>(
    `SELECT v.sku, v.product_id, v.title, v.price_cents, v.currency, v.weight_g, v.image_url, v.product_type,
            (SELECT i.on_hand - i.reserved FROM inventory i WHERE i.sku = v.sku) AS available
       FROM variants v JOIN products p ON p.id = v.product_id WHERE v.status = 'active' AND p.status = 'active'`);
  add('products', true, products.length ? null : { count: 1 });
  const noImage = products.filter((p) => !p.image_url && !variants.some((v) => v.product_id === p.id && v.image_url));
  add('images_missing', true, { count: noImage.length, sample: noImage.map((p) => p.title) });
  const isPh = (u: string | null) => !!u && PLACEHOLDER.some((h) => u.includes(h));
  const ph = products.filter((p) => isPh(p.image_url) || variants.some((v) => v.product_id === p.id && isPh(v.image_url)));
  add('images_placeholder', true, { count: ph.length, sample: ph.map((p) => p.title) });
  const free = variants.filter((v) => v.price_cents <= 0 && v.product_type !== 'service');
  add('price_zero', true, { count: free.length, sample: free.map((v) => v.sku) });
  const noDesc = products.filter((p) => !(p.description ?? '').trim() && !(p.description_fr ?? '').trim() && !(p.description_en ?? '').trim());
  add('description_missing', false, { count: noDesc.length, sample: noDesc.map((p) => p.title) });
  const physical = variants.filter((v) => (v.product_type ?? 'physical') === 'physical');
  const noWeight = physical.filter((v) => !v.weight_g || v.weight_g <= 0);
  add('weight_missing', false, { count: noWeight.length, sample: noWeight.map((v) => v.sku) });
  const out = physical.filter((v) => (v.available ?? 0) <= 0);
  add('stock_zero', false, { count: out.length, sample: out.map((v) => v.sku) });

  // ── Shipping (only if something physical is sold) ──────────────────────────
  if (physical.length) {
    const s = await getShippingSettings(db);
    const [z] = await db.query<{ n: number }>(`SELECT COUNT(*) n FROM shipping_zones WHERE active = 1`);
    const [r] = await db.query<{ n: number }>(`SELECT COUNT(*) n FROM shipping_rates WHERE active = 1`);
    add('shipping', true, s.enabled && z.n > 0 && r.n > 0 ? null : { count: 1 });
  }

  // ── Payments: every currency on sale needs a connected provider ───────────
  const stripe = !!(await configRow(db, 'stripe')) || !!(c.env as any).STRIPE_SECRET_KEY;
  const fedapay = !!(await configRow(db, 'fedapay'))?.secret_key;
  const connected: Record<string, boolean> = { stripe, fedapay, paystack: false };
  const unpayable = [...new Set(variants.map((v) => v.currency))].filter((cur) => !Object.entries(PROVIDER_CURRENCIES).some(([p, list]) => list.includes(cur) && connected[p]));
  add('payments', true, { count: unpayable.length, sample: unpayable });

  // ── Identity, e-mail, backups, devices ────────────────────────────────────
  const env = c.env as any;
  add('store_name', true, env.STORE_NAME && env.STORE_NAME !== 'Your Store' ? null : { count: 1 });
  add('store_url', true, env.STORE_URL && /^https:\/\//.test(env.STORE_URL) ? null : { count: 1 });
  add('email', true, (await configRow(db, 'email')) ? null : { count: 1 });
  if (!c.env.BACKUPS) add('backup_recent', true, { count: 1, sample: ['no-bucket'] });
  else {
    const listed = await c.env.BACKUPS.list({ prefix: 'backups/' });
    const newest = listed.objects.map((o) => o.uploaded.getTime()).sort((a, b) => b - a)[0];
    add('backup_recent', true, newest && Date.now() - newest < 36 * 3_600_000 ? null : { count: 1, sample: [newest ? 'old' : 'none'] });
  }
  let pushDevices = 0;
  await ensurePushTables(db);
  pushDevices = (await db.query<{ n: number }>(`SELECT COUNT(*) n FROM push_subscriptions`))[0].n;
  add('push_device', false, pushDevices ? null : { count: 1 });

  // ── Manual items ───────────────────────────────────────────────────────────
  const saved = (await configRow(db, 'launch_manual')) ?? {};
  const manual = MANUAL_ITEMS.map((m) => ({ id: m.id, must: m.must, done: !!saved[m.id]?.done, at: saved[m.id]?.at ?? null, by: saved[m.id]?.by ?? null }));

  const ready = checks.filter((x) => x.must).every((x) => x.ok) && manual.filter((m) => m.must).every((m) => m.done);
  return c.json({ checks, manual, ready });
});

app.put('/manual/:id', async (c) => {
  const id = c.req.param('id');
  if (!MANUAL_IDS.has(id)) throw ApiError.notFound('Unknown checklist item');
  const b = z.object({ done: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) throw ApiError.invalidRequest('done must be true or false');
  const db = getDb(c.var.db); const a = c.get('auth') as any;
  const saved = (await configRow(db, 'launch_manual')) ?? {};
  if (b.data.done) saved[id] = { done: true, at: now(), by: a.user?.email ?? 'api-key' }; else delete saved[id];
  await db.run(`INSERT INTO config (key, value) VALUES ('launch_manual', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(saved)]);
  await audit(db, { action: 'launch.manual', actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null, target: id, meta: { done: b.data.done } });
  return c.json({ id, done: b.data.done });
});

export { app as launchRoutes };
