// Public side of the offers module, mounted at /m/offers (no login, rate-limited).
//   GET  /match?skus=a,b&lang=fr&limit=3   the offers that fit a cart
//   POST /attach { cart_id, offer_ids }    confirm the offers a cart took (the shop sets the price); -> { attached, refused }
//   POST /seen   { offer_ids }             an offer was shown to a visitor (once per visit, for the report)
import { Hono } from 'hono';
import { getDb } from '../../db';
import type { HonoEnv } from '../../types';
import { attach, matchOffers, seen } from './lib';

export const offersPublic = new Hono<HonoEnv>();
const SKU = /^[A-Za-z0-9._-]{1,80}$/;
const ID = /^[A-Za-z0-9-]{8,64}$/;

offersPublic.get('/match', async (c) => {
  c.header('Cache-Control', 'no-store');
  const skus = (c.req.query('skus') ?? '').split(',').map((s) => s.trim()).filter((s) => SKU.test(s)).slice(0, 20);
  const lang = c.req.query('lang') === 'en' ? 'en' : 'fr';
  const limit = Math.min(3, Math.max(1, parseInt(c.req.query('limit') ?? '3', 10) || 3));
  return c.json({ items: await matchOffers(getDb(c.var.db), skus, lang, limit) });
});

offersPublic.post('/attach', async (c) => {
  const b = await c.req.json().catch(() => null) as { cart_id?: string; offer_ids?: unknown } | null;
  const cartId = String(b?.cart_id ?? ''); const ids = Array.isArray(b?.offer_ids) ? b!.offer_ids.map(String).filter((x) => ID.test(x)).slice(0, 5) : [];
  if (cartId.length < 8) return c.json({ error: { code: 'invalid_request', message: 'cart_id is required' } }, 400);
  return c.json(await attach(getDb(c.var.db), cartId, ids));
});

offersPublic.post('/seen', async (c) => {
  const b = await c.req.json().catch(() => null) as { offer_ids?: unknown } | null;
  const ids = Array.isArray(b?.offer_ids) ? b!.offer_ids.map(String).filter((x) => ID.test(x)) : [];
  await seen(getDb(c.var.db), ids);
  return c.json({ ok: true });
});
