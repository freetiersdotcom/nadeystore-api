// Admin API of the low-stock module, mounted at /v1/m/lowstock.
//   GET    /                      settings, suppliers and every physical product with its level (lowest first)
//   PUT    /settings              { default_threshold, emails, push }
//   PUT    /items/:sku            { threshold|null, muted?, supplier_id|null, reorder_qty|null }
//   POST   /suppliers             { name, phone?, email?, note? }     PUT/DELETE /suppliers/:id
//   GET    /items/:sku/message    ?lang=fr|en   reorder text for the supplier (copy / WhatsApp)
//   POST   /check                 look now (announces what just crossed its threshold)
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db';
import { ApiError, now, uuid, type HonoEnv } from '../../types';
import { audit } from '../../auth/service';
import { getSettings, levels, parseEmails, reorderMessage, runCheck } from './lib';

const app = new Hono<HonoEnv>();
const actor = (c: any) => { const a = c.get('auth'); return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null }; };
async function body<T extends z.ZodTypeAny>(c: any, schema: T): Promise<z.infer<T>> {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
const supplier = z.object({ name: z.string().trim().min(1).max(80), phone: z.string().trim().max(30).nullable().optional(), email: z.string().trim().email().max(120).nullable().optional(), note: z.string().trim().max(300).nullable().optional() });

app.get('/', async (c) => {
  const db = getDb(c.var.db); const settings = await getSettings(db);
  const [items, suppliers] = await Promise.all([levels(db, settings), db.query(`SELECT id, name, phone, email, note FROM lowstock_suppliers ORDER BY name`)]);
  return c.json({ settings, suppliers, items });
});

app.put('/settings', async (c) => {
  const b = await body(c, z.object({ default_threshold: z.number().int().min(0).max(100000), emails: z.string().max(600), push: z.boolean() }));
  const db = getDb(c.var.db);
  const list = parseEmails(b.emails);
  await db.run(`UPDATE lowstock_settings SET default_threshold = ?, emails = ?, push = ? WHERE id = 1`, [b.default_threshold, list.join(', '), b.push ? 1 : 0]);
  await audit(db, { action: 'lowstock.settings', ...actor(c), target: 'settings' });
  return c.json(await getSettings(db));
});

app.put('/items/:sku', async (c) => {
  const sku = c.req.param('sku'); const db = getDb(c.var.db);
  const b = await body(c, z.object({ threshold: z.number().int().min(0).max(100000).nullable().optional(), muted: z.boolean().optional(), supplier_id: z.string().nullable().optional(), reorder_qty: z.number().int().min(1).max(1000000).nullable().optional() }));
  const [v] = await db.query(`SELECT 1 FROM variants WHERE sku = ?`, [sku]); if (!v) throw ApiError.notFound('No product variant has this SKU.');
  if (b.supplier_id) { const [s] = await db.query(`SELECT 1 FROM lowstock_suppliers WHERE id = ?`, [b.supplier_id]); if (!s) throw ApiError.invalidRequest('Unknown supplier.'); }
  const [cur] = await db.query<any>(`SELECT * FROM lowstock_items WHERE sku = ?`, [sku]);
  const next = { threshold: b.threshold !== undefined ? b.threshold : cur?.threshold ?? null, muted: b.muted !== undefined ? (b.muted ? 1 : 0) : cur?.muted ?? 0, supplier_id: b.supplier_id !== undefined ? b.supplier_id : cur?.supplier_id ?? null, reorder_qty: b.reorder_qty !== undefined ? b.reorder_qty : cur?.reorder_qty ?? null };
  await db.run(`INSERT INTO lowstock_items (sku, threshold, muted, supplier_id, reorder_qty) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(sku) DO UPDATE SET threshold = excluded.threshold, muted = excluded.muted, supplier_id = excluded.supplier_id, reorder_qty = excluded.reorder_qty`, [sku, next.threshold, next.muted, next.supplier_id, next.reorder_qty]);
  await db.run(`DELETE FROM lowstock_state WHERE sku = ?`, [sku]);   // a changed threshold re-arms the alert
  return c.json({ sku, ...next });
});

app.post('/suppliers', async (c) => {
  const b = await body(c, supplier); const db = getDb(c.var.db); const id = uuid();
  await db.run(`INSERT INTO lowstock_suppliers (id, name, phone, email, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, b.name, b.phone ?? null, b.email ?? null, b.note ?? null, now()]);
  return c.json({ id, ...b }, 201);
});
app.put('/suppliers/:id', async (c) => {
  const b = await body(c, supplier); const db = getDb(c.var.db); const id = c.req.param('id');
  const [s] = await db.query(`SELECT 1 FROM lowstock_suppliers WHERE id = ?`, [id]); if (!s) throw ApiError.notFound('Supplier not found');
  await db.run(`UPDATE lowstock_suppliers SET name = ?, phone = ?, email = ?, note = ? WHERE id = ?`, [b.name, b.phone ?? null, b.email ?? null, b.note ?? null, id]);
  return c.json({ id, ...b });
});
app.delete('/suppliers/:id', async (c) => {
  const db = getDb(c.var.db); const id = c.req.param('id');
  await db.run(`UPDATE lowstock_items SET supplier_id = NULL WHERE supplier_id = ?`, [id]);
  await db.run(`DELETE FROM lowstock_suppliers WHERE id = ?`, [id]);
  return c.json({ deleted: true });
});

app.get('/items/:sku/message', async (c) => {
  const db = getDb(c.var.db); const sku = c.req.param('sku');
  const r = (await levels(db)).find((x) => x.sku === sku); if (!r) throw ApiError.notFound('Product not found or not a stocked product.');
  const [s] = r.supplier_id ? await db.query<any>(`SELECT id, name, phone, email FROM lowstock_suppliers WHERE id = ?`, [r.supplier_id]) : [null];
  const lang = c.req.query('lang') === 'en' ? 'en' : 'fr';
  return c.json({ message: reorderMessage(r, s ?? null, (c.env as any).STORE_NAME ?? 'Your Store', lang), supplier: s ?? null });
});

app.post('/check', async (c) => c.json(await runCheck(getDb(c.var.db), (c.env as any).STORE_NAME ?? 'Your Store')));

export { app as lowstockAdmin };
