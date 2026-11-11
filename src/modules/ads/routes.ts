// Admin API of the ad-tracking module, mounted at /v1/m/ads.
//   GET    /report?from=&to=      per campaign: orders, revenue, profit, spend, ROAS (grouped by currency)
//   GET    /spend                 ad spend entered by hand        POST /spend { platform, campaign, from_day, to_day, amount_cents, currency, note? }
//   DELETE /spend/:id
//   GET    /order/:id             where one order came from (or null)
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db';
import { ApiError, now, uuid, type HonoEnv } from '../../types';
import { audit } from '../../auth/service';
import { buildReport } from './lib';

const app = new Hono<HonoEnv>();
const actor = (c: any) => { const a = c.get('auth'); return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null }; };
const noStore = (c: any) => c.header('Cache-Control', 'no-store');
const dateOk = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

app.get('/report', async (c) => {
  noStore(c);
  const today = new Date().toISOString().slice(0, 10);
  const to = dateOk(c.req.query('to')) ? c.req.query('to')! : today;
  const from = dateOk(c.req.query('from')) ? c.req.query('from')! : new Date(Date.parse(to + 'T00:00:00Z') - 29 * 86_400_000).toISOString().slice(0, 10);
  if (from > to) throw ApiError.invalidRequest('"from" must not be after "to".');
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw ApiError.invalidRequest('Choose a period of at most one year.');
  return c.json(await buildReport(getDb(c.var.db), from, to));
});

app.get('/spend', async (c) => {
  noStore(c);
  const items = await getDb(c.var.db).query(`SELECT id, platform, campaign, from_day, to_day, amount_cents, currency, note, created_at FROM ad_spend ORDER BY to_day DESC, created_at DESC LIMIT 300`);
  return c.json({ items });
});

const Spend = z.object({
  platform: z.string().trim().min(1).max(40), campaign: z.string().trim().min(1).max(120),
  from_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount_cents: z.number().int().min(1).max(10_000_000_000), currency: z.string().trim().length(3), note: z.string().trim().max(200).nullable().optional(),
});
app.post('/spend', async (c) => {
  const r = Spend.safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  const b = r.data;
  if (!dateOk(b.from_day) || !dateOk(b.to_day) || b.from_day > b.to_day) throw ApiError.invalidRequest('Choose a valid period (from must not be after to).');
  if (Date.parse(b.to_day) - Date.parse(b.from_day) > 366 * 86_400_000) throw ApiError.invalidRequest('A spend entry covers at most one year.');
  const db = getDb(c.var.db); const id = uuid();
  await db.run(`INSERT INTO ad_spend (id, platform, campaign, from_day, to_day, amount_cents, currency, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, b.platform, b.campaign, b.from_day, b.to_day, b.amount_cents, b.currency.toUpperCase(), b.note ?? null, now()]);
  await audit(db, { action: 'ads.spend.add', ...actor(c), target: id });
  return c.json({ id, ...b, currency: b.currency.toUpperCase() }, 201);
});

app.delete('/spend/:id', async (c) => {
  const db = getDb(c.var.db); const id = c.req.param('id');
  const [row] = await db.query(`SELECT id FROM ad_spend WHERE id = ?`, [id]);
  if (!row) throw ApiError.notFound('Spend entry not found.');
  await db.run(`DELETE FROM ad_spend WHERE id = ?`, [id]);
  await audit(db, { action: 'ads.spend.delete', ...actor(c), target: id });
  return c.json({ deleted: true });
});

app.get('/order/:id', async (c) => {
  noStore(c);
  const [a] = await getDb(c.var.db).query(
    `SELECT a.source, a.medium, a.campaign, a.content, a.term, a.click_id_type, a.landing, a.referrer FROM orders o JOIN ad_attribution a ON a.cart_id = o.cart_id WHERE o.id = ?`, [c.req.param('id')]);
  return c.json({ attribution: a ?? null });
});

export const adsAdmin = app;
