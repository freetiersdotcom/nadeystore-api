// Public side of the milestone payments module, mounted at /m/milestones (no login).
//   GET /pay/:token   the schedule of the order behind a pay link (the payment page shows it and pre-fills the amount due now)
import { Hono } from 'hono';
import { getDb } from '../../db';
import type { HonoEnv } from '../../types';
import { view } from './lib';

export const msPublic = new Hono<HonoEnv>();
const TOKEN = /^[A-Za-z0-9_-]{8,80}$/;

msPublic.get('/pay/:token', async (c) => {
  c.header('Cache-Control', 'no-store');
  const token = c.req.param('token');
  if (!TOKEN.test(token)) return c.json({ stages: [] });
  const db = getDb(c.var.db);
  const [order] = await db.query<any>(`SELECT * FROM orders WHERE pay_token = ? LIMIT 1`, [token]);
  if (!order) return c.json({ stages: [] });
  const v = await view(db, order);
  if (!v) return c.json({ stages: [] });
  return c.json({ currency: v.currency, total_cents: v.total_cents, paid_cents: v.paid_cents, due_now_cents: v.due_now_cents, note: v.note, stages: v.stages.map((s) => ({ pos: s.pos, label: s.label, amount_cents: s.amount_cents, expected_on: s.expected_on, status: s.status, paid_cents: s.paid_cents })) });
});
