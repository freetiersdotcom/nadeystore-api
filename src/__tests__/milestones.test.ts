// =============================================================================
// Milestone payments module: a schedule splits an order total into stages; money received fills them in order;
// the merchant requests each stage; the customer sees the whole schedule from the pay link.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedEmailConfig, mockFetch, MOCK_RESPONSES } from './setup';
import { roleCanRequest } from '../auth/permissions';
import { recordPayment } from '../lib/payments';
import { buildStages, withState } from '../modules/milestones/lib';

const stub = () => env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any;
const db = () => getDb(stub());
let adminKey = ''; let ip = 0; let sent: any[] = []; let restore = () => {}; let n = 0;
async function call(path: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) {
  const { key = adminKey, json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.119.${(++ip % 250) + 1}`, ...(rest.headers as any) },
    redirect: 'manual',
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const q = <T = any>(s: string, a: unknown[] = []) => db().query<T>(s, a);
async function order(o: { total?: number; email?: string; status?: string; paid?: number; locale?: string } = {}) {
  const id = crypto.randomUUID(); n++;
  await db().run(`INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, total_cents, currency, locale, pay_token, amount_paid_cents) VALUES (?, ?, ?, ?, ?, 0, ?, 'XOF', ?, ?, ?)`,
    [id, `MS-${1000 + n}`, o.status ?? 'pending', o.email ?? 'ama@shop.test', o.total ?? 100000, o.total ?? 100000, o.locale ?? 'fr', `tok${n}abcdefghij`, o.paid ?? 0]);
  return id;
}
const tokenOf = async (id: string) => (await q<any>(`SELECT pay_token FROM orders WHERE id = ?`, [id]))[0].pay_token as string;
const pay = async (id: string, amount: number) => { const [o] = await q<any>(`SELECT * FROM orders WHERE id = ?`, [id]); await recordPayment(db(), o, { amount_cents: amount, method: 'cash' }); };
const S = (o: any[]) => o.map((s) => ({ label: s.l, ...(s.p != null ? { percent: s.p } : { amount_cents: s.a }), ...(s.d ? { expected_on: s.d } : {}) }));
const put = (id: string, stages: any[], extra: Record<string, unknown> = {}) => call(`/v1/m/milestones/order/${id}`, { method: 'PUT', json: { stages: S(stages), ...extra } });
const T3 = [{ l: 'Signing', p: 30 }, { l: 'Delivery', p: 40 }, { l: 'Completion', p: 30 }];
const get = async (id: string) => j(await call(`/v1/m/milestones/order/${id}`));
const mails = () => sent.filter((m) => !String(m.subject).startsWith('[TEST]'));

beforeEach(async () => {
  const d = db();
  for (const t of ['ms_stages', 'ms_schedules']) await d.run(`DROP TABLE IF EXISTS ${t}`);
  await d.run(`DELETE FROM config WHERE key IN ('modules', 'email')`);
  for (const t of ['refunds', 'order_payments', 'order_items', 'orders', 'api_keys']) await d.run(`DELETE FROM ${t}`);
  adminKey = (await seedApiKeys(d)).adminKey; sent = []; await seedEmailConfig(d);
  restore = mockFetch((url, init) => { if (url.includes('api.resend.com')) { sent.push(JSON.parse(String(init?.body))); return MOCK_RESPONSES.resendSend(); } return new Response('{}', { status: 200 }); });
  expect((await call('/v1/modules/milestones', { method: 'PUT', json: { enabled: true } })).status).toBe(200);
});
afterEach(() => restore());

describe('building stages', () => {
  it('freezes percentages into amounts and lets the last percentage absorb rounding', () => {
    expect(buildStages(10001, [{ label: 'a', percent: 30 }, { label: 'b', percent: 40 }, { label: 'c', percent: 30 }]).map((s) => s.amount_cents)).toEqual([3000, 4000, 3001]);
  });
  it('accepts amounts and mixes, and rejects totals that do not match', () => {
    expect(buildStages(1000, [{ label: 'a', amount_cents: 400 }, { label: 'b', percent: 60 }]).map((s) => s.amount_cents)).toEqual([400, 600]);
    expect(() => buildStages(1000, [{ label: 'a', amount_cents: 400 }, { label: 'b', amount_cents: 500 }])).toThrow(/add up/);
  });
  it('rejects one stage, empty names, both or neither of amount and percent, zero amounts, bad dates', () => {
    expect(() => buildStages(1000, [{ label: 'a', amount_cents: 1000 }])).toThrow();
    expect(() => buildStages(1000, [{ label: ' ', amount_cents: 500 }, { label: 'b', amount_cents: 500 }])).toThrow(/name/);
    expect(() => buildStages(1000, [{ label: 'a', amount_cents: 500, percent: 50 }, { label: 'b', amount_cents: 500 }])).toThrow(/either/);
    expect(() => buildStages(1000, [{ label: 'a' }, { label: 'b', amount_cents: 500 }])).toThrow(/either/);
    expect(() => buildStages(1000, [{ label: 'a', amount_cents: 0 }, { label: 'b', amount_cents: 1000 }])).toThrow();
    expect(() => buildStages(1000, [{ label: 'a', amount_cents: 500, expected_on: '12/01/2026' }, { label: 'b', amount_cents: 500 }])).toThrow(/YYYY-MM-DD/);
  });
  it('pours money into the stages in order', () => {
    const rows = [1, 2, 3].map((pos) => ({ id: String(pos), order_id: 'o', pos, label: 'x', amount_cents: 100, expected_on: null, requested_at: pos === 2 ? 't' : null }));
    expect(withState(rows, 0).map((s) => s.status)).toEqual(['upcoming', 'due', 'upcoming']);
    expect(withState(rows, 150).map((s) => [s.status, s.paid_cents, s.remaining_cents])).toEqual([['paid', 100, 0], ['due', 50, 50], ['upcoming', 0, 100]]);
    expect(withState(rows, 300).every((s) => s.status === 'paid')).toBe(true);
  });
});

describe('creating a schedule', () => {
  it('lists orders that can take one, creates it, then answers with every stage and the pay link', async () => {
    const id = await order(); const paidOrder = await order({ status: 'paid', paid: 100000 }); await order({ status: 'canceled' });
    const c = await j(await call('/v1/m/milestones/candidates')); expect(c.items.map((x: any) => x.id)).toEqual([id]);
    const r = await put(id, T3, { note: 'Custom cabinet' }); expect(r.status).toBe(201);
    const v = await get(id);
    expect(v.stages.map((s: any) => [s.pos, s.label, s.amount_cents, s.status])).toEqual([[1, 'Signing', 30000, 'upcoming'], [2, 'Delivery', 40000, 'upcoming'], [3, 'Completion', 30000, 'upcoming']]);
    expect(v.note).toBe('Custom cabinet'); expect(v.pay_url).toContain(`/fr/paiement/?token=${await tokenOf(id)}`); expect(v.due_now_cents).toBe(0);
    expect((await j(await call('/v1/m/milestones/candidates'))).items).toEqual([]);   // it already has one
    expect((await put(paidOrder, T3)).status).toBe(400);
  });
  it('refuses a canceled order and a schedule that does not add up', async () => {
    const dead = await order({ status: 'canceled' }); expect((await put(dead, T3)).status).toBe(400);
    const id = await order(); const r = await put(id, [{ l: 'a', a: 1 }, { l: 'b', a: 2 }]); expect(r.status).toBe(400); expect((await j(r)).error?.message ?? JSON.stringify(await r.text())).toBeDefined();
    expect((await call(`/v1/m/milestones/order/${id}`)).status).toBe(404);
  });
  it('an order that already received money starts with its first stages paid', async () => {
    const id = await order({ paid: 30000 }); await put(id, T3);
    expect((await get(id)).stages.map((s: any) => s.status)).toEqual(['paid', 'upcoming', 'upcoming']);
  });
});

describe('requesting and paying stages', () => {
  it('request makes the next stage due, e-mails the whole schedule with a pay link, and payments fill stages in order', async () => {
    const id = await order({ locale: 'en' }); await put(id, T3);
    const r = await j(await call(`/v1/m/milestones/order/${id}/request`, { json: {} }));
    expect(r.pos).toBe(1); expect(r.amount_cents).toBe(30000); expect(r.emailed).toBe(true); expect(r.pay_url).toContain('/en/payment/?token=');
    const m = mails()[0]; expect(m.to).toEqual(['ama@shop.test']); expect(m.html).toContain('Signing'); expect(m.html).toContain('Completion'); expect(m.html).toContain(r.pay_url);
    let v = await get(id); expect(v.stages[0].status).toBe('due'); expect(v.due_now_cents).toBe(30000);
    await pay(id, 10000); v = await get(id); expect(v.due_now_cents).toBe(20000); expect(v.stages[0].paid_cents).toBe(10000);
    await pay(id, 20000); v = await get(id); expect(v.stages.map((s: any) => s.status)).toEqual(['paid', 'upcoming', 'upcoming']); expect(v.due_now_cents).toBe(0);
    const r2 = await j(await call(`/v1/m/milestones/order/${id}/request`, { json: { send: false } })); expect(r2.pos).toBe(2); expect(r2.emailed).toBe(false);
    expect(mails().length).toBe(1);
    await pay(id, 70000); v = await get(id); expect(v.stages.every((s: any) => s.status === 'paid')).toBe(true);
    expect((await call(`/v1/m/milestones/order/${id}/request`, { json: {} })).status).toBe(400);
    expect((await q<any>(`SELECT status FROM orders WHERE id = ?`, [id]))[0].status).toBe('paid');
  });
  it('requesting twice does not move on to the next stage', async () => {
    const id = await order(); await put(id, T3);
    await call(`/v1/m/milestones/order/${id}/request`, { json: {} }); const again = await j(await call(`/v1/m/milestones/order/${id}/request`, { json: {} }));
    expect(again.pos).toBe(1); expect((await get(id)).stages.map((s: any) => s.status)).toEqual(['due', 'upcoming', 'upcoming']);
  });
  it('no e-mail goes to a counter-sale or missing address, but the pay link is still returned', async () => {
    const id = await order({ email: 'walk-in@counter.invalid' }); await put(id, T3);
    const r = await j(await call(`/v1/m/milestones/order/${id}/request`, { json: {} })); expect(r.emailed).toBe(false); expect(r.pay_url).toBeTruthy(); expect(mails().length).toBe(0);
  });
  it('a canceled order owes nothing', async () => {
    const id = await order(); await put(id, T3); await call(`/v1/m/milestones/order/${id}/request`, { json: {} });
    await q(`UPDATE orders SET status = 'canceled' WHERE id = ?`, [id]);
    expect((await get(id)).due_now_cents).toBe(0); expect((await call(`/v1/m/milestones/order/${id}/request`, { json: {} })).status).toBe(400);
  });
});

describe('changing a schedule', () => {
  it('paid stages are locked, unpaid ones can change, and the customer is told', async () => {
    const id = await order(); await put(id, T3); await call(`/v1/m/milestones/order/${id}/request`, { json: { send: false } }); await pay(id, 30000);
    expect((await put(id, [{ l: 'Signing', a: 20000 }, { l: 'Rest', a: 80000 }])).status).toBe(409);
    const r = await put(id, [{ l: 'Signing', a: 30000 }, { l: 'Delivery', a: 20000, d: '2026-12-15' }, { l: 'Install', a: 30000 }, { l: 'Handover', a: 20000 }]);
    expect(r.status).toBe(200); expect((await j(r)).notified).toBe(true);
    const v = await get(id); expect(v.stages.map((s: any) => [s.label, s.amount_cents, s.status])).toEqual([['Signing', 30000, 'paid'], ['Delivery', 20000, 'upcoming'], ['Install', 30000, 'upcoming'], ['Handover', 20000, 'upcoming']]);
    expect(v.stages[1].expected_on).toBe('2026-12-15');
    expect(mails().some((m) => /schedule|calendrier/i.test(m.subject))).toBe(true);
  });
  it('a requested stage keeps its request when its amount is unchanged and loses it when the amount changes', async () => {
    const id = await order(); await put(id, T3); await call(`/v1/m/milestones/order/${id}/request`, { json: { send: false } });
    await put(id, [{ l: 'Signing (renamed)', a: 30000 }, { l: 'Delivery', a: 40000 }, { l: 'Completion', a: 30000 }]); let v = await get(id);
    expect(v.stages[0].status).toBe('due'); expect(v.stages[0].label).toBe('Signing (renamed)');
    await put(id, [{ l: 'Signing', a: 25000 }, { l: 'Delivery', a: 45000 }, { l: 'Completion', a: 30000 }]); v = await get(id);
    expect(v.stages[0].status).toBe('upcoming');
  });
  it('nobody is e-mailed for a schedule the customer has never seen', async () => {
    const id = await order(); await put(id, T3); const r = await put(id, [{ l: 'A', a: 50000 }, { l: 'B', a: 50000 }]);
    expect((await j(r)).notified).toBe(false); expect(mails().length).toBe(0);
  });
  it('removing a schedule leaves the payments alone', async () => {
    const id = await order(); await put(id, T3); await pay(id, 30000);
    expect((await call(`/v1/m/milestones/order/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/v1/m/milestones/order/${id}`)).status).toBe(404);
    expect(Number((await q<any>(`SELECT amount_paid_cents FROM orders WHERE id = ?`, [id]))[0].amount_paid_cents)).toBe(30000);
  });
});

describe('the customer view and access', () => {
  it('the pay link shows the schedule and the amount due now; unknown links and orders without one show nothing', async () => {
    const id = await order(); await put(id, T3, { note: 'n' }); await call(`/v1/m/milestones/order/${id}/request`, { json: { send: false } }); await pay(id, 10000);
    const r = await SELF.fetch(`http://localhost/m/milestones/pay/${await tokenOf(id)}`); expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store');
    const v = await j(r); expect(v.due_now_cents).toBe(20000); expect(v.paid_cents).toBe(10000); expect(v.stages.map((s: any) => s.status)).toEqual(['due', 'upcoming', 'upcoming']);
    expect(JSON.stringify(v)).not.toContain('ama@shop.test');
    expect((await j(await SELF.fetch('http://localhost/m/milestones/pay/doesnotexist123'))).stages).toEqual([]);
    const plain = await order(); expect((await j(await SELF.fetch(`http://localhost/m/milestones/pay/${await tokenOf(plain)}`))).stages).toEqual([]);
  });
  it('is invisible while the module is off', async () => {
    const id = await order(); await put(id, T3); const tok = await tokenOf(id);
    await call('/v1/modules/milestones', { method: 'PUT', json: { enabled: false } });
    expect((await SELF.fetch(`http://localhost/m/milestones/pay/${tok}`)).status).toBe(404); expect((await call('/v1/m/milestones')).status).toBeGreaterThanOrEqual(400);
  });
  it('managers write, staff only read, the public cannot reach the admin API', async () => {
    expect(roleCanRequest('manager', 'PUT', '/v1/m/milestones/order/x').ok).toBe(true);
    expect(roleCanRequest('staff', 'GET', '/v1/m/milestones').ok).toBe(true); expect(roleCanRequest('staff', 'PUT', '/v1/m/milestones/order/x').ok).toBe(false);
    expect((await call('/v1/m/milestones', { key: null })).status).toBe(401);
  });
  it('the list shows progress and the next stage', async () => {
    const id = await order(); await put(id, T3); await pay(id, 30000);
    const l = await j(await call('/v1/m/milestones')); expect(l.items[0]).toMatchObject({ number: expect.any(String), stages: 3, stages_paid: 1, next: { pos: 2, label: 'Delivery' } });
    expect((await j(await call('/v1/m/milestones?q=nomatch'))).items).toEqual([]);
  });
});
