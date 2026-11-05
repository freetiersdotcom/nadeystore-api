// Admin API of the abandoned-cart module, mounted at /v1/m/recovery.
//   GET  /            settings, numbers and the latest carts
//   PUT  /settings    { step1_hours, step2_hours (0 = no second reminder), discount_code|null, cooldown_days, max_age_days }
//   POST /test        { to? } send yourself a sample reminder (defaults to the signed-in user)
//   POST /run         look for abandoned carts and send what is due, now
//   GET  /optouts, DELETE /optouts/:email
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db';
import { ApiError, type HonoEnv } from '../../types';
import { audit } from '../../auth/service';
import { getEmailProvider } from '../../lib/email/index';
import { storeBase } from '../../lib/plans';
import { buildEmail, getSettings, listRows, rememberOrigin, resumeUrl, runRecovery, stopUrl, usable } from './lib';

const app = new Hono<HonoEnv>();
const actor = (c: any) => { const a = c.get('auth'); return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null }; };
const ctxOf = (c: any) => ({ storeBaseUrl: storeBase(c.env ?? {}), storeName: (c.env as any)?.STORE_NAME ?? 'Your Store' });

app.use('*', async (c, next) => { await rememberOrigin(getDb(c.var.db), new URL(c.req.url).origin); await next(); });

app.get('/', async (c) => {
  const db = getDb(c.var.db);
  const [settings, rows] = await Promise.all([getSettings(db), listRows(db, 100)]);
  const count = (s: string) => rows.filter((r) => r.state === s).length;
  const rev = await db.query<{ currency: string; cents: number; n: number }>(
    `SELECT o.currency, SUM(o.total_cents) cents, COUNT(*) n FROM orders o JOIN recovery_carts r ON (o.cart_id = r.cart_id OR lower(o.customer_email) = r.email)
      WHERE r.first_sent_at IS NOT NULL AND o.created_at >= r.first_sent_at AND o.status != 'canceled' AND COALESCE(o.amount_paid_cents, 0) >= o.total_cents AND o.total_cents > 0 GROUP BY o.currency`);
  const [opt] = await db.query<{ n: number }>(`SELECT COUNT(*) n FROM recovery_optout`);
  const provider = await getEmailProvider(db);
  return c.json({ settings, has_email: !!provider, stats: { waiting: count('waiting'), reminded: count('reminded'), recovered: count('recovered'), optout: opt.n, recovered_revenue: rev }, items: rows.map((r) => ({ cart_id: r.cart_id, email: r.email, total_cents: r.total_cents, currency: r.currency, cart_at: r.cart_at, step: r.step, last_sent_at: r.last_sent_at, resumed: !!r.resumed_at, state: r.state, closed: r.closed, items: JSON.parse(r.items_json) })) });
});

app.put('/settings', async (c) => {
  const r = z.object({
    step1_hours: z.number().int().min(1).max(72), step2_hours: z.number().int().min(0).max(168),
    discount_code: z.string().trim().max(40).nullable().optional(), cooldown_days: z.number().int().min(0).max(30), max_age_days: z.number().int().min(1).max(30),
  }).safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  const b = r.data; const db = getDb(c.var.db);
  if (b.step2_hours > 0 && b.step2_hours <= b.step1_hours) throw ApiError.invalidRequest('The second reminder must come after the first.');
  const code = b.discount_code ? b.discount_code : null;
  if (code) { const [d] = await db.query(`SELECT 1 FROM discounts WHERE lower(code) = lower(?) AND status = 'active'`, [code]); if (!d) throw ApiError.invalidRequest('This discount code does not exist or is not active. Create it in Discounts first.'); }
  await db.run(`UPDATE recovery_settings SET step1_hours = ?, step2_hours = ?, discount_code = ?, cooldown_days = ?, max_age_days = ? WHERE id = 1`, [b.step1_hours, b.step2_hours, code, b.cooldown_days, b.max_age_days]);
  await audit(db, { action: 'recovery.settings', ...actor(c), target: 'settings' });
  return c.json(await getSettings(db));
});

app.post('/test', async (c) => {
  const db = getDb(c.var.db);
  const body = z.object({ to: z.string().email().optional(), step: z.number().int().min(1).max(2).optional(), lang: z.enum(['fr', 'en']).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw ApiError.invalidRequest('Invalid test request');
  const a = c.get('auth') as any; const to = body.data.to ?? a.user?.email;
  if (!to || !usable(to)) throw ApiError.invalidRequest('Give an e-mail address to send the test to.');
  const provider = await getEmailProvider(db);
  if (!provider) throw ApiError.conflict('E-mail is not set up yet.');
  const st = await getSettings(db); const ctx = ctxOf(c); const lang = body.data.lang ?? 'fr';
  const mail = buildEmail({ lang, storeName: ctx.storeName, items: [{ sku: 'DEMO', title: lang === 'fr' ? 'Produit d’exemple' : 'Sample product', qty: 2, unit_price_cents: 5000 }], currency: 'XOF', total: 10000, resumeUrl: resumeUrl(ctx.storeBaseUrl, lang, 'test'), stopUrl: stopUrl(new URL(c.req.url).origin, 'test', lang), step: body.data.step ?? 1, code: st.discount_code });
  await provider.send({ to, subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text });
  return c.json({ sent_to: to });
});

app.post('/run', async (c) => c.json(await runRecovery(getDb(c.var.db), ctxOf(c))));

app.get('/optouts', async (c) => c.json({ items: await getDb(c.var.db).query(`SELECT email, created_at FROM recovery_optout ORDER BY created_at DESC LIMIT 200`) }));
app.delete('/optouts/:email', async (c) => {
  const db = getDb(c.var.db); const email = decodeURIComponent(c.req.param('email')).toLowerCase();
  await db.run(`DELETE FROM recovery_optout WHERE email = ?`, [email]);
  await audit(db, { action: 'recovery.optout_removed', ...actor(c), target: email });
  return c.json({ deleted: true });
});

export { app as recoveryAdmin };
