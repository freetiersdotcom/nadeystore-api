// Admin API of the ad-tracking module, mounted at /v1/m/ads.
//   GET    /report?from=&to=      per campaign: orders, revenue, profit, spend, ROAS (grouped by currency)
//   GET    /spend                 ad spend entered by hand        POST /spend { platform, campaign, from_day, to_day, amount_cents, currency, note? }
//   DELETE /spend/:id
//   GET    /order/:id             where one order came from (or null)
//   GET    /pixels                Meta / TikTok pixel ids, test codes, whether a token is set (never the token), delivery counts
//   PUT    /pixels                { meta?: {pixel_id, access_token?, test_code}, tiktok?: {...} }  (omit access_token to keep it, null to remove it)
//   POST   /pixels/test           { platform } sends a synthetic purchase with the TEST code
//   GET    /events                latest server-side events and their result
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db';
import { ApiError, now, uuid, type HonoEnv } from '../../types';
import { audit } from '../../auth/service';
import { buildReport } from './lib';
import { getPixelSettings, savePixelSettings, sendTest, ready, type Platform } from './events';

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

const Plat = z.object({ pixel_id: z.string().trim().max(60).regex(/^[A-Za-z0-9_-]*$/, 'The pixel id may only contain letters, digits, - and _'), access_token: z.string().trim().max(1000).nullable().optional(), test_code: z.string().trim().max(60).regex(/^[A-Za-z0-9_-]*$/, 'The test code may only contain letters and digits') });
const Pixels = z.object({ meta: Plat.optional(), tiktok: Plat.optional() });

async function pixelView(db: any) {
  const s = await getPixelSettings(db);
  const counts = await db.query(`SELECT platform, status, COUNT(*) AS n FROM ad_events GROUP BY platform, status`);
  const view = (p: Platform) => ({ pixel_id: s[p].pixel_id, test_code: s[p].test_code, token_set: !!s[p].access_token, active: ready(s[p]),
    sent: counts.find((r: any) => r.platform === p && r.status === 'sent')?.n ?? 0, failed: counts.find((r: any) => r.platform === p && r.status === 'failed')?.n ?? 0 });
  return { meta: view('meta'), tiktok: view('tiktok') };
}

app.get('/pixels', async (c) => { noStore(c); return c.json(await pixelView(getDb(c.var.db))); });

app.put('/pixels', async (c) => {
  const b = Pixels.safeParse(await c.req.json().catch(() => null));
  if (!b.success) throw ApiError.invalidRequest(b.error.issues[0]?.message ?? 'Invalid pixel settings');
  const db = getDb(c.var.db); const cur = await getPixelSettings(db);
  for (const p of ['meta', 'tiktok'] as const) {
    const n = b.data[p]; if (!n) continue;
    cur[p].pixel_id = n.pixel_id; cur[p].test_code = n.test_code;
    if (n.access_token === null) cur[p].access_token = ''; else if (n.access_token) cur[p].access_token = n.access_token;
  }
  await savePixelSettings(db, cur);
  await audit(db, { action: 'ads.pixels.save', ...actor(c) });
  return c.json(await pixelView(db));
});

app.post('/pixels/test', async (c) => {
  const b = z.object({ platform: z.enum(['meta', 'tiktok']) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) throw ApiError.invalidRequest('platform must be "meta" or "tiktok"');
  const r = await sendTest(getDb(c.var.db), b.data.platform);
  return c.json({ ok: r.ok, status: r.status, detail: r.body.slice(0, 300) });
});

app.get('/events', async (c) => {
  noStore(c);
  const items = await getDb(c.var.db).query(`SELECT e.order_id, o.number, e.platform, e.status, e.tries, e.detail, e.updated_at FROM ad_events e LEFT JOIN orders o ON o.id = e.order_id ORDER BY e.updated_at DESC LIMIT 30`);
  return c.json({ items });
});

export const adsAdmin = app;
