// Public side of the abandoned-cart module, mounted at /m/recovery (no login, rate-limited).
//   GET  /resume/:token   what to put back in the cart (live prices; items no longer sold are left out)
//   GET  /stop/:token     "stop these reminders" page (nothing changes until the button is pressed)
//   POST /stop/:token     opt out this e-mail address for good
import { Hono } from 'hono';
import { getDb } from '../../db';
import { now, type HonoEnv } from '../../types';
import { rememberOrigin, type RecRow, type Snap } from './lib';

const app = new Hono<HonoEnv>();
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

app.get('/resume/:token', async (c) => {
  c.header('Cache-Control', 'no-store');
  const token = c.req.param('token');
  if (!TOKEN.test(token)) return c.json({ items: [] });
  const db = getDb(c.var.db);
  const [r] = await db.query<RecRow>(`SELECT * FROM recovery_carts WHERE token = ?`, [token]);
  if (!r) return c.json({ items: [] });
  const snap: Snap[] = JSON.parse(r.items_json); const items = [];
  for (const s of snap) {
    const [v] = await db.query<any>(
      `SELECT v.sku, v.title AS variant_title, v.price_cents, v.image_url AS vimg, v.product_type, p.title AS product_title, p.image_url AS pimg
         FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ? AND v.status = 'active' AND p.status = 'active'`, [s.sku]);
    if (!v) continue;
    items.push({ sku: v.sku, title: v.product_title, variant_title: v.variant_title === 'Default' ? '' : v.variant_title, price_cents: v.price_cents, product_type: v.product_type ?? 'physical', image_url: v.vimg ?? v.pimg ?? null, qty: s.qty });
  }
  if (!r.resumed_at) await db.run(`UPDATE recovery_carts SET resumed_at = ? WHERE token = ?`, [now(), token]);
  return c.json({ items });
});

const T = {
  fr: { title: 'Rappels de panier', ask: 'Ne plus recevoir de rappels de panier ?', yes: 'Oui, me désinscrire', done: 'C’est fait : vous ne recevrez plus ces rappels.', none: 'Lien introuvable.' },
  en: { title: 'Cart reminders', ask: 'Stop receiving cart reminders?', yes: 'Yes, unsubscribe me', done: 'Done: you will not receive these reminders any more.', none: 'Link not found.' },
};
const page = (lang: 'fr' | 'en', inner: string, status = 200) => new Response(
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(T[lang].title)}</title><style>body{font-family:system-ui,sans-serif;background:#f8f6f0;margin:0;padding:16px}main{max-width:480px;margin:40px auto;background:#fff;border:1px solid #e5e1d6;border-radius:12px;padding:24px}button{background:#0F6B4B;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:15px}</style></head><body><main>${inner}</main></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });

async function find(c: any) {
  const lang: 'fr' | 'en' = c.req.query('lang') === 'en' ? 'en' : 'fr';
  const token = c.req.param('token');
  if (!TOKEN.test(token)) return { lang, row: null };
  const db = getDb(c.var.db); await rememberOrigin(db, new URL(c.req.url).origin);
  const [row] = await db.query<RecRow>(`SELECT * FROM recovery_carts WHERE token = ?`, [token]);
  return { lang, row: row ?? null, db };
}

app.get('/stop/:token', async (c) => {
  const { lang, row } = await find(c);
  if (!row) return page(lang, `<p>${T[lang].none}</p>`, 404);
  return page(lang, `<h1 style="font-size:20px">${T[lang].title}</h1><p>${T[lang].ask}</p><form method="post"><button type="submit">${T[lang].yes}</button></form>`);
});

app.post('/stop/:token', async (c) => {
  const { lang, row, db } = await find(c);
  if (!row || !db) return page(lang, `<p>${T[lang].none}</p>`, 404);
  await db.run(`INSERT OR IGNORE INTO recovery_optout (email, created_at) VALUES (?, ?)`, [row.email, now()]);
  await db.run(`UPDATE recovery_carts SET closed = 'optout' WHERE email = ? AND closed IS NULL`, [row.email]);
  return page(lang, `<p>${T[lang].done}</p>`);
});

export { app as recoveryPublic };
