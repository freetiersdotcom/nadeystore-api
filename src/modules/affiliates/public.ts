// Public side of the affiliates module, mounted at /m/affiliates (no login, rate-limited).
//   POST /attach     { cart_id, ref }  the storefront reports that this cart came from an affiliate link
//   GET  /a/:token                    the affiliate's own page: their link, what they earned, what was paid
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db';
import { now, type HonoEnv } from '../../types';
import { formatAffiliate, money, ordersOf, payoutsOf, syncAttribution, totalsOf, normCode, holdDays, type AffiliateRow, type CommissionState } from './lib';

const app = new Hono<HonoEnv>();
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const Attach = z.object({ cart_id: z.string().min(8).max(64), ref: z.string().min(1).max(40) });
app.post('/attach', async (c) => {
  const r = Attach.safeParse(await c.req.json().catch(() => null));
  if (!r.success) return c.json({ error: { code: 'invalid_request', message: 'cart_id and ref are required' } }, 400);
  const db = getDb(c.var.db);
  const [aff] = await db.query<{ id: string }>(`SELECT id FROM affiliates WHERE code = ? AND status = 'active'`, [normCode(r.data.ref)]);
  const [cart] = await db.query<{ id: string }>(`SELECT id FROM carts WHERE id = ? AND status = 'open'`, [r.data.cart_id]);
  if (!aff || !cart) return c.json({ attached: false });
  // The latest link a visitor used wins, until the cart becomes an order.
  await db.run(
    `INSERT INTO affiliate_referrals (cart_id, affiliate_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(cart_id) DO UPDATE SET affiliate_id = excluded.affiliate_id, created_at = excluded.created_at`,
    [cart.id, aff.id, now()]
  );
  return c.json({ attached: true });
});

const T = {
  fr: {
    title: 'Espace affilié', hello: 'Bonjour', link: 'Votre lien à partager', code: 'Votre code', rate: 'Commission', onSales: 'des ventes payées',
    available: 'À recevoir', pending: 'En attente', paid: 'Déjà versé', hold: (d: number) => `Une commission devient payable ${d} jour(s) après le paiement de la commande, le temps que d’éventuels remboursements passent.`,
    orders: 'Commandes', order: 'Commande', date: 'Date', status: 'Statut', commission: 'Commission', payouts: 'Versements', none: 'Rien pour le moment.', gone: 'Page introuvable.', paused: 'Votre compte est en pause : les nouveaux liens ne sont plus comptés.', other: 'English',
    st: { awaiting_payment: 'Paiement attendu', pending: 'En attente', available: 'Payable', canceled: 'Annulée' } as Record<CommissionState, string>,
  },
  en: {
    title: 'Affiliate page', hello: 'Hello', link: 'Your link to share', code: 'Your code', rate: 'Commission', onSales: 'of paid sales',
    available: 'To receive', pending: 'On hold', paid: 'Already paid', hold: (d: number) => `A commission becomes payable ${d} day(s) after the order is paid, so refunds have time to come through.`,
    orders: 'Orders', order: 'Order', date: 'Date', status: 'Status', commission: 'Commission', payouts: 'Payouts', none: 'Nothing yet.', gone: 'Page not found.', paused: 'Your account is paused: new visits are no longer counted.', other: 'Français',
    st: { awaiting_payment: 'Awaiting payment', pending: 'On hold', available: 'Payable', canceled: 'Canceled' } as Record<CommissionState, string>,
  },
};

const html = (body: string, lang: 'fr' | 'en', status = 200) => new Response(
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(T[lang].title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f8f6f0;color:#2b2b2b;margin:0;padding:16px}main{max-width:720px;margin:24px auto;background:#fff;border:1px solid #e5e1d6;border-radius:12px;padding:20px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px}.m{color:#666;font-size:14px}.box{background:#eef6f1;border:1px solid #cfe3d6;border-radius:8px;padding:10px 12px;margin:8px 0;word-break:break-all;font-family:ui-monospace,monospace;font-size:14px}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:12px 0}.k{border:1px solid #e5e1d6;border-radius:8px;padding:10px}.k b{display:block;font-size:18px}.k span{font-size:12px;color:#666;text-transform:uppercase}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-size:12px;text-transform:uppercase;color:#666;border-bottom:1px solid #e5e1d6;padding:6px 4px}td{padding:8px 4px;border-bottom:1px solid #f0ece2}td.n,th.n{text-align:right;white-space:nowrap}a{color:#0F6B4B}.w{background:#fff7e6;border:1px solid #f0d9a8;border-radius:8px;padding:10px;margin:10px 0}</style></head><body><main>${body}</main></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } }
);

app.get('/a/:token', async (c) => {
  const lang: 'fr' | 'en' = c.req.query('lang') === 'en' ? 'en' : 'fr';
  const t = T[lang];
  const token = c.req.param('token');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return html(`<p>${t.gone}</p>`, lang, 404);
  const db = getDb(c.var.db);
  const [a] = await db.query<AffiliateRow>(`SELECT * FROM affiliates WHERE token = ?`, [token]);
  if (!a) return html(`<p>${t.gone}</p>`, lang, 404);
  await syncAttribution(db);
  const orders = await ordersOf(db, a.id); const payouts = await payoutsOf(db, a.id);
  const totals = totalsOf(orders, payouts);
  const info = formatAffiliate(a, c.env.STORE_URL, new URL(c.req.url).origin);
  const hold = await holdDays(db);
  const other = lang === 'fr' ? 'en' : 'fr';
  const cards = totals.map((x) => `<div class="k"><span>${esc(t.available)} · ${esc(x.currency)}</span><b>${esc(money(Math.max(0, x.balance_cents), x.currency, lang))}</b></div>
    <div class="k"><span>${esc(t.pending)} · ${esc(x.currency)}</span><b>${esc(money(x.pending_cents, x.currency, lang))}</b></div>
    <div class="k"><span>${esc(t.paid)} · ${esc(x.currency)}</span><b>${esc(money(x.paid_out_cents, x.currency, lang))}</b></div>`).join('');
  const rows = orders.map((o) => `<tr><td>${esc(o.number)}</td><td>${esc(o.created_at.slice(0, 10))}</td><td>${esc(t.st[o.state])}</td><td class="n">${esc(money(o.commission_cents, o.currency, lang))}</td></tr>`).join('');
  const pays = payouts.map((p) => `<tr><td>${esc(p.created_at.slice(0, 10))}</td><td>${esc(p.method.replace('_', ' '))}${p.reference ? ' · ' + esc(p.reference) : ''}</td><td class="n">${esc(money(p.amount_cents, p.currency, lang))}</td></tr>`).join('');
  return html(`<p class="m"><a href="?lang=${other}">${esc(t.other)}</a></p>
    <h1>${esc(t.hello)} ${esc(a.name)}</h1><p class="m">${esc(t.rate)} : ${esc(a.rate_bp / 100)} % ${esc(t.onSales)}</p>
    ${a.status === 'paused' ? `<div class="w">${esc(t.paused)}</div>` : ''}
    <h2>${esc(t.link)}</h2><div class="box">${esc(info.link)}</div><p class="m">${esc(t.code)} : <b>${esc(a.code)}</b></p>
    <div class="g">${cards}</div><p class="m">${esc(t.hold(hold))}</p>
    <h2>${esc(t.orders)}</h2>${rows ? `<table><thead><tr><th>${esc(t.order)}</th><th>${esc(t.date)}</th><th>${esc(t.status)}</th><th class="n">${esc(t.commission)}</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="m">${esc(t.none)}</p>`}
    <h2>${esc(t.payouts)}</h2>${pays ? `<table><tbody>${pays}</tbody></table>` : `<p class="m">${esc(t.none)}</p>`}`, lang);
});

export { app as affiliatePublic };
