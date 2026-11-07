// Public page of a quotation: /m/quotes/q/<token>. The long random token is the only credential:
// anyone holding the link can read this one quote and answer it. Nothing else is reachable from here.
import { Hono } from 'hono';
import { getDb } from '../../db';
import { audit } from '../../auth/service';
import { getEmailProvider } from '../../lib/email/index';
import { now, type HonoEnv } from '../../types';
import { effectiveStatus, money, parseItems, type QuoteRow } from './lib';
import { getShopProfile, type ShopProfile } from '../../routes/shop';

const app = new Hono<HonoEnv>();
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const T = {
  fr: {
    title: 'Devis', print: 'Imprimer / PDF', taxId: 'N° fiscal', for: 'Pour', valid: 'Valable jusqu’au', item: 'Article', qty: 'Qté', price: 'Prix', total: 'Total', accept: 'Accepter le devis', decline: 'Refuser',
    note: 'Message', accepted: 'Merci ! Vous avez accepté ce devis. Nous revenons vers vous très vite pour la suite.',
    declined: 'Vous avez refusé ce devis. Si c’est une erreur, contactez-nous.', expired: 'Ce devis n’est plus valable. Contactez-nous pour en recevoir un nouveau.',
    draft: 'Ce devis n’est pas encore disponible.', converted: 'Ce devis a été accepté et transformé en commande. Merci !', gone: 'Devis introuvable.', other: 'English',
  },
  en: {
    title: 'Quotation', print: 'Print / PDF', taxId: 'Tax no.', for: 'For', valid: 'Valid until', item: 'Item', qty: 'Qty', price: 'Price', total: 'Total', accept: 'Accept the quotation', decline: 'Decline',
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
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}button{font:inherit;padding:12px 18px;border-radius:8px;border:1px solid #0F6B4B;cursor:pointer;min-height:44px}.y{background:#0F6B4B;color:#fff}.s{background:#fff;color:#0F6B4B}.info{background:#eef6f1;border:1px solid #cfe3d6;border-radius:8px;padding:12px;margin:12px 0}a{color:#0F6B4B}.hd{margin-bottom:12px;white-space:pre-line}@media print{body{background:#fff;padding:0}main{border:0;margin:0;max-width:none;padding:0}.noprint{display:none!important}}</style></head><body><main>${body}</main></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-n+8yxdUuJZ/P71SkgsMsCgeuh5JV4Di3c+/CadWu640='; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } }
);

async function find(c: any, token: string): Promise<QuoteRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [q] = await getDb(c.var.db).query<QuoteRow>(`SELECT * FROM quotes WHERE token = ?`, [token]);
  return q ?? null;
}
const pickLang = (c: any, q: QuoteRow | null): 'fr' | 'en' => (c.req.query('lang') === 'en' ? 'en' : c.req.query('lang') === 'fr' ? 'fr' : q?.locale === 'en' ? 'en' : 'fr');

const PRINT_SCRIPT = "document.getElementById('pr').addEventListener('click',function(){window.print()})";

/** The quote as a document: shop header, lines, total, validity, message. `interactive` adds the answer buttons and Print button. */
export function quoteBodyHtml(q: QuoteRow, lang: 'fr' | 'en', shop: ShopProfile, opts: { interactive: boolean; message?: string }) {
  const t = T[lang]; const st = effectiveStatus(q); const items = parseItems(q);
  const until = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'long' }).format(new Date(q.valid_until));
  const base = `/m/quotes/q/${q.token}`;
  const notice = opts.interactive ? (opts.message ?? (st === 'accepted' ? t.accepted : st === 'declined' ? t.declined : st === 'expired' ? t.expired : st === 'converted' ? t.converted : st === 'draft' ? t.draft : '')) : '';
  const contact = [shop.address, shop.phone, shop.email, shop.tax_id ? `${t.taxId}: ${shop.tax_id}` : ''].filter(Boolean).map(esc).join('\n');
  return `
    <div class="hd"><strong>${esc(shop.name)}</strong>${contact ? '\n<span class="m">' + contact + '</span>' : ''}${opts.interactive ? ` <span class="noprint m">· <a href="${base}?lang=${lang === 'en' ? 'fr' : 'en'}">${t.other}</a></span>` : ''}</div>
    <h1>${t.title} ${esc(q.number)}</h1>
    ${q.customer_name ? `<div class="m">${t.for} ${esc(q.customer_name)}</div>` : ''}
    ${notice ? `<div class="info">${esc(notice)}</div>` : ''}
    <table><thead><tr><th>${t.item}</th><th class="n">${t.qty}</th><th class="n">${t.price}</th></tr></thead><tbody>
    ${items.map((i) => `<tr><td>${esc(i.title)}</td><td class="n">${esc(i.qty)}</td><td class="n">${esc(money(i.unit_price_cents * i.qty, q.currency, lang))}</td></tr>`).join('')}
    </tbody><tfoot><tr><td colspan="2" class="t">${t.total}</td><td class="n t">${esc(money(q.total_cents, q.currency, lang))}</td></tr></tfoot></table>
    <div class="m">${t.valid} ${esc(until)}</div>
    ${q.note ? `<div class="msg">${esc(q.note)}</div>` : ''}
    ${opts.interactive && st === 'sent' ? `<form method="post" class="row noprint"><input type="hidden" name="lang" value="${lang}">
      <button class="y" formaction="${base}/accept">${t.accept}</button><button class="s" formaction="${base}/decline">${t.decline}</button></form>` : ''}
    ${opts.interactive && st !== 'draft' ? `<div class="row noprint"><button type="button" class="s" id="pr">${t.print}</button></div><script>${PRINT_SCRIPT}</script>` : ''}`;
}

/** A standalone printable page of the quote (no buttons, no script): used by the admin to print a draft. */
export function quotePrintHtml(q: QuoteRow, lang: 'fr' | 'en', shop: ShopProfile) {
  const t = T[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(t.title)} ${esc(q.number)}</title>
<style>@page{size:A4;margin:16mm}body{font-family:system-ui,Arial,sans-serif;color:#000;margin:0;font-size:14px;max-width:180mm}h1{font-size:22px;margin:12px 0 4px}.m{color:#333}.hd{white-space:pre-line}table{width:100%;border-collapse:collapse;margin:14px 0}
th{text-align:left;font-size:12px;text-transform:uppercase;border-bottom:1px solid #000;padding:4px 2px}td{padding:6px 2px;border-bottom:1px solid #ddd;vertical-align:top}td.n,th.n{text-align:right;white-space:nowrap}.t{font-weight:700;font-size:16px}.msg{white-space:pre-wrap;border-left:3px solid #000;padding:2px 10px;margin:12px 0}</style></head><body>${quoteBodyHtml(q, lang, shop, { interactive: false })}</body></html>`;
}

async function render(c: any, q: QuoteRow, lang: 'fr' | 'en', message?: string) {
  const shop = await getShopProfile(getDb(c.var.db), c.env.STORE_NAME);
  return page(quoteBodyHtml(q, lang, shop, { interactive: true, message }), lang);
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
