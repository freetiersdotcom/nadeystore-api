// Admin API of the quotations module, mounted at /v1/m/quotes (sign-in and role are checked by the framework).
//   GET    /                 list (?status=draft|sent|accepted|declined|converted|expired)
//   POST   /                 create
//   GET    /:id              one quote
//   PATCH  /:id              edit (not once accepted/converted)
//   POST   /:id/send         mark as sent, e-mail the link when there is an address and an e-mail provider
//   POST   /:id/converted    { order_id } remember which order an accepted quote became
//   DELETE /:id              delete a draft, declined or expired quote
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db';
import { ApiError, uuid, now, type HonoEnv } from '../../types';
import { getEmailProvider } from '../../lib/email/index';
import { audit } from '../../auth/service';
import { quotePrintHtml } from './public';
import { getShopProfile } from '../../routes/shop';
import { effectiveStatus, formatQuote, money, newToken, publicUrl, resolveItems, totalOf, type QuoteRow } from './lib';

const app = new Hono<HonoEnv>();

const Line = z.object({ sku: z.string().min(1).max(64), qty: z.number().int().min(1).max(9999), unit_price_cents: z.number().int().min(0).optional(), title: z.string().max(200).optional() });
const Fields = {
  customer_name: z.string().trim().max(200).optional(),
  customer_email: z.string().trim().email().max(200).optional().or(z.literal('')),
  customer_phone: z.string().trim().max(40).optional(),
  note: z.string().trim().max(2000).optional(),
  locale: z.enum(['fr', 'en']).optional(),
};
const CreateBody = z.object({ ...Fields, currency: z.string().regex(/^[A-Za-z]{3}$/), items: z.array(Line).min(1).max(100), valid_days: z.number().int().min(1).max(365).default(14) });
const UpdateBody = z.object({ ...Fields, items: z.array(Line).min(1).max(100).optional(), valid_days: z.number().int().min(1).max(365).optional() });

const origin = (c: any) => new URL(c.req.url).origin;
const actor = (c: any) => { const a = c.get('auth'); return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null }; };
async function body<T extends z.ZodTypeAny>(c: any, schema: T): Promise<z.infer<T>> {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
async function load(c: any, id: string): Promise<QuoteRow> {
  const [q] = await getDb(c.var.db).query<QuoteRow>(`SELECT * FROM quotes WHERE id = ?`, [id]);
  if (!q) throw ApiError.notFound('Quote not found');
  return q;
}
const validUntil = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

app.get('/', async (c) => {
  const status = c.req.query('status');
  const rows = await getDb(c.var.db).query<QuoteRow>(`SELECT * FROM quotes ORDER BY seq DESC LIMIT 500`);
  const items = rows.map((q) => formatQuote(q, origin(c))).filter((q) => !status || q.status === status);
  return c.json({ items });
});

app.post('/', async (c) => {
  const b = await body(c, CreateBody);
  const db = getDb(c.var.db);
  let items; try { items = await resolveItems(db, b.items); } catch (e) { throw ApiError.invalidRequest(e instanceof Error ? e.message : 'Invalid items'); }
  const [{ n }] = await db.query<{ n: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM quotes`);
  const id = uuid(); const ts = now();
  await db.run(
    `INSERT INTO quotes (id, seq, number, token, status, customer_name, customer_email, customer_phone, currency, locale, items, total_cents, note, valid_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, n, `Q-${String(n).padStart(4, '0')}`, newToken(), b.customer_name || null, b.customer_email || null, b.customer_phone || null, b.currency.toUpperCase(), b.locale ?? 'fr',
     JSON.stringify(items), totalOf(items), b.note || null, validUntil(b.valid_days), ts, ts]
  );
  await audit(db, { action: 'quote.created', ...actor(c), target: `Q-${String(n).padStart(4, '0')}` });
  return c.json(formatQuote(await load(c, id), origin(c)), 201);
});

app.get('/:id', async (c) => c.json(formatQuote(await load(c, c.req.param('id')), origin(c))));

// The quote as a printable page, for the admin to print or save as PDF (works on a draft, which has no public page yet).
app.get('/:id/print', async (c) => {
  const q = await load(c, c.req.param('id'));
  const lang = c.req.query('lang') === 'en' ? 'en' : c.req.query('lang') === 'fr' ? 'fr' : q.locale === 'en' ? 'en' : 'fr';
  c.header('Cache-Control', 'no-store');
  return c.json({ html: quotePrintHtml(q, lang, await getShopProfile(getDb(c.var.db), c.env.STORE_NAME)) });
});

app.patch('/:id', async (c) => {
  const q = await load(c, c.req.param('id'));
  if (q.status === 'accepted' || q.status === 'converted') throw ApiError.conflict('An accepted quote can no longer be edited. Create a new one.');
  const b = await body(c, UpdateBody);
  const db = getDb(c.var.db);
  const sets: string[] = []; const params: unknown[] = [];
  const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); params.push(v); };
  if (b.customer_name !== undefined) set('customer_name', b.customer_name || null);
  if (b.customer_email !== undefined) set('customer_email', b.customer_email || null);
  if (b.customer_phone !== undefined) set('customer_phone', b.customer_phone || null);
  if (b.note !== undefined) set('note', b.note || null);
  if (b.locale !== undefined) set('locale', b.locale);
  if (b.items) {
    let items; try { items = await resolveItems(db, b.items); } catch (e) { throw ApiError.invalidRequest(e instanceof Error ? e.message : 'Invalid items'); }
    set('items', JSON.stringify(items)); set('total_cents', totalOf(items));
  }
  if (b.valid_days !== undefined) set('valid_until', validUntil(b.valid_days));
  // Changing a quote the customer already saw puts it back to draft: they must be sent the new version.
  if (sets.length && (q.status === 'sent' || q.status === 'declined')) set('status', 'draft');
  if (sets.length) { set('updated_at', now()); await db.run(`UPDATE quotes SET ${sets.join(', ')} WHERE id = ?`, [...params, q.id]); }
  return c.json(formatQuote(await load(c, q.id), origin(c)));
});

app.post('/:id/send', async (c) => {
  const q = await load(c, c.req.param('id'));
  if (q.status === 'accepted' || q.status === 'converted') throw ApiError.conflict('This quote was already accepted.');
  const db = getDb(c.var.db);
  if (q.valid_until < new Date().toISOString()) {
    await db.run(`UPDATE quotes SET valid_until = ?, updated_at = ? WHERE id = ?`, [validUntil(14), now(), q.id]); // an expired quote sent again gets a fresh 14 days
    q.valid_until = validUntil(14);
  }
  await db.run(`UPDATE quotes SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`, [now(), now(), q.id]);

  let emailed = false; let emailError: string | null = null;
  if (q.customer_email) {
    try {
      const provider = await getEmailProvider(db);
      if (provider) {
        const lang = q.locale === 'en' ? 'en' : 'fr';
        const store = c.env.STORE_NAME ?? '';
        const url = publicUrl(origin(c), q.token);
        const total = money(q.total_cents, q.currency, lang);
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const t = lang === 'en'
          ? { subject: `Your quotation ${q.number}${store ? ` — ${store}` : ''}`, hello: q.customer_name ? `Hello ${q.customer_name},` : 'Hello,', body: `Here is your quotation ${q.number} for <strong>${total}</strong>.`, cta: 'View and answer the quotation', until: 'Valid until' }
          : { subject: `Votre devis ${q.number}${store ? ` — ${store}` : ''}`, hello: q.customer_name ? `Bonjour ${q.customer_name},` : 'Bonjour,', body: `Voici votre devis ${q.number} d’un montant de <strong>${total}</strong>.`, cta: 'Consulter et répondre au devis', until: 'Valable jusqu’au' };
        const until = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'long' }).format(new Date(q.valid_until));
        await provider.send({
          to: q.customer_email, subject: t.subject,
          html: `<div style="font-family:system-ui,sans-serif;max-width:520px"><p>${esc(t.hello)}</p><p>${t.body}</p><p style="color:#666">${t.until} ${until}</p><p><a href="${url}" style="display:inline-block;background:#0F6B4B;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${t.cta}</a></p></div>`,
          text: `${t.hello}\n${t.body.replace(/<[^>]+>/g, '')}\n${t.until} ${until}\n${url}`,
        });
        emailed = true;
      }
    } catch (e) { emailError = e instanceof Error ? e.message : 'The e-mail could not be sent'; }
  }
  await audit(db, { action: 'quote.sent', ...actor(c), target: q.number, meta: { emailed } });
  return c.json({ ...formatQuote(await load(c, q.id), origin(c)), emailed, email_error: emailError });
});

app.post('/:id/converted', async (c) => {
  const q = await load(c, c.req.param('id'));
  const { order_id } = await body(c, z.object({ order_id: z.string().min(1).max(64) }));
  const db = getDb(c.var.db);
  const [o] = await db.query<{ id: string }>(`SELECT id FROM orders WHERE id = ?`, [order_id]);
  if (!o) throw ApiError.invalidRequest('That order does not exist.');
  if (q.status === 'converted' && q.order_id !== order_id) throw ApiError.conflict('This quote already became another order.');
  if (effectiveStatus(q) !== 'accepted' && q.status !== 'converted') throw ApiError.conflict('Only an accepted quote can become an order.');
  await db.run(`UPDATE quotes SET status = 'converted', order_id = ?, updated_at = ? WHERE id = ?`, [order_id, now(), q.id]);
  await audit(db, { action: 'quote.converted', ...actor(c), target: q.number, meta: { order_id } });
  return c.json(formatQuote(await load(c, q.id), origin(c)));
});

app.delete('/:id', async (c) => {
  const q = await load(c, c.req.param('id'));
  const st = effectiveStatus(q);
  if (st === 'accepted' || st === 'converted') throw ApiError.conflict('An accepted quote is kept as a record.');
  if (st === 'sent') throw ApiError.conflict('The customer may still answer this quote. Edit it (it goes back to draft) before deleting.');
  await getDb(c.var.db).run(`DELETE FROM quotes WHERE id = ?`, [q.id]);
  await audit(getDb(c.var.db), { action: 'quote.deleted', ...actor(c), target: q.number });
  return c.json({ deleted: true });
});

export { app as quoteAdmin };
