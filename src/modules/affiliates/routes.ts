// Admin API of the affiliates module, mounted at /v1/m/affiliates (sign-in and role are checked by the framework).
//   GET    /                       affiliates with what each is owed
//   POST   /                       create { name, rate_percent, code?, email?, phone?, discount_code?, note? }
//   GET    /settings               { hold_days }
//   PUT    /settings               { hold_days }
//   GET    /:id                    one affiliate with attributed orders and payouts
//   PATCH  /:id                    edit (a new rate only applies to orders from then on)
//   DELETE /:id                    only when it has no orders and no payouts
//   POST   /:id/payouts            record a payout { amount_cents, currency, method, reference?, note? }
//   DELETE /:id/payouts/:payoutId  remove a payout recorded by mistake
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db';
import { ApiError, uuid, now, type HonoEnv } from '../../types';
import { audit } from '../../auth/service';
import { CODE_RE, formatAffiliate, newCode, newToken, normCode, ordersOf, payoutsOf, syncAttribution, totalsOf, holdDays, type AffiliateRow } from './lib';

const app = new Hono<HonoEnv>();
const origin = (c: any) => new URL(c.req.url).origin;
const actor = (c: any) => { const a = c.get('auth'); return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null }; };
async function body<T extends z.ZodTypeAny>(c: any, schema: T): Promise<z.infer<T>> {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

const Fields = {
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional(),
  rate_percent: z.number().min(0).max(100),
  code: z.string().trim().max(32).optional(),
  discount_code: z.string().trim().max(64).optional(),
  note: z.string().trim().max(2000).optional(),
  status: z.enum(['active', 'paused']).optional(),
};
const Create = z.object(Fields);
const Update = z.object(Fields).partial();
const Payout = z.object({
  amount_cents: z.number().int().min(1),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  method: z.enum(['mobile_money', 'bank_transfer', 'cash', 'other']),
  reference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
});

async function load(c: any, id: string): Promise<AffiliateRow> {
  const [a] = await getDb(c.var.db).query<AffiliateRow>(`SELECT * FROM affiliates WHERE id = ?`, [id]);
  if (!a) throw ApiError.notFound('Affiliate not found');
  return a;
}
const fmt = (c: any, a: AffiliateRow) => formatAffiliate(a, c.env.STORE_URL, origin(c));
const bp = (percent: number) => Math.round(percent * 100);

async function codeFree(db: any, code: string, exceptId?: string) {
  const [x] = await db.query(`SELECT id FROM affiliates WHERE code = ? ${exceptId ? 'AND id != ?' : ''}`, exceptId ? [code, exceptId] : [code]);
  return !x;
}

app.get('/settings', async (c) => c.json({ hold_days: await holdDays(getDb(c.var.db)) }));
app.put('/settings', async (c) => {
  const b = await body(c, z.object({ hold_days: z.number().int().min(0).max(365) }));
  const db = getDb(c.var.db);
  await db.run(`UPDATE affiliate_settings SET hold_days = ? WHERE id = 1`, [b.hold_days]);
  await audit(db, { action: 'affiliate.settings', ...actor(c), meta: { hold_days: b.hold_days } });
  return c.json({ hold_days: b.hold_days });
});

app.get('/', async (c) => {
  const db = getDb(c.var.db);
  await syncAttribution(db);
  const rows = await db.query<AffiliateRow>(`SELECT * FROM affiliates ORDER BY created_at DESC LIMIT 500`);
  const orders = await ordersOf(db, null); const payouts = await payoutsOf(db, null);
  return c.json({
    hold_days: await holdDays(db),
    items: rows.map((a) => ({
      ...fmt(c, a),
      totals: totalsOf(orders.filter((o) => o.affiliate_id === a.id), payouts.filter((p) => p.affiliate_id === a.id)),
    })),
  });
});

app.post('/', async (c) => {
  const b = await body(c, Create);
  const db = getDb(c.var.db);
  const code = b.code ? normCode(b.code) : newCode();
  if (!CODE_RE.test(code)) throw ApiError.invalidRequest('code: 3 to 32 letters, digits, - or _');
  if (!(await codeFree(db, code))) throw ApiError.conflict('This code is already used by another affiliate.');
  const id = uuid(); const ts = now();
  await db.run(
    `INSERT INTO affiliates (id, code, token, name, email, phone, rate_bp, status, discount_code, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, code, newToken(), b.name, b.email || null, b.phone || null, bp(b.rate_percent), b.status ?? 'active', b.discount_code || null, b.note || null, ts, ts]
  );
  await audit(db, { action: 'affiliate.created', ...actor(c), target: code });
  return c.json(fmt(c, await load(c, id)), 201);
});

app.get('/:id', async (c) => {
  const a = await load(c, c.req.param('id'));
  const db = getDb(c.var.db);
  await syncAttribution(db);
  const orders = await ordersOf(db, a.id); const payouts = await payoutsOf(db, a.id);
  return c.json({ ...fmt(c, a), hold_days: await holdDays(db), totals: totalsOf(orders, payouts), orders, payouts });
});

app.patch('/:id', async (c) => {
  const a = await load(c, c.req.param('id'));
  const b = await body(c, Update);
  const db = getDb(c.var.db);
  let code = a.code;
  if (b.code !== undefined && b.code !== '') {
    code = normCode(b.code);
    if (!CODE_RE.test(code)) throw ApiError.invalidRequest('code: 3 to 32 letters, digits, - or _');
    if (!(await codeFree(db, code, a.id))) throw ApiError.conflict('This code is already used by another affiliate.');
  }
  await syncAttribution(db); // orders already placed keep the rate they were placed under
  await db.run(
    `UPDATE affiliates SET code = ?, name = ?, email = ?, phone = ?, rate_bp = ?, status = ?, discount_code = ?, note = ?, updated_at = ? WHERE id = ?`,
    [code, b.name ?? a.name, b.email !== undefined ? b.email || null : a.email, b.phone !== undefined ? b.phone || null : a.phone,
     b.rate_percent !== undefined ? bp(b.rate_percent) : a.rate_bp, b.status ?? a.status,
     b.discount_code !== undefined ? b.discount_code || null : a.discount_code, b.note !== undefined ? b.note || null : a.note, now(), a.id]
  );
  await audit(db, { action: 'affiliate.updated', ...actor(c), target: code });
  return c.json(fmt(c, await load(c, a.id)));
});

app.delete('/:id', async (c) => {
  const a = await load(c, c.req.param('id'));
  const db = getDb(c.var.db);
  await syncAttribution(db);
  const [o] = await db.query(`SELECT 1 FROM affiliate_orders WHERE affiliate_id = ? LIMIT 1`, [a.id]);
  const [p] = await db.query(`SELECT 1 FROM affiliate_payouts WHERE affiliate_id = ? LIMIT 1`, [a.id]);
  if (o || p) throw ApiError.conflict('This affiliate has orders or payouts. Pause them instead of deleting.');
  await db.run(`DELETE FROM affiliate_referrals WHERE affiliate_id = ?`, [a.id]);
  await db.run(`DELETE FROM affiliates WHERE id = ?`, [a.id]);
  await audit(db, { action: 'affiliate.deleted', ...actor(c), target: a.code });
  return c.json({ deleted: true });
});

app.post('/:id/payouts', async (c) => {
  const a = await load(c, c.req.param('id'));
  const b = await body(c, Payout);
  const db = getDb(c.var.db);
  await syncAttribution(db);
  const currency = b.currency.toUpperCase();
  const t = totalsOf(await ordersOf(db, a.id), await payoutsOf(db, a.id)).find((x) => x.currency === currency);
  const due = t?.balance_cents ?? 0;
  if (b.amount_cents > due) throw ApiError.conflict(`Only ${due} (in cents) is payable in ${currency} right now.`);
  const id = uuid();
  await db.run(
    `INSERT INTO affiliate_payouts (id, affiliate_id, amount_cents, currency, method, reference, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, a.id, b.amount_cents, currency, b.method, b.reference || null, b.note || null, now()]
  );
  await audit(db, { action: 'affiliate.payout', ...actor(c), target: a.code, meta: { amount_cents: b.amount_cents, currency, method: b.method } });
  return c.json({ id }, 201);
});

app.delete('/:id/payouts/:payoutId', async (c) => {
  const a = await load(c, c.req.param('id'));
  const db = getDb(c.var.db);
  const [p] = await db.query<{ amount_cents: number; currency: string }>(`SELECT amount_cents, currency FROM affiliate_payouts WHERE id = ? AND affiliate_id = ?`, [c.req.param('payoutId'), a.id]);
  if (!p) throw ApiError.notFound('Payout not found');
  await db.run(`DELETE FROM affiliate_payouts WHERE id = ?`, [c.req.param('payoutId')]);
  await audit(db, { action: 'affiliate.payout_removed', ...actor(c), target: a.code, meta: p });
  return c.json({ deleted: true });
});

export { app as affiliateAdmin };
