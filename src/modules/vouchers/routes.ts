// Admin API of the vouchers module, mounted at /v1/m/vouchers (sign-in and role are checked by the framework).
//   GET    /                          plans with their stock + how many paid units are waiting for a code
//   PUT    /plans/:sku                make a product variant a voucher plan { instructions_fr?, instructions_en? }
//   DELETE /plans/:sku                stop selling it as a code (only when it holds no codes)
//   POST   /plans/:sku/codes          load codes { text, batch?, dry_run? } — checked in full first, all or nothing
//   GET    /codes                     ?sku= &status= &q= (a code or part of one) &limit=
//   POST   /codes/:seq/void           take an unsold code out of circulation (or flag a sold one as withdrawn)
//   GET    /orders                    paid orders that contain vouchers, newest first
//   GET    /orders/:orderId           one delivery (also hands out codes that are due)
//   POST   /orders/:orderId/resend    e-mail the codes again
//   POST   /reconcile                 hand out whatever is due now
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db';
import { ApiError, now, type HonoEnv } from '../../types';
import { audit } from '../../auth/service';
import { deliveryOf, missingFor, parseCodes, reconcile, rememberOrigin, MAX_LINES } from './lib';

const app = new Hono<HonoEnv>();
const actor = (c: any) => { const a = c.get('auth'); return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null }; };
async function body<T extends z.ZodTypeAny>(c: any, schema: T): Promise<z.infer<T>> {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

// Remember where this API lives (for the link in e-mails) whenever the admin uses the module.
app.use('*', async (c, next) => { await rememberOrigin(getDb(c.var.db), new URL(c.req.url).origin); await next(); });

app.get('/', async (c) => {
  const db = getDb(c.var.db);
  await reconcile(db);
  const plans = await db.query<any>(
    `SELECT p.sku, p.instructions_fr, p.instructions_en, v.title AS variant_title, pr.title AS product_title, v.price_cents, v.currency,
            (SELECT COUNT(*) FROM voucher_codes c WHERE c.sku = p.sku AND c.status = 'available') AS available,
            (SELECT COUNT(*) FROM voucher_codes c WHERE c.sku = p.sku AND c.status = 'sold') AS sold,
            (SELECT COUNT(*) FROM voucher_codes c WHERE c.sku = p.sku AND c.status = 'void') AS void,
            COALESCE((SELECT SUM(oi.qty - (SELECT COUNT(*) FROM voucher_codes c WHERE c.order_item_id = oi.id)) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                       WHERE oi.sku = p.sku AND o.status NOT IN ('canceled', 'refunded') AND COALESCE(o.amount_paid_cents, 0) >= o.total_cents AND o.total_cents > 0), 0) AS waiting
       FROM voucher_plans p LEFT JOIN variants v ON v.sku = p.sku LEFT JOIN products pr ON pr.id = v.product_id ORDER BY pr.title, v.title`);
  return c.json({ items: plans });
});

app.put('/plans/:sku', async (c) => {
  const sku = c.req.param('sku');
  const b = await body(c, z.object({ instructions_fr: z.string().trim().max(2000).optional(), instructions_en: z.string().trim().max(2000).optional() }));
  const db = getDb(c.var.db);
  const [v] = await db.query(`SELECT 1 FROM variants WHERE sku = ?`, [sku]);
  if (!v) throw ApiError.notFound('No product variant has this SKU.');
  await db.run(
    `INSERT INTO voucher_plans (sku, instructions_fr, instructions_en, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(sku) DO UPDATE SET instructions_fr = COALESCE(?, instructions_fr), instructions_en = COALESCE(?, instructions_en)`,
    [sku, b.instructions_fr ?? null, b.instructions_en ?? null, now(), b.instructions_fr ?? null, b.instructions_en ?? null]
  );
  await audit(db, { action: 'voucher.plan', ...actor(c), target: sku });
  return c.json({ sku });
});

app.delete('/plans/:sku', async (c) => {
  const sku = c.req.param('sku'); const db = getDb(c.var.db);
  const [has] = await db.query(`SELECT 1 FROM voucher_codes WHERE sku = ? LIMIT 1`, [sku]);
  if (has) throw ApiError.conflict('This plan holds codes (kept for your records). Void the unsold ones instead.');
  await db.run(`DELETE FROM voucher_plans WHERE sku = ?`, [sku]);
  return c.json({ deleted: true });
});

app.post('/plans/:sku/codes', async (c) => {
  const sku = c.req.param('sku');
  const b = await body(c, z.object({ text: z.string().max(400_000), batch: z.string().trim().max(80).optional(), dry_run: z.boolean().optional() }));
  const db = getDb(c.var.db);
  const [plan] = await db.query(`SELECT 1 FROM voucher_plans WHERE sku = ?`, [sku]);
  if (!plan) throw ApiError.notFound('Make this product a voucher plan first.');
  const { codes, problems } = parseCodes(b.text);
  if (codes.length === 0 && problems.length === 0) throw ApiError.invalidRequest('The list is empty.');
  // Codes that already exist (anywhere: a username is unique on the router).
  const clash: typeof problems = [];
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    const found = await db.query<{ username: string; sku: string }>(`SELECT username, sku FROM voucher_codes WHERE lower(username) IN (${chunk.map(() => '?').join(',')})`, chunk.map((x) => x.username.toLowerCase()));
    const byName = new Map(found.map((f) => [f.username.toLowerCase(), f.sku]));
    for (const x of chunk) if (byName.has(x.username.toLowerCase())) clash.push({ line: x.line, text: x.username, reason: `Already loaded${byName.get(x.username.toLowerCase()) === sku ? '' : ` (for ${byName.get(x.username.toLowerCase())})`}.` });
  }
  const all = [...problems, ...clash].sort((a, z2) => a.line - z2.line);
  const report = { lines: codes.length + all.length, problems: all, ok: all.length === 0, to_add: codes.length - clash.length };
  if (!report.ok) return c.json({ ...report, added: 0 }, 422);
  if (b.dry_run) return c.json({ ...report, added: 0 });
  const ts = now();
  for (const x of codes) await db.run(`INSERT INTO voucher_codes (sku, username, password, status, batch, created_at) VALUES (?, ?, ?, 'available', ?, ?)`, [sku, x.username, x.password, b.batch || null, ts]);
  await reconcile(db);   // paid orders that were waiting are served now, in the order they were paid
  await audit(db, { action: 'voucher.loaded', ...actor(c), target: sku, meta: { count: codes.length, batch: b.batch ?? null } });
  return c.json({ ...report, added: codes.length });
});

app.get('/codes', async (c) => {
  const db = getDb(c.var.db);
  const where: string[] = []; const args: unknown[] = [];
  const sku = c.req.query('sku'); const status = c.req.query('status'); const q = c.req.query('q')?.trim();
  if (sku) { where.push('c.sku = ?'); args.push(sku); }
  if (status && ['available', 'sold', 'void'].includes(status)) { where.push('c.status = ?'); args.push(status); }
  if (q) { where.push(`c.username LIKE ? ESCAPE '\\'`); args.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); }
  const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit') ?? '100', 10) || 100));
  const rows = await db.query<any>(
    `SELECT c.seq, c.sku, c.username, c.password, c.status, c.batch, c.sold_at, c.created_at, o.number AS order_number, o.status AS order_status
       FROM voucher_codes c LEFT JOIN orders o ON o.id = c.order_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.seq DESC LIMIT ${limit}`, args);
  return c.json({ items: rows });
});

app.post('/codes/:seq/void', async (c) => {
  const db = getDb(c.var.db); const seq = parseInt(c.req.param('seq'), 10);
  const [row] = await db.query<{ username: string; status: string }>(`SELECT username, status FROM voucher_codes WHERE seq = ?`, [seq]);
  if (!row) throw ApiError.notFound('Code not found');
  if (row.status === 'void') return c.json({ seq, status: 'void' });
  await db.run(`UPDATE voucher_codes SET status = 'void' WHERE seq = ?`, [seq]);
  await audit(db, { action: 'voucher.void', ...actor(c), target: row.username, meta: { was: row.status } });
  return c.json({ seq, status: 'void' });
});

app.get('/orders', async (c) => {
  const db = getDb(c.var.db);
  await reconcile(db);
  const ids = await db.query<{ order_id: string }>(
    `SELECT DISTINCT oi.order_id FROM order_items oi JOIN voucher_plans p ON p.sku = oi.sku JOIN orders o ON o.id = oi.order_id ORDER BY o.created_at DESC LIMIT 200`);
  const out = [];
  for (const { order_id } of ids) { const d = await deliveryOf(db, order_id); if (d) out.push({ ...d, token: undefined, has_link: !!d.token }); }
  return c.json({ items: out });
});

app.get('/orders/:orderId', async (c) => {
  const db = getDb(c.var.db); const id = c.req.param('orderId');
  await reconcile(db, id);
  const d = await deliveryOf(db, id);
  if (!d) throw ApiError.notFound('This order holds no vouchers.');
  const origin = new URL(c.req.url).origin;
  return c.json({ ...d, link: d.token ? `${origin}/m/vouchers/o/${d.token}` : null, missing: await missingFor(db, id) });
});

app.post('/orders/:orderId/resend', async (c) => {
  const db = getDb(c.var.db); const id = c.req.param('orderId');
  await reconcile(db, id);
  const d = await deliveryOf(db, id);
  if (!d) throw ApiError.notFound('This order holds no vouchers.');
  if (d.items.some((i) => i.waiting > 0)) throw ApiError.conflict('Some codes are still missing: load more codes first.');
  await db.run(`UPDATE voucher_orders SET emailed_at = NULL, email_tries = 0 WHERE order_id = ?`, [id]);
  await reconcile(db, id);
  const after = await deliveryOf(db, id);
  await audit(db, { action: 'voucher.resent', ...actor(c), target: d.number, meta: { emailed: !!after?.emailed } });
  return c.json({ emailed: !!after?.emailed });
});

app.post('/reconcile', async (c) => { await reconcile(getDb(c.var.db)); return c.json({ ok: true }); });

export { app as voucherAdmin, MAX_LINES };
