// ============================================================
// BULK IMPORT / EXPORT (CSV)
// ============================================================
// Products: one row per variant, grouped by `handle` (the product's slug).
//   handle,title,description,description_fr,description_en,tags,status,video_url,image_url,
//   sku,variant_title,price,weight_g,type,stock,variant_image_url
// - `price` is in major units (4500 or 19.99), in the currency chosen for the import.
// - Existing products are matched by handle, variants by sku. Nothing is ever deleted.
// - A row with only a sku and some columns (price, stock…) updates that variant: handy for price/stock sheets.
// - Empty cells never overwrite existing values.
// - The whole file is checked first; if anything is wrong nothing is written.

import type { Database } from '../db';
import { parseCsvObjects, safeText, toCsv } from './csv';
import { minorFactor } from './currency';
import { uuid, now } from '../types';
import { isWalkIn } from './walk-in';

export const PRODUCT_COLUMNS = ['handle', 'title', 'description', 'description_fr', 'description_en', 'tags', 'status', 'video_url', 'image_url',
  'sku', 'variant_title', 'price', 'weight_g', 'type', 'stock', 'variant_image_url'] as const;
const ALIASES: Record<string, string> = { slug: 'handle', variant_sku: 'sku', quantity: 'stock', stock_quantity: 'stock', variant_price: 'price', product_type: 'type', name: 'title' };
export const MAX_IMPORT_ROWS = 2000;

export function slugify(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

type ProductFields = { title?: string; description?: string; description_fr?: string; description_en?: string; tags?: string[]; status?: 'active' | 'draft'; video_url?: string; image_url?: string };
type VariantFields = { title?: string; price_cents?: number; weight_g?: number; product_type?: 'physical' | 'digital' | 'service'; image_url?: string };
export type ProductOp = { id: string | null; slug: string; create: boolean; fields: ProductFields; variants: VariantOp[]; lines: number[] };
export type VariantOp = { id: string | null; sku: string; create: boolean; fields: VariantFields; stock?: number; currentStock?: number; line: number };
export type ImportIssue = { line: number; message: string };
export type ImportPlan = {
  errors: ImportIssue[]; warnings: ImportIssue[]; ops: ProductOp[];
  summary: { rows: number; products_create: number; products_update: number; variants_create: number; variants_update: number; stock_changes: number };
};

const isUrl = (v: string) => /^(https?:\/\/|\/)\S{1,500}$/.test(v);

function parsePrice(raw: string, currency: string): { cents?: number; error?: string } {
  const s = raw.replace(/[\s ]/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return { error: 'price is not a number' };
  const n = Number(s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return { error: `price "${raw}" must be a positive number` };
  const f = minorFactor(currency);
  if (f === 1 && !Number.isInteger(n)) return { error: `${currency} has no decimals, but the price is "${raw}"` };
  return { cents: Math.round(n * f) };
}

export async function planProductImport(db: Database, csv: string, currency: string): Promise<ImportPlan> {
  const errors: ImportIssue[] = []; const warnings: ImportIssue[] = [];
  const empty = (): ImportPlan => ({ errors, warnings, ops: [], summary: { rows: 0, products_create: 0, products_update: 0, variants_create: 0, variants_update: 0, stock_changes: 0 } });
  let parsed;
  try { parsed = parseCsvObjects(csv, ALIASES); } catch (e) { errors.push({ line: 1, message: e instanceof Error ? e.message : 'The file could not be read.' }); return empty(); }
  const { headers, rows } = parsed;
  if (!rows.length) { errors.push({ line: 1, message: 'The file has no data rows.' }); return empty(); }
  if (!headers.includes('sku')) { errors.push({ line: 1, message: 'The file needs a "sku" column.' }); return empty(); }
  if (rows.length > MAX_IMPORT_ROWS) { errors.push({ line: 1, message: `Too many rows (${rows.length}). Import at most ${MAX_IMPORT_ROWS} at a time.` }); return empty(); }
  const known = new Set<string>(PRODUCT_COLUMNS);
  const unknown = headers.filter((h) => h && !known.has(h));
  if (unknown.length) warnings.push({ line: 1, message: `Ignored columns: ${unknown.join(', ')}` });

  // What already exists
  const existingProducts = new Map<string, { id: string; title: string }>();
  for (const p of await db.query<{ id: string; slug: string | null; title: string }>(`SELECT id, slug, title FROM products`)) if (p.slug) existingProducts.set(p.slug, p);
  const productById = new Map<string, { id: string; slug: string | null }>();
  for (const p of await db.query<{ id: string; slug: string | null }>(`SELECT id, slug FROM products`)) productById.set(p.id, p);
  const existingVariants = new Map<string, { id: string; product_id: string }>();
  for (const v of await db.query<{ id: string; sku: string; product_id: string }>(`SELECT id, sku, product_id FROM variants`)) existingVariants.set(v.sku, v);
  const stockBySku = new Map<string, { on_hand: number; reserved: number }>();
  for (const i of await db.query<{ sku: string; on_hand: number; reserved: number }>(`SELECT sku, on_hand, reserved FROM inventory`)) stockBySku.set(i.sku, i);

  const byKey = new Map<string, ProductOp>(); const order: ProductOp[] = [];
  const seenSku = new Map<string, number>();
  const err = (line: number, message: string) => errors.push({ line, message });

  for (const { line, data: d } of rows) {
    const sku = d.sku ?? '';
    if (!sku) { err(line, 'sku is empty'); continue; }
    if (sku.length > 64 || /[\u0000-\u001f]/.test(sku)) { err(line, `sku "${sku.slice(0, 20)}…" is not valid (64 characters at most)`); continue; }
    if (seenSku.has(sku)) { err(line, `sku "${sku}" appears twice in the file (first on line ${seenSku.get(sku)})`); continue; }
    seenSku.set(sku, line);

    const existingVariant = existingVariants.get(sku);
    const handleRaw = (d.handle ?? '') || (d.title ? slugify(d.title) : '');
    const handle = handleRaw ? slugify(handleRaw) : '';

    // Which product does the row belong to?
    let key: string; let existingProduct: { id: string; title?: string } | undefined;
    if (!handle) {
      if (!existingVariant) { err(line, `new sku "${sku}" needs a handle or a title`); continue; }
      existingProduct = productById.get(existingVariant.product_id);
      key = `id:${existingVariant.product_id}`;
    } else {
      existingProduct = existingProducts.get(handle);
      key = `slug:${handle}`;
      if (existingVariant && existingProduct && existingVariant.product_id !== existingProduct.id) {
        err(line, `sku "${sku}" already belongs to another product`); continue;
      }
      if (existingVariant && !existingProduct) { err(line, `sku "${sku}" already exists under a different product (handle "${handle}" is new)`); continue; }
    }

    let op = byKey.get(key);
    if (!op) {
      op = { id: existingProduct?.id ?? null, slug: handle || (existingProduct ? (productById.get(existingProduct.id)?.slug ?? '') : ''), create: !existingProduct, fields: {}, variants: [], lines: [] };
      byKey.set(key, op); order.push(op);
    }
    op.lines.push(line);
    const pf = op.fields;
    const setOnce = <K extends keyof ProductFields>(k: K, v: ProductFields[K]) => { if (pf[k] === undefined) pf[k] = v; };

    // Product fields (first non-empty value in the file wins)
    if (d.title) setOnce('title', d.title.slice(0, 200));
    if (d.description) setOnce('description', d.description.slice(0, 10000));
    if (d.description_fr) setOnce('description_fr', d.description_fr.slice(0, 10000));
    if (d.description_en) setOnce('description_en', d.description_en.slice(0, 10000));
    if (d.tags) {
      const tags = [...new Set(d.tags.split(/[;,|]/).map((t) => t.trim()).filter(Boolean))];
      if (tags.some((t) => t.length > 40) || tags.length > 20) err(line, 'tags: at most 20 tags of 40 characters');
      else setOnce('tags', tags);
    }
    if (d.status) {
      const s = d.status.toLowerCase();
      if (s !== 'active' && s !== 'draft') err(line, `status "${d.status}" must be active or draft`); else setOnce('status', s);
    }
    for (const k of ['video_url', 'image_url'] as const) if (d[k]) { if (!isUrl(d[k])) err(line, `${k} must be a web address (https://…)`); else setOnce(k, d[k]); }

    // Variant fields
    const vf: VariantFields = {};
    if (d.variant_title) vf.title = d.variant_title.slice(0, 200);
    let priceBad = false;
    if (d.price) { const p = parsePrice(d.price, currency); if (p.error) { err(line, p.error); priceBad = true; } else vf.price_cents = p.cents; }
    if (d.weight_g) {
      const w = Number(d.weight_g.replace(/\s/g, ''));
      if (!Number.isInteger(w) || w < 0) err(line, `weight_g "${d.weight_g}" must be a whole number of grams`); else vf.weight_g = w;
    }
    if (d.type) {
      const t = d.type.toLowerCase();
      if (t !== 'physical' && t !== 'digital' && t !== 'service') err(line, `type "${d.type}" must be physical, digital or service`); else vf.product_type = t;
    }
    if (d.variant_image_url) { if (!isUrl(d.variant_image_url)) err(line, 'variant_image_url must be a web address (https://…)'); else vf.image_url = d.variant_image_url; }
    let stock: number | undefined;
    if (d.stock) {
      const n = Number(d.stock.replace(/\s/g, ''));
      if (!Number.isInteger(n) || n < 0) err(line, `stock "${d.stock}" must be a whole number, 0 or more`); else stock = n;
    }

    if (!existingVariant) {
      if (vf.price_cents === undefined && !priceBad) err(line, `new sku "${sku}" needs a price`);
      if (op.create && !pf.title && op.lines.length === 1) err(line, `new product "${handle}" needs a title`);
    } else if (stock !== undefined) {
      const cur = stockBySku.get(sku);
      if (cur && stock < cur.reserved) err(line, `stock ${stock} is below the ${cur.reserved} units reserved by open orders`);
    }
    op.variants.push({ id: existingVariant?.id ?? null, sku, create: !existingVariant, fields: vf, stock, currentStock: stockBySku.get(sku)?.on_hand, line });
  }

  // A new product's title must come from some row of its group
  for (const op of order) if (op.create && !op.fields.title && !errors.some((e) => op.lines.includes(e.line))) err(op.lines[0], `new product "${op.slug}" needs a title`);

  const summary = {
    rows: rows.length,
    products_create: order.filter((o) => o.create).length,
    products_update: order.filter((o) => !o.create).length,
    variants_create: order.reduce((n, o) => n + o.variants.filter((v) => v.create).length, 0),
    variants_update: order.reduce((n, o) => n + o.variants.filter((v) => !v.create).length, 0),
    stock_changes: order.reduce((n, o) => n + o.variants.filter((v) => v.stock !== undefined && v.stock !== (v.create ? 0 : v.currentStock)).length, 0),
  };
  return { errors, warnings, ops: order, summary };
}

/** Write a plan that has no errors. Returns the counts actually applied. */
export async function applyProductImport(db: Database, plan: ImportPlan): Promise<ImportPlan['summary']> {
  if (plan.errors.length) throw new Error('The plan has errors.');
  const ts = now();
  for (const op of plan.ops) {
    let productId = op.id;
    if (op.create) {
      productId = uuid();
      const f = op.fields;
      await db.run(
        `INSERT INTO products (id, title, description, slug, description_fr, description_en, tags, video_url, image_url, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [productId, f.title, f.description ?? null, op.slug, f.description_fr ?? null, f.description_en ?? null, f.tags ? JSON.stringify(f.tags) : null, f.video_url ?? null, f.image_url ?? null, f.status ?? 'active', ts]
      );
    } else if (Object.keys(op.fields).length) {
      const sets: string[] = []; const params: unknown[] = [];
      for (const [k, v] of Object.entries(op.fields)) { sets.push(`${k} = ?`); params.push(k === 'tags' ? JSON.stringify(v) : v); }
      await db.run(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, [...params, productId]);
    }
    for (const v of op.variants) {
      if (v.create) {
        await db.run(
          `INSERT INTO variants (id, product_id, sku, title, price_cents, weight_g, image_url, product_type, digital_asset_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuid(), productId, v.sku, v.fields.title ?? op.fields.title ?? v.sku, v.fields.price_cents, v.fields.weight_g ?? 0, v.fields.image_url ?? null, v.fields.product_type ?? 'physical', null, ts]
        );
        await db.run(`INSERT INTO inventory (id, sku, on_hand, reserved, updated_at) VALUES (?, ?, ?, 0, ?)`, [uuid(), v.sku, v.stock ?? 0, ts]);
        if (v.stock) await db.run(`INSERT INTO inventory_logs (id, sku, delta, reason, created_at) VALUES (?, ?, ?, 'restock', ?)`, [uuid(), v.sku, v.stock, ts]);
      } else {
        const sets: string[] = []; const params: unknown[] = [];
        for (const [k, val] of Object.entries(v.fields)) { sets.push(`${k} = ?`); params.push(val); }
        if (sets.length) await db.run(`UPDATE variants SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...params, ts, v.id]);
        if (v.stock !== undefined && v.stock !== v.currentStock) {
          const before = v.currentStock ?? 0;
          const changed = await db.run(`UPDATE inventory SET on_hand = ?, updated_at = ? WHERE sku = ?`, [v.stock, ts, v.sku]);
          if (!changed.changes) await db.run(`INSERT INTO inventory (id, sku, on_hand, reserved, updated_at) VALUES (?, ?, ?, 0, ?)`, [uuid(), v.sku, v.stock, ts]);
          await db.run(`INSERT INTO inventory_logs (id, sku, delta, reason, created_at) VALUES (?, ?, ?, 'correction', ?)`, [uuid(), v.sku, v.stock - before, ts]);
        }
      }
    }
  }
  return plan.summary;
}

// ── Exports ────────────────────────────────────────────────────────────────

const major = (cents: number | null | undefined, currency: string) => {
  if (cents == null) return '';
  const f = minorFactor(currency);
  return f === 1 ? String(cents) : (cents / f).toFixed(2);
};

export async function exportProductsCsv(db: Database, currency: string): Promise<{ csv: string; rows: number }> {
  const rows = await db.query<any>(
    `SELECT p.slug, p.title, p.description, p.description_fr, p.description_en, p.tags, p.status, p.video_url, p.image_url,
            v.sku, v.title AS vtitle, v.price_cents, v.weight_g, v.product_type, v.image_url AS vimage, i.on_hand
       FROM products p JOIN variants v ON v.product_id = p.id LEFT JOIN inventory i ON i.sku = v.sku
      ORDER BY p.created_at, p.id, v.created_at, v.sku`
  );
  const seen = new Set<string>();
  const out = rows.map((r) => {
    const first = !seen.has(r.slug ?? r.title); seen.add(r.slug ?? r.title);
    let tags = ''; try { tags = r.tags ? (JSON.parse(r.tags) as string[]).join(';') : ''; } catch { tags = ''; }
    return [
      r.slug ?? '', first ? safeText(r.title) : '', first ? safeText(r.description) : '', first ? safeText(r.description_fr) : '', first ? safeText(r.description_en) : '',
      first ? safeText(tags) : '', first ? r.status ?? '' : '', first ? r.video_url ?? '' : '', first ? r.image_url ?? '' : '',
      safeText(r.sku), safeText(r.vtitle), major(r.price_cents, currency), r.weight_g ?? '', r.product_type ?? '',
      r.product_type && r.product_type !== 'physical' ? '' : r.on_hand ?? '', r.vimage ?? '',
    ];
  });
  return { csv: toCsv([...PRODUCT_COLUMNS], out), rows: out.length };
}

export async function exportOrdersCsv(db: Database, opts: { from?: string; to?: string; status?: string }): Promise<{ csv: string; rows: number }> {
  let sql = `SELECT * FROM orders WHERE 1 = 1`; const p: unknown[] = [];
  if (opts.from) { sql += ` AND created_at >= ?`; p.push(opts.from); }
  if (opts.to) { sql += ` AND created_at < ?`; p.push(opts.to.length === 10 ? opts.to + 'T23:59:59.999Z' : opts.to); }
  if (opts.status) { sql += ` AND status = ?`; p.push(opts.status); }
  sql += ` ORDER BY created_at DESC LIMIT 20000`;
  const orders = await db.query<any>(sql, p);
  const items = orders.length ? await db.query<any>(`SELECT order_id, sku, qty FROM order_items`) : [];
  const byOrder = new Map<string, string[]>();
  for (const it of items) { const a = byOrder.get(it.order_id) ?? []; a.push(`${it.sku} x${it.qty}`); byOrder.set(it.order_id, a); }
  const out = orders.map((o) => {
    let ship: any = {}; try { ship = o.ship_to ? JSON.parse(o.ship_to) : {}; } catch { ship = {}; }
    const cur = o.currency;
    return [
      o.number, o.created_at, o.status, o.payment_method ?? '', major(o.amount_paid_cents, cur), safeText(o.shipping_name),
      isWalkIn(o.customer_email) ? 'walk-in' : safeText(o.customer_email), safeText(o.shipping_phone), ship.country ?? '', safeText(ship.city),
      safeText((byOrder.get(o.id) ?? []).join('; ')), major(o.subtotal_cents, cur), major(o.shipping_cents, cur), safeText(o.shipping_label),
      safeText(o.discount_code), major(o.discount_amount_cents, cur), major(o.total_cents, cur), cur,
    ];
  });
  const headers = ['order', 'created_at', 'status', 'payment_method', 'amount_paid', 'customer_name', 'customer_email', 'phone', 'country', 'city',
    'items', 'subtotal', 'delivery', 'delivery_option', 'discount_code', 'discount', 'total', 'currency'];
  return { csv: toCsv(headers, out), rows: out.length };
}

export async function exportCustomersCsv(db: Database, currency: string): Promise<{ csv: string; rows: number }> {
  const rows = await db.query<any>(
    `SELECT email, name, phone, locale, accepts_marketing, order_count, total_spent_cents, created_at, last_order_at FROM customers
      WHERE email NOT LIKE '%.invalid' ORDER BY created_at`
  );
  const out = rows.map((r) => [safeText(r.email), safeText(r.name), safeText(r.phone), r.locale ?? '', r.accepts_marketing ? 'yes' : 'no',
    r.order_count ?? 0, major(r.total_spent_cents, currency), r.created_at ?? '', r.last_order_at ?? '']);
  return { csv: toCsv(['email', 'name', 'phone', 'language', 'accepts_marketing', 'orders', 'total_spent', 'created_at', 'last_order_at'], out), rows: out.length };
}
