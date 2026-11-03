// =============================================================================
// Bulk import / export (CSV)
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct } from './setup';
import { parseCsv, parseCsvObjects, safeText, toCsv } from '../lib/csv';
import { requiredPermission } from '../auth/permissions';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let ip = 0;
async function call(path: string, init: RequestInit & { key?: string | null } = {}) {
  const { key = adminKey, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'CF-Connecting-IP': `198.51.103.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
  });
}
const imp = async (csv: string, qs = 'currency=XOF') => { const r = await call(`/v1/import/products?${qs}`, { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } }); return { status: r.status, json: await r.json() as any }; };
const rows = <T = any>(q: string, a: unknown[] = []) => db().query<T>(q, a);
const H = 'handle,title,tags,sku,variant_title,price,weight_g,type,stock';

beforeEach(async () => {
  const d = db();
  for (const t of ['order_payments', 'order_items', 'orders', 'cart_items', 'carts', 'customer_addresses', 'customers', 'inventory_logs', 'inventory', 'variants', 'products', 'api_keys']) await d.run(`DELETE FROM ${t}`);
  adminKey = (await seedApiKeys(d)).adminKey;
});

describe('csv', () => {
  it('reads quotes, doubled quotes, line breaks in cells, BOM and CRLF', () => {
    const t = parseCsv('﻿a,b\r\n"x, y","He said ""hi"""\r\n"line1\nline2",z\r\n');
    expect(t).toEqual([['a', 'b'], ['x, y', 'He said "hi"'], ['line1\nline2', 'z']]);
  });
  it('detects ; (French Excel) and maps header aliases', () => {
    const { headers, rows } = parseCsvObjects('Slug;Variant SKU;Quantity\nsavon;S1;5\n', { slug: 'handle', variant_sku: 'sku', quantity: 'stock' });
    expect(headers).toEqual(['handle', 'sku', 'stock']);
    expect(rows[0]).toEqual({ line: 2, data: { handle: 'savon', sku: 'S1', stock: '5' } });
  });
  it('rejects an unclosed quote', () => { expect(() => parseCsv('a\n"oops\n')).toThrow(/never closed/); });
  it('defuses formulas but leaves plain text and writes a BOM', () => {
    expect(safeText('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeText('+22961000000')).toBe(`'+22961000000`);
    expect(safeText('Savon')).toBe('Savon');
    expect(toCsv(['a'], [['x,"y"']])).toBe('﻿a\r\n"x,""y"""\r\n');
  });
});

describe('import products', () => {
  it('a dry run reports what would happen and writes nothing', async () => {
    const r = await imp(`${H}\nsavon,Savon au karité,bio;peau,SAV-1,100g,2500,100,physical,20\nsavon,,,SAV-2,200g,4000,200,physical,10\n`, 'currency=XOF&dry_run=1');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ dry_run: true, ok: true, applied: false, summary: { rows: 2, products_create: 1, variants_create: 2, stock_changes: 2 } });
    expect(await rows(`SELECT 1 FROM products`)).toHaveLength(0);
  });

  it('creates products grouped by handle, with variants, tags, stock and a stock log', async () => {
    const r = await imp(`${H}\nsavon,Savon au karité,bio;peau,SAV-1,100g,2500,100,physical,20\nsavon,,,SAV-2,200g,4000,200,physical,10\nguide,Guide santé,,GUIDE,PDF,5000,,digital,\n`);
    expect(r.status).toBe(200); expect(r.json.applied).toBe(true);
    const [p] = await rows(`SELECT * FROM products WHERE slug = 'savon'`);
    expect(p).toMatchObject({ title: 'Savon au karité', status: 'active' });
    expect(JSON.parse(p.tags)).toEqual(['bio', 'peau']);
    const v = await rows(`SELECT sku, price_cents, weight_g, product_type FROM variants WHERE product_id = ? ORDER BY sku`, [p.id]);
    expect(v).toEqual([{ sku: 'SAV-1', price_cents: 2500, weight_g: 100, product_type: 'physical' }, { sku: 'SAV-2', price_cents: 4000, weight_g: 200, product_type: 'physical' }]);
    expect((await rows(`SELECT on_hand FROM inventory WHERE sku = 'SAV-2'`))[0].on_hand).toBe(10);
    expect((await rows(`SELECT delta, reason FROM inventory_logs WHERE sku = 'SAV-1'`))[0]).toEqual({ delta: 20, reason: 'restock' });
    expect((await rows(`SELECT product_type FROM variants WHERE sku = 'GUIDE'`))[0].product_type).toBe('digital');
    const audit = await rows(`SELECT action FROM audit_log WHERE action = 'import.products'`);
    expect(audit).toHaveLength(1);
  });

  it('converts prices from major units (EUR has cents, XOF has none) and accepts a decimal comma', async () => {
    await imp(`handle;title;sku;price\nhuile;Huile;H1;19,99\nhuile;;H2;5\n`, 'currency=EUR');
    expect((await rows(`SELECT sku, price_cents FROM variants ORDER BY sku`))).toEqual([{ sku: 'H1', price_cents: 1999 }, { sku: 'H2', price_cents: 500 }]);
  });

  it('updates existing items by sku: empty cells keep the old values, stock is logged as a correction', async () => {
    await imp(`${H}\nsavon,Savon,bio,SAV-1,100g,2500,100,physical,20\n`);
    // a price + stock sheet: only sku, price, stock
    const r = await imp(`sku,price,stock\nSAV-1,3000,15\n`);
    expect(r.json.summary).toMatchObject({ products_create: 0, products_update: 1, variants_update: 1, stock_changes: 1 });
    const [v] = await rows(`SELECT title, price_cents, weight_g FROM variants WHERE sku = 'SAV-1'`);
    expect(v).toEqual({ title: '100g', price_cents: 3000, weight_g: 100 });
    expect((await rows(`SELECT on_hand FROM inventory WHERE sku = 'SAV-1'`))[0].on_hand).toBe(15);
    expect((await rows(`SELECT delta, reason FROM inventory_logs WHERE sku = 'SAV-1' ORDER BY rowid DESC LIMIT 1`))[0]).toEqual({ delta: -5, reason: 'correction' });
    const [p] = await rows(`SELECT title, tags FROM products WHERE slug = 'savon'`);
    expect(p.title).toBe('Savon'); expect(JSON.parse(p.tags)).toEqual(['bio']);
  });

  it('refuses the whole file when any row is wrong, and says which lines', async () => {
    const csv = `${H}
ok,Produit ok,,OK-1,,1000,,physical,5
bad1,Sans prix,,NOPRICE,,,,physical,
bad2,Prix faux,,BADPRICE,,abc,,physical,
bad3,Décimales XOF,,DEC,,19.99,,physical,
bad4,Type faux,,TYPE,,1000,,gadget,
bad5,Stock faux,,STK,,1000,,physical,-3
bad6,Doublon,,OK-1,,1000,,physical,
,,,,,1000,,,
`;
    const r = await imp(csv);
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ ok: false, applied: false });
    const byLine = Object.fromEntries(r.json.errors.map((e: any) => [e.line, e.message]));
    expect(byLine[3]).toMatch(/needs a price/);
    expect(byLine[4]).toMatch(/price/);
    expect(byLine[5]).toMatch(/no decimals/);
    expect(byLine[6]).toMatch(/type/);
    expect(byLine[7]).toMatch(/stock/);
    expect(byLine[8]).toMatch(/appears twice in the file \(first on line 2\)/);
    expect(byLine[9]).toMatch(/sku is empty/);
    expect(await rows(`SELECT 1 FROM products`)).toHaveLength(0); // nothing written, not even the good row
  });

  it('refuses a sku that belongs to another product, and stock below what open orders reserved', async () => {
    await imp(`${H}\nsavon,Savon,,SAV-1,,2500,,physical,20\n`);
    const r1 = await imp(`${H}\nother,Autre,,SAV-1,,1000,,physical,\n`);
    expect(r1.status).toBe(422); expect(r1.json.errors[0].message).toMatch(/different product|another product/);
    await db().run(`UPDATE inventory SET reserved = 8 WHERE sku = 'SAV-1'`);
    const r2 = await imp(`sku,stock\nSAV-1,5\n`);
    expect(r2.status).toBe(422); expect(r2.json.errors[0].message).toMatch(/below the 8 units reserved/);
  });

  it('checks the file itself: needs a sku column, rows, a closed quote, valid currency', async () => {
    expect((await imp(`title,price\nx,1\n`)).json.errors[0].message).toMatch(/"sku" column/);
    expect((await imp(`sku\n`)).json.errors[0].message).toMatch(/no data rows/);
    expect((await imp(`sku,title\n"A,x\n`)).json.errors[0].message).toMatch(/never closed/);
    expect((await call(`/v1/import/products?currency=EURO`, { method: 'POST', body: 'sku\nA\n' })).status).toBe(400);
  });

  it('warns about columns it ignores and accepts French-Excel files (BOM, semicolons)', async () => {
    const r = await imp(`﻿handle;title;sku;price;couleur\nthe;Thé;T1;1500;vert\n`, 'currency=XOF&dry_run=1');
    expect(r.json.ok).toBe(true);
    expect(r.json.warnings[0].message).toMatch(/couleur/);
  });
});

describe('exports', () => {
  it('products: round trip (export, wipe, import gives the same catalog)', async () => {
    await imp(`${H}\nsavon,Savon au karité,bio;peau,SAV-1,100g,2500,100,physical,20\nsavon,,,SAV-2,200g,4000,200,physical,10\nguide,Guide,,GUIDE,PDF,5000,,digital,\n`);
    const r = await call('/v1/export/products.csv?currency=XOF');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const csv = await r.text();
    expect(csv.startsWith('﻿handle,title,')).toBe(true);
    const before = await rows(`SELECT sku, price_cents, weight_g, product_type FROM variants ORDER BY sku`);
    const stockBefore = await rows(`SELECT sku, on_hand FROM inventory ORDER BY sku`);
    for (const t of ['inventory_logs', 'inventory', 'variants', 'products']) await db().run(`DELETE FROM ${t}`);
    const again = await imp(csv);
    expect(again.status).toBe(200);
    expect(await rows(`SELECT sku, price_cents, weight_g, product_type FROM variants ORDER BY sku`)).toEqual(before);
    expect((await rows(`SELECT sku, on_hand FROM inventory ORDER BY sku`)).filter((i: any) => i.sku !== 'GUIDE')).toEqual(stockBefore.filter((i: any) => i.sku !== 'GUIDE'));
  });

  it('orders: delivery option, walk-in label, formulas defused, date filter', async () => {
    const p = await seedProduct(db(), { price_cents: 450000, on_hand: 20 });
    const a = await call('/v1/orders/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      items: [{ sku: p.sku, qty: 2 }], customer_name: '=HYPERLINK("http://evil")', shipping: { custom_cents: 150000, label: 'Coursier' }, payment: { amount_cents: 1050000, method: 'cash' } }) });
    expect(a.status).toBe(200);
    const csv = await (await call('/v1/export/orders.csv')).text();
    const [head, line] = csv.replace('﻿', '').trim().split('\r\n');
    expect(head).toContain('delivery_option');
    expect(line).toContain('walk-in');
    expect(line).toContain('Coursier');
    expect(line).toContain(`${p.sku} x2`);
    expect(line).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(line).not.toMatch(/(^|,)=HYPERLINK/);
    expect((await (await call('/v1/export/orders.csv?from=2999-01-01')).text()).trim().split('\r\n')).toHaveLength(1);
    expect((await call('/v1/export/orders.csv?from=yesterday')).status).toBe(400);
  });

  it('customers: leaves out walk-in and erased accounts', async () => {
    const d = db();
    await d.run(`INSERT INTO customers (id, email, name) VALUES ('c1', 'ama@shop.test', 'Ama'), ('c2', 'walk-in@counter.invalid', 'Walk-in'), ('c3', 'erased-1@erased.invalid', NULL)`);
    const csv = await (await call('/v1/export/customers.csv')).text();
    expect(csv).toContain('ama@shop.test');
    expect(csv).not.toContain('.invalid');
  });

  it('every export and import is audited', async () => {
    await db().run(`DELETE FROM audit_log WHERE action LIKE 'export.%'`);
    await call('/v1/export/products.csv'); await call('/v1/export/orders.csv'); await call('/v1/export/customers.csv');
    const a = (await rows(`SELECT action FROM audit_log WHERE action LIKE 'export.%'`)).map((x: any) => x.action).sort();
    expect(a).toEqual(['export.customers', 'export.orders', 'export.products']);
  });
});

describe('access', () => {
  it('needs a sign-in', async () => {
    for (const p of ['/v1/export/products.csv', '/v1/export/orders.csv', '/v1/export/customers.csv']) expect((await call(p, { key: null })).status).toBe(401);
    expect((await call('/v1/import/products', { method: 'POST', body: 'sku\nA\n', key: null })).status).toBe(401);
  });
  it('maps to the right permission for each role', () => {
    expect(requiredPermission('POST', '/v1/import/products')).toBe('products.write');
    expect(requiredPermission('GET', '/v1/export/products.csv')).toBe('products.read');
    expect(requiredPermission('GET', '/v1/export/orders.csv')).toBe('orders.read');
    expect(requiredPermission('GET', '/v1/export/customers.csv')).toBe('customers.read');
  });
  it('keeps CORS headers on downloads so the admin can fetch them', async () => {
    const r = await call('/v1/export/orders.csv', { headers: { Origin: 'https://admin.test.com' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://admin.test.com');
    expect(r.headers.get('access-control-expose-headers')).toContain('Content-Disposition');
  });
});
