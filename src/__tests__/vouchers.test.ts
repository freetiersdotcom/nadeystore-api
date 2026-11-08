// =============================================================================
// WiFi vouchers module: loading codes, automatic hand-out on payment, waiting/FIFO,
// refunds, counter sales, buyer pages, e-mail, roles.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct, seedEmailConfig, mockFetch, MOCK_RESPONSES } from './setup';
import { parseCodes } from '../modules/vouchers/lib';
import { recordPayment } from '../lib/payments';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let ip = 0; let seq = 0; let sent: any[] = []; let restore = () => {};
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.106.${(++ip % 250) + 1}`, ...(rest.headers ?? {}) },
    redirect: 'manual',
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const rows = <T = any>(q: string, a: unknown[] = []) => db().query<T>(q, a);
const iso = () => new Date().toISOString();

let sku = '';
async function plan(extra: Record<string, unknown> = {}, s = sku) { return call(`/v1/m/vouchers/plans/${s}`, { method: 'PUT', json: { instructions_fr: 'Connectez-vous au WiFi.', instructions_en: 'Join the WiFi.', ...extra } }); }
const load = (text: string, extra: Record<string, unknown> = {}, s = sku) => call(`/v1/m/vouchers/plans/${s}/codes`, { json: { text, ...extra } });
const codes = (n: number, p = 'u') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`).join('\n');

/** An order the way the core stores it, with one voucher line. */
async function order(o: { qty?: number; paid?: boolean; email?: string; status?: string; s?: string; cart?: string | null } = {}) {
  const id = `ord-${++seq}`; const qty = o.qty ?? 1; const total = 1000 * qty; const paid = o.paid === false ? 0 : total;
  await db().run(
    `INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, cart_id, amount_paid_cents, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'XOF', ?, ?, ?)`,
    [id, `N-${id}`, o.status ?? (paid >= total ? 'paid' : 'pending'), o.email ?? 'buyer@shop.test', total, total, o.cart === undefined ? `cart-${id}-abcdef` : o.cart, paid, `2026-11-0${1 + (seq % 8)}T10:00:${String(seq % 60).padStart(2, '0')}Z`]
  );
  await db().run(`INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, 'Pass 1 jour', ?, 1000)`, [`it-${id}`, id, o.s ?? sku, qty]);
  return id;
}
const reconcile = () => call('/v1/m/vouchers/reconcile', { json: {} });
const delivery = async (id: string) => j(await call(`/v1/m/vouchers/orders/${id}`));

beforeEach(async () => {
  const d = db();
  for (const t of ['voucher_plans', 'voucher_codes', 'voucher_orders', 'voucher_settings']) await d.run(`DROP TABLE IF EXISTS ${t}`);
  await d.run(`DELETE FROM config WHERE key IN ('modules', 'email')`);
  await d.run(`DELETE FROM audit_log WHERE action LIKE 'voucher.%' OR action LIKE 'module.%'`);
  for (const t of ['refunds', 'order_payments', 'order_items', 'orders', 'api_keys']) await d.run(`DELETE FROM ${t}`);
  adminKey = (await seedApiKeys(d)).adminKey;
  sku = (await seedProduct(d)).sku;
  sent = [];
  restore = mockFetch((url, init) => { if (url.includes('api.resend.com')) { sent.push(JSON.parse(String(init?.body))); return MOCK_RESPONSES.resendSend(); } return new Response('{}', { status: 200 }); });
  expect((await call('/v1/modules/vouchers', { method: 'PUT', json: { enabled: true } })).status).toBe(200);
  expect((await plan()).status).toBe(200);
});
afterEach(async () => { await new Promise((r) => setTimeout(r, 100)); restore(); });

describe('vouchers: parsing', () => {
  it('accepts user, user+password, separators and a header line', () => {
    const r = parseCodes('username,password\nabc1,pw1\nabc2;pw2\nabc3\tpw3\nabc4 pw4\nabc5\n\n');
    expect(r.problems).toEqual([]);
    expect(r.codes.map((c) => [c.username, c.password])).toEqual([['abc1', 'pw1'], ['abc2', 'pw2'], ['abc3', 'pw3'], ['abc4', 'pw4'], ['abc5', '']]);
  });
  it('reports bad lines with their number, and duplicates in the file', () => {
    const r = parseCodes('ok1\nbad$user\nOK1\na,b,c\nfine,pé');
    expect(r.problems.map((p) => p.line)).toEqual([2, 3, 4, 5]);
  });
});

describe('vouchers: loading codes', () => {
  it('loads, counts and keeps the batch', async () => {
    const r = await load(codes(5), { batch: 'Nov-1' }); expect(r.status).toBe(200);
    expect((await j(r)).added).toBe(5);
    const o = await j(await call('/v1/m/vouchers')); const p = o.items.find((x: any) => x.sku === sku);
    expect(p.available).toBe(5); expect(p.waiting).toBe(0);
    expect((await rows(`SELECT DISTINCT batch FROM voucher_codes`))[0].batch).toBe('Nov-1');
  });
  it('is all or nothing: one bad line loads nothing', async () => {
    const r = await load('good1\nbad$line\ngood2'); expect(r.status).toBe(422);
    const b = await j(r); expect(b.added).toBe(0); expect(b.problems[0].line).toBe(2);
    expect((await rows(`SELECT COUNT(*) n FROM voucher_codes`))[0].n).toBe(0);
  });
  it('refuses codes that already exist (any case) and dry_run writes nothing', async () => {
    expect((await load('a1\na2')).status).toBe(200);
    const r = await load('A1\nnew1'); expect(r.status).toBe(422);
    expect((await j(r)).problems[0].reason).toMatch(/Already/);
    const d = await load('x1\nx2', { dry_run: true }); expect(d.status).toBe(200); expect((await j(d)).added).toBe(0);
    expect((await rows(`SELECT COUNT(*) n FROM voucher_codes`))[0].n).toBe(2);
  });
  it('needs a plan first, and a plan with codes cannot be deleted', async () => {
    const other = (await seedProduct(db())).sku;
    expect((await load('z1', {}, other)).status).toBe(404);
    await load('q1');
    expect((await call(`/v1/m/vouchers/plans/${sku}`, { method: 'DELETE' })).status).toBe(409);
    expect((await call(`/v1/m/vouchers/plans/NOPE`, { method: 'PUT', json: {} })).status).toBe(404);
  });
});

describe('vouchers: hand-out', () => {
  it('gives one code per unit of a paid order, never twice', async () => {
    await load(codes(5)); const id = await order({ qty: 3 });
    await reconcile(); await reconcile();
    const d = await delivery(id); expect(d.items[0].codes.length).toBe(3); expect(d.items[0].waiting).toBe(0);
    expect((await rows(`SELECT COUNT(*) n FROM voucher_codes WHERE status='sold'`))[0].n).toBe(3);
    expect((await rows(`SELECT COUNT(DISTINCT slot) n FROM voucher_codes WHERE order_id = ?`, [id]))[0].n).toBe(3);
  });
  it('two orders never share a code', async () => {
    await load(codes(4)); const a = await order({ qty: 2 }); const b = await order({ qty: 2 });
    await Promise.all([reconcile(), reconcile(), call(`/v1/m/vouchers/orders/${a}`), call(`/v1/m/vouchers/orders/${b}`)]);
    const all = await rows(`SELECT username FROM voucher_codes WHERE status='sold'`);
    expect(new Set(all.map((x) => x.username)).size).toBe(4);
  });
  it('does nothing for unpaid, canceled or refunded orders', async () => {
    await load(codes(5));
    const u = await order({ paid: false }); const c = await order({ status: 'canceled' }); const r = await order({ status: 'refunded' });
    await reconcile();
    expect((await rows(`SELECT COUNT(*) n FROM voucher_codes WHERE status='sold'`))[0].n).toBe(0);
    expect(u && c && r).toBeTruthy();
  });
  it('ignores products that are not voucher plans', async () => {
    const other = (await seedProduct(db())).sku; await load(codes(2)); await order({ s: other });
    await reconcile(); expect((await rows(`SELECT COUNT(*) n FROM voucher_codes WHERE status='sold'`))[0].n).toBe(0);
  });
  it('out of stock: paid orders wait, then are served first-paid-first when codes arrive', async () => {
    await load('only1'); const a = await order({ qty: 1 }); const b = await order({ qty: 2 });
    await reconcile();
    expect((await delivery(a)).items[0].codes.length).toBe(1);
    const wb = await delivery(b); expect(wb.items[0].codes.length).toBe(0); expect(wb.items[0].waiting).toBe(2);
    expect((await j(await call('/v1/m/vouchers'))).items[0].waiting).toBe(2);
    expect((await load('n1\nn2\nn3')).status).toBe(200);
    expect((await delivery(b)).items[0].codes.length).toBe(2);
    expect((await rows(`SELECT COUNT(*) n FROM voucher_codes WHERE status='available'`))[0].n).toBe(1);
  });
  it('a partly served order is completed later', async () => {
    await load('p1'); const id = await order({ qty: 2 }); await reconcile();
    expect((await delivery(id)).items[0].codes.length).toBe(1);
    await load('p2'); expect((await delivery(id)).items[0].codes.length).toBe(2);
  });
  it('hands out the oldest loaded code first', async () => {
    await load('f1\nf2\nf3'); const id = await order({ qty: 2 }); await reconcile();
    expect((await delivery(id)).items[0].codes.map((x: any) => x.username).sort()).toEqual(['f1', 'f2']);
  });
  it('void takes a code out of circulation', async () => {
    await load('v1\nv2'); const [c] = await rows(`SELECT seq FROM voucher_codes WHERE username='v1'`);
    expect((await call(`/v1/m/vouchers/codes/${c.seq}/void`, { json: {} })).status).toBe(200);
    const id = await order({ qty: 2 }); await reconcile();
    expect((await delivery(id)).items[0].codes.map((x: any) => x.username)).toEqual(['v2']);
  });
  it('is triggered by recordPayment (counter payment completes the order)', async () => {
    await load(codes(2)); const id = await order({ paid: false });
    const [o] = await rows(`SELECT * FROM orders WHERE id = ?`, [id]);
    await recordPayment(db(), o, { amount_cents: 1000, method: 'cash' } as any);
    expect((await rows(`SELECT COUNT(*) n FROM voucher_codes WHERE order_id = ?`, [id]))[0].n).toBe(1);
  });
  it('listing and codes search', async () => {
    await load(codes(3, 'wifi')); const id = await order(); await reconcile();
    const l = await j(await call('/v1/m/vouchers/orders')); expect(l.items.some((x: any) => x.order_id === id)).toBe(true);
    const s = await j(await call('/v1/m/vouchers/codes?q=wifi2&status=available')); expect(s.items.length).toBe(1);
  });
});

describe('vouchers: buyer pages', () => {
  it('by-cart: preparing → ready, and unpaid shows nothing', async () => {
    const cart = 'cart-abcdefgh-1'; const id = await order({ cart });
    let r = await j(await call(`/m/vouchers/by-cart/${cart}`, { key: null })); expect(r.status).toBe('waiting');
    await load('c1'); r = await j(await call(`/m/vouchers/by-cart/${cart}`, { key: null }));
    expect(r.status).toBe('ready'); expect(r.items[0].codes[0].username).toBe('c1'); expect(r.items[0].instructions).toBe('Connectez-vous au WiFi.');
    const en = await j(await call(`/m/vouchers/by-cart/${cart}?lang=en`, { key: null })); expect(en.items[0].instructions).toBe('Join the WiFi.');
    const unpaid = 'cart-unpaid-0001'; await order({ cart: unpaid, paid: false });
    const u = await j(await call(`/m/vouchers/by-cart/${unpaid}`, { key: null })); expect(u.status).toBe('unpaid'); expect(u.items).toEqual([]);
    expect(id).toBeTruthy();
    expect((await j(await call(`/m/vouchers/by-cart/unknown-cart-123`, { key: null }))).status).toBe('none');
  });
  it('private page: escapes, locks headers down, hides refunded codes', async () => {
    await load('c1'); await plan({ instructions_fr: '<script>alert(1)</script>' });
    const id = await order(); await reconcile();
    const { link } = await delivery(id); const path = new URL(link).pathname;
    const r = await call(path, { key: null }); const html = await r.text();
    expect(r.status).toBe(200); expect(html).toContain('c1'); expect(html).not.toContain('<script>alert'); expect(html).toContain('&lt;script&gt;');
    expect(r.headers.get('cache-control')).toBe('no-store'); expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('x-robots-tag')).toBe('noindex');
    await rows(`UPDATE orders SET status='refunded' WHERE id = ?`, [id]);
    await db().run(`UPDATE orders SET status='refunded' WHERE id = ?`, [id]);
    const after = await (await call(path, { key: null })).text(); expect(after).not.toContain('>c1<'); expect(after).toMatch(/rembours/);
    expect((await call('/m/vouchers/o/' + 'x'.repeat(30), { key: null })).status).toBe(404);
  });
});

describe('vouchers: e-mail', () => {
  it('sends the codes once, not for counter customers, and waits for missing codes', async () => {
    await seedEmailConfig(db());
    await load('m1'); const a = await order({ qty: 1 }); const w = await order({ qty: 2 }); const walk = await order({ email: 'walk-in@counter.invalid' });
    await reconcile(); await reconcile(); await new Promise((r) => setTimeout(r, 100));
    expect(sent.length).toBe(1); expect(JSON.stringify(sent[0])).toContain('m1');
    expect(a && w && walk).toBeTruthy();
    await load('m2\nm3\nm4'); await new Promise((r) => setTimeout(r, 100));
    expect(sent.length).toBe(2);
  });
  it('without a provider nothing breaks; resend works once configured', async () => {
    await load('r1'); const id = await order(); await reconcile();
    expect(sent.length).toBe(0);
    await seedEmailConfig(db());
    const r = await call(`/v1/m/vouchers/orders/${id}/resend`, { json: {} }); expect(r.status).toBe(200); expect((await j(r)).emailed).toBe(true);
  });
});

describe('vouchers: access', () => {
  it('is off by default and gated', async () => {
    await db().run(`DELETE FROM config WHERE key = 'modules'`);
    expect((await call('/v1/m/vouchers')).status).toBe(404);
    expect((await call('/m/vouchers/by-cart/abcdefghijkl', { key: null })).status).toBe(404);
  });
  it('needs a key', async () => { expect((await call('/v1/m/vouchers', { key: null })).status).toBe(401); });
});

describe('variant currency', () => {
  it('a new variant inherits the shop currency, ', async () => {
    const dbh = db();
    await dbh.run(`DELETE FROM variants WHERE sku LIKE 'CUR-%'`);
    await dbh.run(`INSERT OR IGNORE INTO products (id, title, status, created_at) VALUES ('3f2b1c1e-0000-4000-8000-00000000c0de', 'Cur', 'active', '2026-01-01')`);
    await dbh.run(`INSERT INTO variants (id, product_id, sku, title, price_cents, currency, weight_g, product_type, created_at) VALUES ('cur-v0', '3f2b1c1e-0000-4000-8000-00000000c0de', 'CUR-0', 'a', 100, 'XOF', 0, 'physical', '2000-01-01')`);
    const r = await call('/v1/products/3f2b1c1e-0000-4000-8000-00000000c0de/variants', { json: { sku: 'CUR-1', title: 'b', price_cents: 500, product_type: 'digital' } });
    expect(r.status).toBe(201);
    const [v] = await dbh.query<any>(`SELECT currency FROM variants WHERE sku = 'CUR-1'`);
    expect(v.currency).toBe('XOF');
  });
});
