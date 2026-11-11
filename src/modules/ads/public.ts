// Public side of the ad-tracking module, mounted at /m/ads (no login, rate-limited).
//   GET  /config   → { meta_pixel_id, tiktok_pixel_id }
//   POST /attach   { cart_id, utm_source?, utm_medium?, utm_campaign?, utm_content?, utm_term?, click_id_type?, click_id?, landing?, referrer?, fbp?, ttp? }
// The storefront calls it before checkout, and only when the visitor accepted measurement cookies.
import { Hono } from 'hono';
import { getDb } from '../../db';
import { now, type HonoEnv } from '../../types';
import { normalizeAttribution, saveAttribution, clean } from './lib';
import { getPixelSettings } from './events';

const app = new Hono<HonoEnv>();

app.post('/attach', async (c) => {
  const b: any = await c.req.json().catch(() => null);
  const cartId = clean(b?.cart_id, 64);
  if (cartId.length < 8) return c.json({ error: { code: 'invalid_request', message: 'cart_id is required' } }, 400);
  const a = normalizeAttribution(b ?? {});
  if (!a) return c.json({ attached: false });
  const who = { ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0], ua: c.req.header('user-agent') };
  return c.json({ attached: await saveAttribution(getDb(c.var.db), cartId, a, now(), who) });
});

// The pixel ids the storefront needs to load its browser pixels (public by nature). Empty = that pixel is off.
app.get('/config', async (c) => {
  const s = await getPixelSettings(getDb(c.var.db));
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ meta_pixel_id: s.meta.pixel_id || null, tiktok_pixel_id: s.tiktok.pixel_id || null });
});

export const adsPublic = app;
