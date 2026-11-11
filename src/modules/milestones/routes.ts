// Admin API of the milestone payments module, mounted at /v1/m/milestones.
//   GET    /?q=                    schedules, latest first (order, customer, paid, next stage)
//   GET    /candidates?q=          orders that can take a schedule (waiting for payment, none yet)
//   GET    /order/:orderId         one schedule with each stage's state, and the pay link
//   PUT    /order/:orderId         { stages: [{ label, amount_cents | percent, expected_on? }], note? }  create or change (paid stages are locked)
//   DELETE /order/:orderId         remove the schedule (payments already received stay)
//   POST   /order/:orderId/request { send?: boolean }  ask for the next stage: e-mail the schedule and the pay link
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db';
import { ApiError, type HonoEnv } from '../../types';
import { audit } from '../../auth/service';
import { storeBase, ensurePayToken } from '../../lib/plans';
import { payUrl } from '../../lib/email/planNotice';
import { getOrder, removeSchedule, requestStage, saveSchedule, view } from './lib';

const app = new Hono<HonoEnv>();
const actor = (c: any) => { const a = c.get('auth'); return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null }; };
async function body<T extends z.ZodTypeAny>(c: any, schema: T): Promise<z.infer<T>> {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
const ctxOf = (c: any) => ({ storeBaseUrl: storeBase(c.env as any), storeName: (c.env as any).STORE_NAME ?? 'Your Store' });
const like = (q: string) => `%${q.replace(/[%_]/g, '')}%`;

app.get('/', async (c) => {
  const db = getDb(c.var.db); const q = (c.req.query('q') ?? '').trim();
  const rows = await db.query<any>(
    `SELECT o.id AS order_id, o.number, o.customer_email, o.shipping_name, o.status, o.currency, o.total_cents, COALESCE(o.amount_paid_cents, 0) AS paid_cents, s.created_at
       FROM ms_schedules s JOIN orders o ON o.id = s.order_id
      ${q ? `WHERE o.number LIKE ? OR o.customer_email LIKE ? OR o.shipping_name LIKE ?` : ''} ORDER BY s.created_at DESC LIMIT 200`, q ? [like(q), like(q), like(q)] : []);
  const items = [];
  for (const r of rows) { const v = await view(db, await getOrder(db, r.order_id)); const next = v?.stages.find((s) => s.status !== 'paid'); items.push({ ...r, stages: v?.stages.length ?? 0, stages_paid: v?.stages.filter((s) => s.status === 'paid').length ?? 0, next: next ? { pos: next.pos, label: next.label, status: next.status, remaining_cents: next.remaining_cents } : null }); }
  return c.json({ items });
});

app.get('/candidates', async (c) => {
  const db = getDb(c.var.db); const q = (c.req.query('q') ?? '').trim();
  const items = await db.query(
    `SELECT o.id, o.number, o.customer_email, o.shipping_name, o.currency, o.total_cents, COALESCE(o.amount_paid_cents, 0) AS paid_cents FROM orders o
      WHERE o.status = 'pending' AND COALESCE(o.amount_paid_cents, 0) < o.total_cents AND o.id NOT IN (SELECT order_id FROM ms_schedules)
      ${q ? `AND (o.number LIKE ? OR o.customer_email LIKE ? OR o.shipping_name LIKE ?)` : ''} ORDER BY o.created_at DESC LIMIT 20`, q ? [like(q), like(q), like(q)] : []);
  return c.json({ items });
});

app.get('/order/:orderId', async (c) => {
  const db = getDb(c.var.db); const order = await getOrder(db, c.req.param('orderId'));
  const v = await view(db, order); if (!v) throw ApiError.notFound('This order has no schedule');
  const pay = payUrl(storeBase(c.env as any), order.locale, await ensurePayToken(db, order));
  return c.json({ ...v, customer_email: order.customer_email, customer_name: order.shipping_name ?? null, pay_url: pay });
});

const StageBody = z.object({ label: z.string().trim().min(1).max(80), amount_cents: z.number().int().min(1).max(1_000_000_000_000).optional(), percent: z.number().min(0.01).max(100).optional(), expected_on: z.string().nullable().optional() });
const ScheduleBody = z.object({ stages: z.array(StageBody).min(2).max(12), note: z.string().trim().max(500).nullable().optional() });

app.put('/order/:orderId', async (c) => {
  const db = getDb(c.var.db); const id = c.req.param('orderId'); const b = await body(c, ScheduleBody);
  const r = await saveSchedule(db, ctxOf(c), id, b.stages, b.note ?? null);
  await audit(db, { action: r.created ? 'milestones.create' : 'milestones.update', target: id, meta: { stages: b.stages.length }, ...actor(c) });
  return c.json({ ok: true, ...r }, r.created ? 201 : 200);
});

app.delete('/order/:orderId', async (c) => {
  const db = getDb(c.var.db); const id = c.req.param('orderId'); await getOrder(db, id);
  await removeSchedule(db, id);
  await audit(db, { action: 'milestones.delete', target: id, ...actor(c) });
  return c.json({ ok: true });
});

app.post('/order/:orderId/request', async (c) => {
  const db = getDb(c.var.db); const id = c.req.param('orderId');
  const b = await body(c, z.object({ send: z.boolean().optional() }).default({}));
  const r = await requestStage(db, ctxOf(c), id, b.send !== false);
  await audit(db, { action: 'milestones.request', target: id, meta: { pos: r.pos }, ...actor(c) });
  return c.json(r);
});

export const msAdmin = app;
