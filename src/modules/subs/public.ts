// Public side of the subscriptions module, mounted at /m/subs (no login, rate-limited).
//   GET  /plans?sku=SKU          the plans a visitor can choose for a product
//   POST /attach                 { cart_id, plan_id }  this cart starts a subscription once its order is paid (sets the plan price on that line)
//   GET  /manage/:token          the customer's private page: pause, skip, resume, stop
//   POST /manage/:token/:action  pause | resume | skip | cancel
import { Hono } from 'hono';
import { getDb } from '../../db';
import { now, type HonoEnv } from '../../types';
import { payUrl } from '../../lib/email/planNotice';
import { storeBase } from '../../lib/plans';
import { isZeroDecimal } from '../../lib/currency';
import { act, rememberOrigin, type Action, type Plan, type Sub } from './lib';

const app = new Hono<HonoEnv>();
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

app.get('/plans', async (c) => {
  c.header('Cache-Control', 'public, max-age=60');
  const sku = (c.req.query('sku') ?? '').trim(); if (!sku) return c.json({ items: [] });
  const items = await getDb(c.var.db).query(`SELECT p.id, p.name, p.unit, p.every_n, p.price_cents, p.max_cycles, v.currency FROM sub_plans p JOIN variants v ON v.sku = p.sku WHERE p.sku = ? AND p.active = 1 AND v.status = 'active' ORDER BY p.price_cents`, [sku]);
  return c.json({ items });
});

app.post('/attach', async (c) => {
  const b = await c.req.json().catch(() => null) as { cart_id?: string; plan_id?: string } | null;
  const cartId = String(b?.cart_id ?? ''); const planId = String(b?.plan_id ?? '');
  if (cartId.length < 8 || !planId) return c.json({ error: { code: 'invalid_request', message: 'cart_id and plan_id are required' } }, 400);
  const db = getDb(c.var.db);
  const [plan] = await db.query<Plan & { currency: string }>(`SELECT p.*, v.currency FROM sub_plans p JOIN variants v ON v.sku = p.sku WHERE p.id = ? AND p.active = 1`, [planId]);
  const [cart] = await db.query<any>(`SELECT id, status, currency FROM carts WHERE id = ?`, [cartId]);
  if (!plan || !cart || cart.status !== 'open') return c.json({ attached: false });
  const [line] = await db.query<any>(`SELECT id FROM cart_items WHERE cart_id = ? AND sku = ?`, [cartId, plan.sku]);
  if (!line || (cart.currency && plan.currency && cart.currency !== plan.currency)) return c.json({ attached: false });
  await db.run(`UPDATE cart_items SET unit_price_cents = ? WHERE id = ?`, [plan.price_cents, line.id]);
  await db.run(`INSERT INTO sub_carts (cart_id, plan_id, created_at) VALUES (?, ?, ?) ON CONFLICT(cart_id) DO UPDATE SET plan_id = excluded.plan_id`, [cartId, plan.id, now()]);
  return c.json({ attached: true, price_cents: plan.price_cents });
});

// ── the customer's page ─────────────────────────────────────────────────────
const T = {
  fr: {
    title: 'Mon abonnement', every: (n: number, u: string) => (u === 'week' ? (n === 1 ? 'chaque semaine' : `toutes les ${n} semaines`) : n === 1 ? 'chaque mois' : `tous les ${n} mois`),
    status: { active: 'Actif', paused: 'En pause', canceled: 'Arrêté', ended: 'Terminé' }, next: 'Prochaine échéance', pay: 'Payer la commande en cours', unpaid: 'Une commande attend votre paiement.',
    pause: 'Mettre en pause', resume: 'Reprendre', skip: 'Sauter la prochaine commande', cancel: 'Arrêter l’abonnement', sure: 'Arrêter définitivement cet abonnement ?', yes: 'Oui, arrêter', back: 'Retour',
    done: { pause: 'Abonnement mis en pause.', resume: 'Abonnement repris : votre prochaine commande arrive très vite.', skip: 'La prochaine commande est sautée.', cancel: 'Abonnement arrêté.' }, none: 'Lien introuvable.', over: 'Cet abonnement est terminé.', paused: 'Faute de paiement, l’abonnement a été mis en pause.',
  },
  en: {
    title: 'My subscription', every: (n: number, u: string) => (u === 'week' ? (n === 1 ? 'every week' : `every ${n} weeks`) : n === 1 ? 'every month' : `every ${n} months`),
    status: { active: 'Active', paused: 'Paused', canceled: 'Stopped', ended: 'Finished' }, next: 'Next due date', pay: 'Pay the current order', unpaid: 'An order is waiting for your payment.',
    pause: 'Pause', resume: 'Resume', skip: 'Skip the next order', cancel: 'Stop the subscription', sure: 'Stop this subscription for good?', yes: 'Yes, stop it', back: 'Back',
    done: { pause: 'Subscription paused.', resume: 'Subscription resumed: your next order is coming right away.', skip: 'The next order is skipped.', cancel: 'Subscription stopped.' }, none: 'Link not found.', over: 'This subscription is over.', paused: 'It was not paid, so the subscription was paused.',
  },
};
const money = (cents: number, cur: string, l: 'fr' | 'en') => { const z = isZeroDecimal(cur); try { return new Intl.NumberFormat(l === 'en' ? 'en-GB' : 'fr-FR', { style: 'currency', currency: cur, minimumFractionDigits: z ? 0 : 2, maximumFractionDigits: z ? 0 : 2 }).format(z ? cents : cents / 100); } catch { return `${cents} ${cur}`; } };
const page = (l: 'fr' | 'en', inner: string, status = 200) => new Response(
  `<!doctype html><html lang="${l}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(T[l].title)}</title><style>body{font-family:system-ui,sans-serif;background:#f8f6f0;margin:0;padding:16px;color:#2B2B2B}main{max-width:480px;margin:32px auto;background:#fff;border:1px solid #e5e1d6;border-radius:12px;padding:24px}h1{font-size:20px;margin:0 0 12px}button,a.b{display:inline-block;background:#0F6B4B;color:#fff;border:0;border-radius:8px;padding:12px 16px;font-size:15px;text-decoration:none;margin:4px 4px 4px 0;cursor:pointer}button.g,a.g{background:#fff;color:#2B2B2B;border:1px solid #cfcab9}.m{color:#666;font-size:14px}</style></head><body><main>${inner}</main></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });

async function find(c: any) {
  const l: 'fr' | 'en' = c.req.query('lang') === 'en' ? 'en' : 'fr';
  const token = c.req.param('token'); const db = getDb(c.var.db);
  if (!TOKEN.test(token)) return { l, db, sub: null as Sub | null };
  await rememberOrigin(db, new URL(c.req.url).origin);
  const [sub] = await db.query<Sub>(`SELECT * FROM subscriptions WHERE token = ?`, [token]);
  return { l, db, sub: sub ?? null };
}
const form = (token: string, l: string, action: string, label: string, ghost = false, extra = '') => `<form method="post" action="/m/subs/manage/${encodeURIComponent(token)}/${action}?lang=${l}" style="display:inline">${extra}<button type="submit"${ghost ? ' class="g"' : ''}>${esc(label)}</button></form>`;

async function render(c: any, sub: Sub, l: 'fr' | 'en', note = '') {
  const t = T[l]; const db = getDb(c.var.db);
  const [open] = await db.query<any>(`SELECT o.pay_token FROM sub_orders so JOIN orders o ON o.id = so.order_id WHERE so.sub_id = ? AND so.closed IS NULL AND o.status = 'pending' LIMIT 1`, [sub.id]);
  const dateOf = (iso: string) => new Intl.DateTimeFormat(l === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso));
  const live = sub.status === 'active' || sub.status === 'paused';
  let h = `<h1>${esc(t.title)}</h1>${note ? `<p><strong>${esc(note)}</strong></p>` : ''}<p><strong>${esc(sub.qty > 1 ? sub.qty + ' × ' : '')}${esc(sub.title)}</strong><br>${esc(money(sub.unit_price_cents * sub.qty, sub.currency, l))} · ${esc(t.every(sub.every_n, sub.unit))}</p>`;
  h += `<p class="m">${esc(t.status[sub.status])}${sub.status === 'paused' && sub.pause_reason === 'unpaid' ? ' — ' + esc(t.paused) : ''}${sub.status === 'active' ? `<br>${esc(t.next)} : ${esc(dateOf(sub.next_due_at))}` : ''}</p>`;
  if (open?.pay_token) h += `<p>${esc(t.unpaid)}</p><p><a class="b" href="${esc(payUrl(storeBase(c.env as any), l, open.pay_token))}">${esc(t.pay)}</a></p>`;
  if (!live) return page(l, h + `<p class="m">${esc(t.over)}</p>`);
  if (sub.status === 'active') h += form(sub.token, l, 'pause', t.pause, true) + form(sub.token, l, 'skip', t.skip, true);
  else h += form(sub.token, l, 'resume', t.resume);
  h += `<p><a class="g b" href="/m/subs/manage/${encodeURIComponent(sub.token)}?lang=${l}&amp;confirm=cancel">${esc(t.cancel)}</a></p>`;
  return page(l, h);
}

app.get('/manage/:token', async (c) => {
  const { l, sub } = await find(c); if (!sub) return page(l, `<p>${T[l].none}</p>`, 404);
  if (c.req.query('confirm') === 'cancel' && (sub.status === 'active' || sub.status === 'paused'))
    return page(l, `<h1>${esc(T[l].title)}</h1><p>${esc(T[l].sure)}</p>${form(sub.token, l, 'cancel', T[l].yes)}<a class="g b" href="/m/subs/manage/${encodeURIComponent(sub.token)}?lang=${l}">${esc(T[l].back)}</a>`);
  return render(c, sub, l);
});

app.post('/manage/:token/:action', async (c) => {
  const { l, db, sub } = await find(c); if (!sub) return page(l, `<p>${T[l].none}</p>`, 404);
  const action = c.req.param('action') as Action;
  if (!['pause', 'resume', 'skip', 'cancel'].includes(action)) return page(l, `<p>${T[l].none}</p>`, 404);
  const r = await act(db, sub, action);
  const [fresh] = await db.query<Sub>(`SELECT * FROM subscriptions WHERE id = ?`, [sub.id]);
  return render(c, fresh, l, r.ok ? T[l].done[action] : r.error);
});

export const subsPublic = app;
