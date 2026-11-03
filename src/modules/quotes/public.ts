// Public page of a quotation: /m/quotes/q/<token>. The long random token is the only credential:
// anyone holding the link can read this one quote and answer it. Nothing else is reachable from here.
import { Hono } from 'hono';
import { getDb } from '../../db';
import { audit } from '../../auth/service';
import { getEmailProvider } from '../../lib/email/index';
import { now, type HonoEnv } from '../../types';
import { effectiveStatus, money, parseItems, type QuoteRow } from './lib';

const app = new Hono<HonoEnv>();
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const T = {
  fr: {
    title: 'Devis', for: 'Pour', valid: 'Valable jusqu’au', item: 'Article', qty: 'Qté', price: 'Prix', total: 'Total', accept: 'Accepter le devis', decline: 'Refuser',
    note: 'Message', accepted: 'Merci ! Vous avez accepté ce devis. Nous revenons vers vous très vite pour la suite.',
    declined: 'Vous avez refusé ce devis. Si c’est une erreur, contactez-nous.', expired: 'Ce devis n’est plus valable. Contactez-nous pour en recevoir un nouveau.',
    draft: 'Ce devis n’est pas encore disponible.', converted: 'Ce devis a été accepté et transformé en commande. Merci !', gone: 'Devis introuvable.', other: 'English',
  },
  en: {
    title: 'Quotation', for: 'For', valid: 'Valid until', item: 'Item', qty: 'Qty', price: 'Price', total: 'Total', accept: 'Accept the quotation', decline: 'Decline',
    note: 'Message', accepted: 'Thank you! You accepted this quotation. We will get back to you shortly.',
    declined: 'You declined this quotation. If this is a mistake, please contact us.', expired: 'This quotation is no longer valid. Please contact us for a new one.',
    draft: 'This quotation is not available yet.', converted: 'This quotation was accepted and became an order. Thank you!', gone: 'Quotation not found.', other: 'Français',
  },
};

const page = (body: string, lang: 'fr' | 'en', status = 200) => new Response(
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(T[lang].title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f8f6f0;color:#2b2b2b;margin:0;padding:16px}main{max-width:640px;margin:24px auto;background:#fff;border:1px solid #e5e1d6;border-radius:12px;padding:20px}
h1{font-size:20px;margin:0 0 4px}.m{color:#666;font-size:14px}table{width:100%;border-collapse:collapse;margin:16px 0;font-size:15px}th{text-align:left;font-size:12px;text-transform:uppercase;color:#666;border-bottom:1px solid #e5e1d6;padding:6px 4px}td{padding:8px 4px;border-bottom:1px solid #f0ece2;vertical-align:top}
td.n,th.n{text-align:right;white-space:nowrap}.t{font-weight:700;font-size:17px}.msg{white-space:pre-wrap;border-left:3px solid #0F6B4B;padding:4px 12px;margin:12px 0}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}button{font:inherit;padding:12px 18px;border-radius:8px;border:1px solid #0F6B4B;cursor:pointer;min-height:44px}.y{background:#0F6B4B;color:#fff}.s{background:#fff;color:#0F6B4B}.info{background:#eef6f1;border:1px solid #cfe3d6;border-radius:8px;padding:12px;margin:12px 0}a{color:#0F6B4B}</style></head><body><main>${body}</main></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } }
);

async function find(c: any, token: string): Promise<QuoteRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [q] = await getDb(c.var.db).query<QuoteRow>(`SELECT * FROM quotes WHERE token = ?`, [token]);
  return q ?? null;
}
const pickLang = (c: any, q: QuoteRow | null): 'fr' | 'en' => (c.req.query('lang') === 'en' ? 'en' : c.req.query('lang') === 'fr' ? 'fr' : q?.locale === 'en' ? 'en' : 'fr');

function render(c: any, q: QuoteRow, lang: 'fr' | 'en', message?: string) {
  const t = T[lang]; const st = effectiveStatus(q); const items = parseItems(q);
  const until = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'long' }).format(new Date(q.valid_until));
  const store = c.env.STORE_NAME ?? '';
  const base = `/m/quotes/q/${q.token}`;
  const notice = message ?? (st === 'accepted' ? t.accepted : st === 'declined' ? t.declined : st === 'expired' ? t.expired : st === 'converted' ? t.converted : st === 'draft' ? t.draft : '');
  const body = `
    <div class="m">${esc(store)} · <a href="${base}?lang=${lang === 'en' ? 'fr' : 'en'}">${t.other}</a></div>
    <h1>${t.title} ${esc(q.number)}</h1>
    ${q.customer_name ? `<div class="m">${t.for} ${esc(q.customer_name)}</div>` : ''}
    ${notice ? `<div class="info">${esc(notice)}</div>` : ''}
    <table><thead><tr><th>${t.item}</th><th class="n">${t.qty}</th><th class="n">${t.price}</th></tr></thead><tbody>
    ${items.map((i) => `<tr><td>${esc(i.title)}</td><td class="n">${esc(i.qty)}</td><td class="n">${esc(money(i.unit_price_cents * i.qty, q.currency, lang))}</td></tr>`).join('')}
    </tbody><tfoot><tr><td colspan="2" class="t">${t.total}</td><td class="n t">${esc(money(q.total_cents, q.currency, lang))}</td></tr></tfoot></table>
    <div class="m">${t.valid} ${esc(until)}</div>
    ${q.note ? `<div class="msg">${esc(q.note)}</div>` : ''}
    ${st === 'sent' ? `<form method="post" class="row"><input type="hidden" name="lang" value="${lang}">
      <button class="y" formaction="${base}/accept">${t.accept}</button><button class="s" formaction="${base}/decline">${t.decline}</button></form>` : ''}`;
  return page(body, lang);
}

app.get('/q/:token', async (c) => {
  const q = await find(c, c.req.param('token'));
  const lang = pickLang(c, q);
  if (!q || q.status === 'draft') return page(`<p>${T[lang].gone}</p>`, lang, 404);
  return render(c, q, lang);
});

async function answer(c: any, decision: 'accepted' | 'declined') {
  const q = await find(c, c.req.param('token'));
  const lang = pickLang(c, q);
  if (!q || q.status === 'draft') return page(`<p>${T[lang].gone}</p>`, lang, 404);
  const db = getDb(c.var.db);
  if (effectiveStatus(q) === 'sent') {
    await db.run(`UPDATE quotes SET status = ?, responded_at = ?, updated_at = ? WHERE id = ? AND status = 'sent'`, [decision, now(), now(), q.id]);
    await audit(db, { action: `quote.${decision}`, actor: q.customer_email || q.customer_name || 'customer', target: q.number, ip: c.req.header('CF-Connecting-IP') ?? null });
    // Tell the merchant (best effort: the answer is saved whatever happens here).
    const to = c.env.CONTACT_NOTIFY_EMAIL;
    if (to) {
      try {
        const provider = await getEmailProvider(db);
        await provider?.send({ to, subject: `Devis ${q.number} ${decision === 'accepted' ? 'accepté' : 'refusé'}`, html: `<p>Le devis <strong>${esc(q.number)}</strong> (${esc(q.customer_name || q.customer_email || '')}) a été ${decision === 'accepted' ? 'accepté' : 'refusé'} par le client.</p>` });
      } catch { /* ignore */ }
    }
  }
  const [fresh] = await db.query<QuoteRow>(`SELECT * FROM quotes WHERE id = ?`, [q.id]);
  return render(c, fresh, lang);
}
app.post('/q/:token/accept', (c) => answer(c, 'accepted'));
app.post('/q/:token/decline', (c) => answer(c, 'declined'));

export { app as quotePublic };
