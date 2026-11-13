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
import { roleCanRequest } from '../auth/permissions';
import { runVoucherCheck } from '../modules/vouchers/alerts';

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
  for (const t of ['voucher_plans', 'voucher_codes', 'voucher_orders', 'voucher_settings', 'voucher_low', 'voucher_low_state', 'voucher_alert_settings', 'voucher_locations']) await d.run(`DROP TABLE IF EXISTS ${t}`);
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

const MIKHMON_UP = 'Username,Password,Profile,Time Limit,Data Limit,Comment\ndnrhvia,2367699,24H,1d,,up-525-11.12.26-\ndidmdji,3238376,24H,1d,,up-525-11.12.26-\nwcheufz,9249395,24H,1d,,up-525-11.12.26-\n';
const MIKHMON_VC = 'Username,Password,Profile,Time Limit,Data Limit,Comment\nsgfm4575,sgfm4575,30D,4w2d,,vc-663-11.12.26-\nxnym8484,xnym8484,30D,4w2d,,vc-663-11.12.26-\n';
describe('vouchers: Mikhmon CSV export', () => {
  it('reads the six-column export by header name, keeps profile and comment, ignores the rest', () => {
    const r = parseCodes(MIKHMON_UP);
    expect(r.problems).toEqual([]); expect(r.profiles).toEqual({ '24H': 3 });
    expect(r.codes[0]).toEqual({ line: 2, username: 'dnrhvia', password: '2367699', profile: '24H', comment: 'up-525-11.12.26-' });
    const v = parseCodes(MIKHMON_VC); expect(v.codes.map((c) => [c.username, c.password])).toEqual([['sgfm4575', 'sgfm4575'], ['xnym8484', 'xnym8484']]);
  });
  it('copes with another column order, quotes, semicolons, CRLF, a BOM and a missing password column', () => {
    expect(parseCodes('\uFEFF"Comment";"Profile";"Password";"Username"\r\n"x, y";"1H";"p w";"u1"\r\n').problems.map((p) => p.reason)[0]).toMatch(/password/i);
    const r = parseCodes('Comment;Profile;Password;Username\r\nbatch-a;1H;pw1;u1\r\nbatch-a;1H;pw2;u2\r\n'); expect(r.problems).toEqual([]);
    expect(r.codes.map((c) => [c.username, c.password, c.profile])).toEqual([['u1', 'pw1', '1H'], ['u2', 'pw2', '1H']]);
    const t = parseCodes('Username,Profile\nonly1,1H\nonly2,1H\n'); expect(t.codes.map((c) => [c.username, c.password])).toEqual([['only1', ''], ['only2', '']]);
  });
  it('a headerless file with extra columns is still refused, and the message points at the header', () => {
    const r = parseCodes('abc,pw,24H,1d'); expect(r.codes).toEqual([]); expect(r.problems[0].reason).toMatch(/header/i);
  });
  it('loads the file, takes the batch name from the Comment column, and a profile can be chosen', async () => {
    const r = await j(await load(MIKHMON_UP)); expect(r.added).toBe(3); expect(r.profiles).toEqual({ '24H': 3 }); expect(r.batch).toBe('up-525-11.12.26-');
    expect((await rows(`SELECT DISTINCT batch FROM voucher_codes`))[0].batch).toBe('up-525-11.12.26-');
    const typed = await j(await load(MIKHMON_VC, { batch: 'Cotonou' })); expect(typed.added).toBe(2);
    expect((await rows(`SELECT batch FROM voucher_codes WHERE username = 'sgfm4575'`))[0].batch).toBe('Cotonou');
  });
  it('a file mixing profiles is refused until a profile is named; naming it loads only those rows', async () => {
    const mixed = MIKHMON_UP + MIKHMON_VC.split('\n').slice(1).join('\n');
    const refused = await load(mixed); expect(refused.status).toBe(422); const rep = await j(refused);
    expect(rep.profiles).toEqual({ '24H': 3, '30D': 2 }); expect(rep.problems[0].reason).toMatch(/mixes several profiles/);
    expect((await rows(`SELECT COUNT(*) AS n FROM voucher_codes`))[0].n).toBe(0);
    const ok = await j(await load(mixed, { profile: '30d' })); expect(ok.added).toBe(2);   // not case sensitive
    expect((await rows(`SELECT username FROM voucher_codes ORDER BY seq`)).map((x: any) => x.username)).toEqual(['sgfm4575', 'xnym8484']);
    expect((await load(mixed, { profile: '7D' })).status).toBe(400);
  });
  it('a bad line in another profile does not block the profile you chose, but one in yours does', async () => {
    const bad = MIKHMON_UP + 'bad$name,pw,30D,1d,,c\nsgfm4575,sgfm4575,30D,4w2d,,vc\n';
    expect((await j(await load(bad, { profile: '30D' }))).ok).toBe(false);
    const good = await j(await load(MIKHMON_UP + 'bad$name,pw,30D,1d,,c\n', { profile: '24H' })); expect(good.added).toBe(3);
  });
  it('dry run reports profiles and writes nothing; existing usernames are still refused', async () => {
    const d = await j(await load(MIKHMON_UP, { dry_run: true })); expect(d.ok).toBe(true); expect(d.to_add).toBe(3); expect(d.profiles).toEqual({ '24H': 3 });
    expect((await rows(`SELECT COUNT(*) AS n FROM voucher_codes`))[0].n).toBe(0);
    await load(MIKHMON_UP); const again = await load(MIKHMON_UP); expect(again.status).toBe(422);
  });
  it('plain lists keep working exactly as before (no profile, no batch from nowhere)', async () => {
    const r = await j(await load(codes(3))); expect(r.added).toBe(3); expect(r.profiles).toBeUndefined(); expect((await rows(`SELECT DISTINCT batch FROM voucher_codes`))[0].batch).toBeNull();
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

const batchOp = (sku_: string, batch: string | null, action: string, extra: Record<string, unknown> = {}) => call('/v1/m/vouchers/batches', { json: { sku: sku_, batch, action, ...extra } });
const count = async (where = '1=1', a: unknown[] = []) => Number((await rows(`SELECT COUNT(*) AS n FROM voucher_codes WHERE ${where}`, a))[0].n);
const seqOf = async (user: string) => Number((await rows(`SELECT seq FROM voucher_codes WHERE username = ?`, [user]))[0].seq);
const mails = () => sent.filter((m) => /vouchers/i.test(String(m.subject)));

describe('vouchers: managing loaded codes', () => {
  it('lists batches with their counts, and codes without a batch too', async () => {
    await load(codes(3, 'a'), { batch: 'Nov-A' }); await load(codes(2, 'b'));
    const o = await j(await call(`/v1/m/vouchers/batches?sku=${sku}`));
    expect(o.items.map((x: any) => [x.batch, x.total, x.available, x.sold, x.void])).toEqual([[null, 2, 2, 0, 0], ['Nov-A', 3, 3, 0, 0]]);
  });
  it('void takes unsold codes of a batch off sale, keeps sold ones, restore brings back only the never-sold ones; dry run changes nothing', async () => {
    await load(codes(4, 'a'), { batch: 'A' }); const id = await order({ qty: 1 }); await reconcile();   // one of them is sold
    const dry = await j(await batchOp(sku, 'A', 'void', { dry_run: true })); expect(dry).toMatchObject({ affected: 3, kept_sold: 1, dry_run: true }); expect(await count(`status = 'void'`)).toBe(0);
    expect(await j(await batchOp(sku, 'A', 'void'))).toMatchObject({ affected: 3, kept_sold: 1 }); expect(await count(`status = 'void'`)).toBe(3); expect(await count(`status = 'sold'`)).toBe(1);
    expect((await j(await call('/v1/m/vouchers'))).items[0].available).toBe(0);
    expect(await j(await batchOp(sku, 'A', 'restore'))).toMatchObject({ affected: 3 }); expect(await count(`status = 'available'`)).toBe(3);
    expect((await delivery(id)).items[0].codes.length).toBe(1);   // the buyer's code is untouched
  });
  it('a sold code that was flagged as withdrawn never goes back on sale, even with its batch', async () => {
    await load(codes(2), { batch: 'A' }); await order({ qty: 1 }); await reconcile();
    const sold = (await rows(`SELECT seq FROM voucher_codes WHERE status = 'sold'`))[0].seq; await call(`/v1/m/vouchers/codes/${sold}/void`, { json: {} });
    await batchOp(sku, 'A', 'void'); const r = await j(await batchOp(sku, 'A', 'restore')); expect(r).toMatchObject({ affected: 1, kept_sold: 1 });
    expect((await rows(`SELECT status FROM voucher_codes WHERE seq = ?`, [sold]))[0].status).toBe('void'); expect(await count(`status = 'available'`)).toBe(1);
  });
  it('voiding everything makes a paid order wait; restoring serves it', async () => {
    await load(codes(2), { batch: 'A' }); await batchOp(sku, 'A', 'void'); const id = await order({ qty: 1 }); await reconcile();
    expect((await delivery(id)).items[0].waiting).toBe(1);
    await batchOp(sku, 'A', 'restore'); expect((await delivery(id)).items[0].codes.length).toBe(1);
  });
  it('delete removes unsold codes only; sold codes stay as records; unknown batch is a 404', async () => {
    await load(codes(3, 'a'), { batch: 'A' }); await order({ qty: 1 }); await reconcile();
    expect(await j(await batchOp(sku, 'A', 'delete'))).toMatchObject({ affected: 2, kept_sold: 1 }); expect(await count()).toBe(1); expect(await count(`status = 'sold'`)).toBe(1);
    expect((await batchOp(sku, 'nope', 'delete')).status).toBe(404);
  });
  it('move sends the unsold codes to another voucher product and serves orders waiting there', async () => {
    const sku2 = (await seedProduct(db())).sku; expect((await plan({}, sku2)).status).toBe(200);
    await load(codes(3, 'a'), { batch: 'A' }); const waiting = await order({ qty: 1, s: sku2 }); await reconcile(); expect((await delivery(waiting)).items[0].waiting).toBe(1);
    const r = await j(await batchOp(sku, 'A', 'move', { to_sku: sku2 })); expect(r.affected).toBe(3);
    expect(await count(`sku = ?`, [sku2])).toBe(3); expect((await delivery(waiting)).items[0].codes.length).toBe(1);
    expect((await batchOp(sku2, 'A', 'move', { to_sku: sku2 })).status).toBe(400); expect((await batchOp(sku2, 'A', 'move', { to_sku: 'NOT-A-PLAN' })).status).toBe(400);
  });
  it('rename relabels the whole batch (also sold codes), and an empty name removes the label', async () => {
    await load(codes(2), { batch: 'A' }); await order({ qty: 1 }); await reconcile();
    await batchOp(sku, 'A', 'rename', { new_name: 'Café X — Nov' }); expect(await count(`batch = 'Café X — Nov'`)).toBe(2);
    await batchOp(sku, 'Café X — Nov', 'rename', { new_name: '' }); expect(await count(`batch IS NULL`)).toBe(2);
  });
  it('one code at a time: void, restore, delete; a sold code cannot be restored or deleted', async () => {
    await load('c1\nc2\nc3'); await order({ qty: 1 }); await reconcile(); const sold = (await rows(`SELECT seq FROM voucher_codes WHERE status = 'sold'`))[0].seq; const free = await seqOf('c3');
    expect((await call(`/v1/m/vouchers/codes/${free}/void`, { json: {} })).status).toBe(200); expect((await rows(`SELECT status FROM voucher_codes WHERE seq = ?`, [free]))[0].status).toBe('void');
    expect((await call(`/v1/m/vouchers/codes/${free}/restore`, { json: {} })).status).toBe(200); expect((await rows(`SELECT status FROM voucher_codes WHERE seq = ?`, [free]))[0].status).toBe('available');
    expect((await call(`/v1/m/vouchers/codes/${free}`, { method: 'DELETE' })).status).toBe(200); expect(await count(`seq = ?`, [free])).toBe(0);
    expect((await call(`/v1/m/vouchers/codes/${sold}`, { method: 'DELETE' })).status).toBe(409);
    await call(`/v1/m/vouchers/codes/${sold}/void`, { json: {} }); expect((await call(`/v1/m/vouchers/codes/${sold}/restore`, { json: {} })).status).toBe(409);
    expect((await call('/v1/m/vouchers/codes/99999', { method: 'DELETE' })).status).toBe(404);
  });
  it('managers can change codes, staff can only look', () => {
    expect(roleCanRequest('manager', 'POST', '/v1/m/vouchers/batches').ok).toBe(true); expect(roleCanRequest('staff', 'POST', '/v1/m/vouchers/batches').ok).toBe(false);
    expect(roleCanRequest('staff', 'DELETE', '/v1/m/vouchers/codes/3').ok).toBe(false); expect(roleCanRequest('staff', 'GET', '/v1/m/vouchers/batches').ok).toBe(true);
    expect(roleCanRequest('staff', 'PUT', '/v1/m/vouchers/alerts/settings').ok).toBe(false);
  });
});

describe('vouchers: low-code alerts', () => {
  const settings = (json: Record<string, unknown>) => call('/v1/m/vouchers/alerts/settings', { method: 'PUT', json: { default_threshold: 10, emails: '', push: false, ...json } });
  const levelOf = async () => (await j(await call('/v1/m/vouchers'))).items.find((x: any) => x.sku === sku);
  beforeEach(async () => { await seedEmailConfig(db()); });

  it('the plan list shows the threshold and level: ok, low, out, and out while paid orders wait', async () => {
    await load(codes(12)); let p = await levelOf(); expect([p.threshold, p.level]).toEqual([10, 'ok']);
    for (let i = 1; i <= 4; i++) await call(`/v1/m/vouchers/codes/${await seqOf('u' + i)}/void`, { json: {} });
    expect((await levelOf()).level).toBe('low');   // 8 left
    await call(`/v1/m/vouchers/alerts/plans/${sku}`, { method: 'PUT', json: { threshold: 5, muted: false } }); p = await levelOf(); expect([p.threshold, p.level]).toEqual([5, 'ok']);
    await batchOp(sku, null, 'void'); expect((await levelOf()).level).toBe('out');
    await batchOp(sku, null, 'restore'); await order({ qty: 12 }); await reconcile(); expect((await levelOf()).available).toBe(0);
  });
  it('a plan that never had a code is not an alarm (it is being set up)', async () => {
    await settings({ emails: 'owner@shop.test', default_threshold: 5 }); await runVoucherCheck(db()); expect(mails().length).toBe(0); expect((await levelOf()).level).toBe('ok');
  });
  it('a plan with no code yet but a paid order waiting is an alarm', async () => {
    await settings({ emails: 'owner@shop.test', default_threshold: 5 }); await order({ qty: 1 }); await reconcile();
    expect((await levelOf()).level).toBe('out'); await runVoucherCheck(db()); expect(mails().length).toBe(1); expect(mails()[0].text).toMatch(/en attente/);
  });
  it('announces once when a plan gets low, once more when it runs out, and again only after it was refilled', async () => {
    await settings({ emails: 'owner@shop.test', default_threshold: 3 }); await load(codes(5)); expect(mails().length).toBe(0);
    const v = async (u: string) => call(`/v1/m/vouchers/codes/${await seqOf(u)}/void`, { json: {} }); const r = async (u: string) => call(`/v1/m/vouchers/codes/${await seqOf(u)}/restore`, { json: {} });
    await v('u1'); expect(mails().length).toBe(0);                       // 4 left
    await v('u2'); expect(mails().length).toBe(1);                       // 3 left: low
    expect(mails()[0].to).toEqual(['owner@shop.test']); expect(mails()[0].text).toContain('3 code(s)');
    await v('u3'); expect(mails().length).toBe(1);                       // 2 left: already announced
    await v('u4'); await v('u5'); expect(mails().length).toBe(2);        // out: one more
    await runVoucherCheck(db()); expect(mails().length).toBe(2);         // the 15-minute check does not repeat
    for (const u of ['u1', 'u2', 'u3', 'u4', 'u5']) await r(u);          // refilled: re-armed, no message
    expect(mails().length).toBe(2); expect((await rows(`SELECT COUNT(*) AS n FROM voucher_low_state`))[0].n).toBe(0);
    await v('u1'); await v('u2'); expect(mails().length).toBe(3);        // drops again: announced again
  });
  it('a muted plan is never announced, and without e-mail addresses nothing is sent but the state is still kept', async () => {
    await settings({ emails: 'owner@shop.test', default_threshold: 5 }); await call(`/v1/m/vouchers/alerts/plans/${sku}`, { method: 'PUT', json: { threshold: null, muted: true } });
    await load(codes(3)); await runVoucherCheck(db()); expect(mails().length).toBe(0);
    await call(`/v1/m/vouchers/alerts/plans/${sku}`, { method: 'PUT', json: { threshold: null, muted: false } }); expect(mails().length).toBe(1);   // unmuting announces what is already low
    await settings({ emails: '', default_threshold: 5 }); await batchOp(sku, null, 'void'); expect(mails().length).toBe(1); expect((await rows(`SELECT level FROM voucher_low_state`))[0].level).toBe('out');
  });
  it('the message mentions paid orders still waiting for a code, and a payment triggers the check', async () => {
    await settings({ emails: 'owner@shop.test', default_threshold: 0 }); await load(codes(1));
    const id = await order({ paid: false, qty: 2 }); const [o] = await rows(`SELECT * FROM orders WHERE id = ?`, [id]);
    await recordPayment(db(), o, { amount_cents: 2000, method: 'cash' } as any);   // takes the only code, one unit left waiting
    expect(mails().length).toBe(1); expect(mails()[0].text).toMatch(/1 commande\(s\) payée\(s\) en attente/); expect(mails()[0].text).toMatch(/OUT/);
  });
  it('settings are checked and cleaned; a plan needs to be a voucher plan', async () => {
    const r = await j(await settings({ emails: 'A@B.co, nonsense; a@b.co ,c@d.co', default_threshold: 7, push: true })); expect(r).toMatchObject({ default_threshold: 7, emails: 'a@b.co, c@d.co', push: 1 });
    expect((await settings({ default_threshold: -1 })).status).toBe(400); expect((await settings({ default_threshold: 1.5 })).status).toBe(400);
    expect((await call('/v1/m/vouchers/alerts/plans/NOPE', { method: 'PUT', json: { threshold: 3, muted: false } })).status).toBe(404);
    expect((await call('/v1/m/vouchers/alerts/settings')).status).toBe(200);
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

describe('product delete with vouchers', () => {
  it('refuses while codes are loaded, removes the plan when empty', async () => {
    const dbh = db();
    const pid = '3f2b1c1e-0000-4000-8000-00000000d0de';
    await dbh.run(`DELETE FROM variants WHERE sku = 'DEL-1'`);
    await dbh.run(`DELETE FROM voucher_codes WHERE sku = 'DEL-1'`);
    await dbh.run(`INSERT OR IGNORE INTO products (id, title, status, created_at) VALUES (?, 'Del', 'draft', '2026-01-01')`, [pid]);
    await dbh.run(`INSERT INTO variants (id, product_id, sku, title, price_cents, currency, weight_g, product_type, created_at) VALUES ('del-v1', ?, 'DEL-1', 'a', 100, 'XOF', 0, 'digital', '2026-01-01')`, [pid]);
    await dbh.run(`INSERT OR REPLACE INTO voucher_plans (sku, created_at) VALUES ('DEL-1', '2026-01-01')`);
    await dbh.run(`INSERT INTO voucher_codes (sku, username, password, status, created_at) VALUES ('DEL-1', 'del-user-1', 'x', 'available', '2026-01-01')`);
    expect((await call(`/v1/products/${pid}`, { method: 'DELETE' })).status).toBe(409);
    await dbh.run(`DELETE FROM voucher_codes WHERE sku = 'DEL-1'`);
    expect((await call(`/v1/products/${pid}`, { method: 'DELETE' })).status).toBe(200);
    expect(await dbh.query(`SELECT 1 FROM voucher_plans WHERE sku = 'DEL-1'`)).toHaveLength(0);
  });
});

describe('vouchers: locations', () => {
  const list = async () => j(await call('/v1/m/vouchers'));
  const productOf = async (s = sku) => (await rows<{ product_id: string }>(`SELECT product_id FROM variants WHERE sku = ?`, [s]))[0].product_id;

  it('a plan registers its product as a location, once', async () => {
    const pid = await productOf(); const l = await list();
    expect(l.locations.map((x: any) => x.product_id)).toEqual([pid]);
    expect(l.items[0].product_id).toBe(pid);
    expect((await plan()).status).toBe(200);
    expect((await list()).locations).toHaveLength(1);
  });

  it('a location with no plan can exist, and shows with its title', async () => {
    const other = await seedProduct(db()); const pid = await productOf(other.sku);
    expect((await call(`/v1/m/vouchers/locations/${pid}`, { method: 'PUT', json: {} })).status).toBe(200);
    const l = await list(); expect(l.locations).toHaveLength(2);
    expect(l.locations.find((x: any) => x.product_id === pid).title).toBe('Test Product');
    expect(l.items.some((x: any) => x.product_id === pid)).toBe(false);
  });

  it('unknown product: 404', async () => {
    expect((await call('/v1/m/vouchers/locations/nope', { method: 'PUT', json: {} })).status).toBe(404);
  });

  it('a location is removed only when it has no plan', async () => {
    const pid = await productOf();
    expect((await call(`/v1/m/vouchers/locations/${pid}`, { method: 'DELETE' })).status).toBe(409);
    expect((await call(`/v1/m/vouchers/plans/${sku}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/v1/m/vouchers/locations/${pid}`, { method: 'DELETE' })).status).toBe(200);
    expect((await list()).locations).toHaveLength(0);
  });

  it('a location whose product was deleted is not listed', async () => {
    const other = await seedProduct(db()); const pid = await productOf(other.sku);
    await call(`/v1/m/vouchers/locations/${pid}`, { method: 'PUT', json: {} });
    await db().run(`DELETE FROM variants WHERE product_id = ?`, [pid]); await db().run(`DELETE FROM products WHERE id = ?`, [pid]);
    expect((await list()).locations.some((x: any) => x.product_id === pid)).toBe(false);
  });

  it('location instructions are the default; a plan with its own text wins; empty plan text falls back', async () => {
    const pid = await productOf(); const cart = 'cart-loc-instr-1';
    await load('c1'); await order({ cart });
    expect((await call(`/v1/m/vouchers/locations/${pid}`, { method: 'PUT', json: { instructions_fr: 'Réseau Café, page de connexion.', instructions_en: 'Network Café, login page.' } })).status).toBe(200);
    // the plan has its own text (set in beforeEach): it wins
    let r = await j(await call(`/m/vouchers/by-cart/${cart}`, { key: null })); expect(r.items[0].instructions).toBe('Connectez-vous au WiFi.');
    // emptied plan text: the location text is used, in both languages
    await plan({ instructions_fr: '', instructions_en: '' });
    r = await j(await call(`/m/vouchers/by-cart/${cart}`, { key: null })); expect(r.items[0].instructions).toBe('Réseau Café, page de connexion.');
    r = await j(await call(`/m/vouchers/by-cart/${cart}?lang=en`, { key: null })); expect(r.items[0].instructions).toBe('Network Café, login page.');
  });

  it('location instructions are also in the e-mail', async () => {
    const pid = await productOf(); await seedEmailConfig(db());
    await plan({ instructions_fr: '', instructions_en: '' });
    await call(`/v1/m/vouchers/locations/${pid}`, { method: 'PUT', json: { instructions_fr: 'Réseau Café.', instructions_en: 'Network Café.' } });
    await load('c1'); await order({ email: 'x@shop.test' }); await reconcile(); await new Promise((r) => setTimeout(r, 150));
    expect(JSON.stringify(sent)).toContain('Réseau Café.');
  });

  it('only managers write; staff read', async () => {
    expect(roleCanRequest('staff', 'PUT', '/v1/m/vouchers/locations/x').ok).toBe(false);
    expect(roleCanRequest('manager', 'PUT', '/v1/m/vouchers/locations/x').ok).toBe(true);
  });
});
