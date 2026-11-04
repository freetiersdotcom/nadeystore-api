// Push notifications for the installed admin app.
//   GET    /v1/push/key         the public key the browser needs to subscribe
//   POST   /v1/push/subscribe   { endpoint, keys: { p256dh, auth }, locale? }   register this device for the signed-in person
//   DELETE /v1/push/subscribe   { endpoint }                                    stop notifications on this device
//   POST   /v1/push/test        send a test notification to the signed-in person's devices
// Tied to a person (not an API key), so only a signed-in session may use it.
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { ensurePushTables, getVapid, isPushEndpoint, rememberSubject, sendPush, subjectFor, unb64u } from '../lib/push';

const app = new Hono<HonoEnv>();

function me(c: any): { id: string; role: string } {
  const user = c.get('auth')?.user;
  if (!user?.id) throw ApiError.forbidden('Notifications are tied to a signed-in person, not an API key.');
  return { id: user.id, role: user.role };
}

app.get('/key', async (c) => {
  me(c);
  const db = getDb(c.var.db);
  return c.json({ public_key: (await getVapid(db)).publicKey });
});

const Sub = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: z.string().min(80).max(120), auth: z.string().min(16).max(40) }),
  locale: z.enum(['fr', 'en']).optional(),
});

app.post('/subscribe', async (c) => {
  const u = me(c);
  const r = Sub.safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  const b = r.data;
  if (!isPushEndpoint(b.endpoint)) throw ApiError.invalidRequest('endpoint: not a browser push service address');
  try { if (unb64u(b.keys.p256dh).length !== 65 || unb64u(b.keys.auth).length !== 16) throw new Error('size'); } catch { throw ApiError.invalidRequest('keys: invalid'); }
  const db = getDb(c.var.db);
  await ensurePushTables(db);
  // The same device may be handed to another person: the endpoint is unique, the latest sign-in owns it.
  await db.run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, locale, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, locale = excluded.locale, fail_count = 0`,
    [uuid(), u.id, b.endpoint, b.keys.p256dh, b.keys.auth, b.locale ?? 'fr', now()]
  );
  await rememberSubject(db, c.env);
  return c.json({ subscribed: true }, 201);
});

app.delete('/subscribe', async (c) => {
  const u = me(c);
  const r = z.object({ endpoint: z.string().max(2048) }).safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw ApiError.invalidRequest('endpoint is required');
  const db = getDb(c.var.db);
  await ensurePushTables(db);
  await db.run(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`, [r.data.endpoint, u.id]);
  return c.json({ subscribed: false });
});

app.post('/test', async (c) => {
  const u = me(c);
  const db = getDb(c.var.db);
  await ensurePushTables(db);
  await rememberSubject(db, c.env);
  const subs = await db.query<any>(`SELECT * FROM push_subscriptions WHERE user_id = ?`, [u.id]);
  if (!subs.length) throw ApiError.invalidRequest('No device is subscribed yet.');
  const v = await getVapid(db);
  let sent = 0;
  for (const s of subs) {
    const en = s.locale === 'en';
    if (await sendPush(db, v, subjectFor(c.env), s, { title: en ? 'Notifications are on' : 'Les notifications sont activées', body: en ? 'You will be told here when an order arrives.' : 'Vous serez prévenu ici dès qu’une commande arrive.', url: '/#orders', tag: 'test' })) sent++;
  }
  return c.json({ devices: subs.length, sent });
});

export { app as pushApp };
