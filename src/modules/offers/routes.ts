// Admin API of the offers module, mounted at /v1/m/offers.
//   GET    /          the rules with their numbers (seen, taken, paid, revenue)
//   POST   /          create a rule
//   PUT    /:id       change a rule
//   DELETE /:id       remove a rule (its history is kept out of sight; carts already confirmed keep their price)
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db';
import { ApiError, now, type HonoEnv } from '../../types';
import { audit } from '../../auth/service';
import { listOffers } from './lib';

const app = new Hono<HonoEnv>();
const actor = (c: any) => { const a = c.get('auth'); return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null }; };
async function body<T extends z.ZodTypeAny>(c: any, schema: T): Promise<z.infer<T>> {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

const Rule = z.object({
  name: z.string().trim().min(1).max(80),
  active: z.boolean().default(true),
  trigger_kind: z.enum(['any', 'product', 'sku']),
  trigger_ref: z.string().trim().max(80).nullish(),
  offer_sku: z.string().trim().min(1).max(80),
  discount_pct: z.number().int().min(0).max(90).default(0),
  max_qty: z.number().int().min(1).max(20).default(1),
  headline_fr: z.string().trim().max(120).nullish(),
  headline_en: z.string().trim().max(120).nullish(),
  priority: z.number().int().min(-100).max(100).default(0),
});

async function check(db: ReturnType<typeof getDb>, r: z.infer<typeof Rule>) {
  const [t] = await db.query<{ product_id: string }>(`SELECT product_id FROM variants WHERE sku = ?`, [r.offer_sku]);
  if (!t) throw ApiError.invalidRequest('offer_sku: no product variant has this SKU');
  if (r.trigger_kind === 'any') return;
  if (!r.trigger_ref) throw ApiError.invalidRequest('trigger_ref: choose the product or variant that triggers the offer');
  if (r.trigger_kind === 'sku') {
    const [v] = await db.query<{ product_id: string }>(`SELECT product_id FROM variants WHERE sku = ?`, [r.trigger_ref]);
    if (!v) throw ApiError.invalidRequest('trigger_ref: no product variant has this SKU');
    if (v.product_id === t.product_id) throw ApiError.invalidRequest('The offered item belongs to the same product as the trigger.');
  } else {
    const [p] = await db.query(`SELECT 1 FROM products WHERE id = ?`, [r.trigger_ref]);
    if (!p) throw ApiError.invalidRequest('trigger_ref: no product has this id');
    if (r.trigger_ref === t.product_id) throw ApiError.invalidRequest('The offered item belongs to the same product as the trigger.');
  }
}
const cols = (r: z.infer<typeof Rule>) => [r.name, r.active ? 1 : 0, r.trigger_kind, r.trigger_kind === 'any' ? null : r.trigger_ref ?? null, r.offer_sku, r.discount_pct, r.max_qty, r.headline_fr || null, r.headline_en || null, r.priority];

app.get('/', async (c) => c.json({ items: await listOffers(getDb(c.var.db)) }));

app.post('/', async (c) => {
  const r = await body(c, Rule); const db = getDb(c.var.db); await check(db, r);
  const id = crypto.randomUUID();
  await db.run(`INSERT INTO offers (id, name, active, trigger_kind, trigger_ref, offer_sku, discount_pct, max_qty, headline_fr, headline_en, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, ...cols(r), now()]);
  await audit(db, { action: 'offer.create', ...actor(c), target: id });
  return c.json({ id }, 201);
});

app.put('/:id', async (c) => {
  const id = c.req.param('id'); const r = await body(c, Rule); const db = getDb(c.var.db);
  const [o] = await db.query(`SELECT 1 FROM offers WHERE id = ?`, [id]); if (!o) throw ApiError.notFound('No such offer');
  await check(db, r);
  await db.run(`UPDATE offers SET name = ?, active = ?, trigger_kind = ?, trigger_ref = ?, offer_sku = ?, discount_pct = ?, max_qty = ?, headline_fr = ?, headline_en = ?, priority = ? WHERE id = ?`, [...cols(r), id]);
  await audit(db, { action: 'offer.update', ...actor(c), target: id });
  return c.json({ id });
});

app.delete('/:id', async (c) => {
  const id = c.req.param('id'); const db = getDb(c.var.db);
  const [o] = await db.query(`SELECT 1 FROM offers WHERE id = ?`, [id]); if (!o) throw ApiError.notFound('No such offer');
  await db.run(`DELETE FROM offers WHERE id = ?`, [id]);
  await audit(db, { action: 'offer.delete', ...actor(c), target: id });
  return c.json({ deleted: true });
});

export const offersAdmin = app;
