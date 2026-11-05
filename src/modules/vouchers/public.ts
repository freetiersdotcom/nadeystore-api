// Public side of the vouchers module, mounted at /m/vouchers (no login, rate-limited).
//   GET /by-cart/:cartId   what the buyer of this cart has received so far (the storefront shows it on the confirmation page)
//   GET /o/:token          the buyer's private page with their code(s)
// The cart id (given to the buyer at checkout) and the token are long random values: whoever holds one can read those codes, and only those.
import { Hono } from 'hono';
import { getDb } from '../../db';
import type { HonoEnv } from '../../types';
import { deliveryOf, reconcile, rememberOrigin } from './lib';

const app = new Hono<HonoEnv>();
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

type Status = 'none' | 'unpaid' | 'waiting' | 'ready' | 'withdrawn';

async function view(db: ReturnType<typeof getDb>, orderId: string, lang: 'fr' | 'en') {
  await reconcile(db, orderId);
  const d = await deliveryOf(db, orderId);
  if (!d) return { status: 'none' as Status, items: [] };
  const rows = await db.query<{ sku: string; instructions_fr: string | null; instructions_en: string | null }>(`SELECT sku, instructions_fr, instructions_en FROM voucher_plans`);
  const ins = new Map(rows.map((r) => [r.sku, (lang === 'en' ? r.instructions_en || r.instructions_fr : r.instructions_fr || r.instructions_en) ?? null]));
  const [o] = await db.query<{ status: string; paid: number; total: number }>(`SELECT status, COALESCE(amount_paid_cents, 0) AS paid, total_cents AS total FROM orders WHERE id = ?`, [orderId]);
  const paid = o.paid >= o.total && o.total > 0;
  const withdrawn = o.status === 'refunded' || o.status === 'canceled';
  const waiting = d.items.some((i) => i.waiting > 0);
  const status: Status = withdrawn ? 'withdrawn' : !paid ? 'unpaid' : waiting ? 'waiting' : 'ready';
  return {
    status,
    number: d.number,
    items: withdrawn || !paid ? [] : d.items.map((i) => ({ title: i.title, sku: i.sku, qty: i.qty, waiting: i.waiting, instructions: ins.get(i.sku) ?? null, codes: i.codes.map((c) => ({ username: c.username, password: c.password })) })),
  };
}

app.get('/by-cart/:cartId', async (c) => {
  const lang: 'fr' | 'en' = c.req.query('lang') === 'en' ? 'en' : 'fr';
  const cartId = c.req.param('cartId');
  c.header('Cache-Control', 'no-store');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(cartId)) return c.json({ status: 'none', items: [] });
  const db = getDb(c.var.db);
  const [o] = await db.query<{ id: string }>(`SELECT id FROM orders WHERE cart_id = ? LIMIT 1`, [cartId]);
  if (!o) return c.json({ status: 'none', items: [] });
  return c.json(await view(db, o.id, lang));
});

const T = {
  fr: { title: 'Votre accès WiFi', order: 'Commande', user: 'Identifiant', pass: 'Mot de passe', none: 'Introuvable.', waiting: 'Votre paiement est bien reçu. Votre code est en cours de préparation : revenez sur cette page dans quelques minutes.', waitingN: (n: number) => `${n} code(s) en cours de préparation, revenez dans quelques minutes.`,
        unpaid: 'Cette commande n’est pas encore payée en totalité.', withdrawn: 'Cette commande a été annulée ou remboursée : ses codes ne sont plus valables.', keep: 'Gardez ce code : il ne sera pas redonné.', other: 'English' },
  en: { title: 'Your WiFi access', order: 'Order', user: 'Username', pass: 'Password', none: 'Not found.', waiting: 'Your payment was received. Your code is being prepared: come back to this page in a few minutes.', waitingN: (n: number) => `${n} code(s) being prepared, come back in a few minutes.`,
        unpaid: 'This order is not fully paid yet.', withdrawn: 'This order was canceled or refunded: its codes are no longer valid.', keep: 'Keep this code: it will not be given again.', other: 'Français' },
};
const page = (inner: string, lang: 'fr' | 'en', status = 200) => new Response(
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(T[lang].title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f8f6f0;color:#2b2b2b;margin:0;padding:16px}main{max-width:560px;margin:24px auto;background:#fff;border:1px solid #e5e1d6;border-radius:12px;padding:20px}h1{font-size:20px;margin:0 0 4px}.m{color:#666;font-size:14px}
.code{font-family:ui-monospace,monospace;font-size:20px;background:#eef6f1;border:1px solid #cfe3d6;border-radius:8px;padding:12px;margin:10px 0;word-break:break-all;user-select:all}.code small{display:block;font-size:11px;color:#666;text-transform:uppercase;font-family:system-ui,sans-serif}
.ins{white-space:pre-wrap;border-left:3px solid #0F6B4B;padding:4px 12px;margin:12px 0}.w{background:#fff7e6;border:1px solid #f0d9a8;border-radius:8px;padding:12px;margin:12px 0}a{color:#0F6B4B}</style></head><body><main>${inner}</main></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE, 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } });

app.get('/o/:token', async (c) => {
  const lang: 'fr' | 'en' = c.req.query('lang') === 'en' ? 'en' : 'fr'; const t = T[lang]; const token = c.req.param('token');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return page(`<p>${t.none}</p>`, lang, 404);
  const db = getDb(c.var.db);
  await rememberOrigin(db, new URL(c.req.url).origin);
  const [vo] = await db.query<{ order_id: string }>(`SELECT order_id FROM voucher_orders WHERE token = ?`, [token]);
  if (!vo) return page(`<p>${t.none}</p>`, lang, 404);
  const v = await view(db, vo.order_id, lang);
  const other = lang === 'fr' ? 'en' : 'fr';
  let inner = `<p class="m"><a href="?lang=${other}">${esc(t.other)}</a></p><h1>${esc(t.title)}</h1><p class="m">${esc(t.order)} ${esc((v as any).number ?? '')}</p>`;
  if (v.status === 'withdrawn') inner += `<div class="w">${esc(t.withdrawn)}</div>`;
  else if (v.status === 'unpaid') inner += `<div class="w">${esc(t.unpaid)}</div>`;
  else {
    for (const it of v.items as any[]) {
      inner += `<h2 style="font-size:16px;margin:18px 0 0">${esc(it.title)}${it.qty > 1 ? ` × ${esc(it.qty)}` : ''}</h2>`;
      for (const code of it.codes) inner += `<div class="code"><small>${esc(t.user)}</small>${esc(code.username)}${code.password ? `<small style="margin-top:8px">${esc(t.pass)}</small>${esc(code.password)}` : ''}</div>`;
      if (it.waiting > 0) inner += `<div class="w">${esc(t.waitingN(it.waiting))}</div>`;
      if (it.instructions && it.codes.length) inner += `<div class="ins">${esc(it.instructions)}</div>`;
    }
    if (v.status === 'ready') inner += `<p class="m">${esc(t.keep)}</p>`;
  }
  return page(inner, lang);
});

export { app as voucherPublic };
