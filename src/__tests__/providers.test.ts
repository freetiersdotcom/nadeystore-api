// =============================================================================
// Appointment providers: several people offering the same services, each with their own agenda.
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { getDb } from '../db';
import { seedApiKeys, seedProduct, seedCart } from './setup';
import { bookableSku, listSlots, holdSlot, confirmBookings, adminSchedule, providersFor, withinHours } from '../lib/appointments';

const db = () => getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as any);
let adminKey = ''; let ip = 0; let sku = ''; let productId = '';
async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  return SELF.fetch(`http://localhost${path}`, {
    ...rest, ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
    headers: { Authorization: `Bearer ${adminKey}`, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': `198.51.115.${(++ip % 250) + 1}` },
  });
}
const j = async (r: Response) => r.json() as Promise<any>;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: '09:00', end: '17:00' }));
const at = (h: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 2); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
const addProvider = async (id: string, name: string, extra: { rules?: unknown[]; active?: number } = {}) =>
  db().run(`INSERT INTO booking_resources (id, name, active, position, rules, created_at) VALUES (?, ?, ?, (SELECT COUNT(*) FROM booking_resources), ?, '2026-01-01')`, [id, name, extra.active ?? 1, JSON.stringify(extra.rules ?? [])]);
const cart = () => seedCart(db(), [{ sku, qty: 1, price_cents: 5000 }]);
const bk = async () => (await bookableSku(db(), sku))!;
const slotAt = async (h: number, provider?: string) => (await listSlots(db(), await bk(), Date.now(), 4, Date.now(), provider)).find((s) => s.start === at(h))!;

beforeEach(async () => {
  const d = db();
  for (const t of ['appointments', 'booking_blocks', 'booking_service_resources', 'booking_resources', 'booking_services']) await d.run(`DELETE FROM ${t}`);
  await d.run(`DELETE FROM cart_items`); await d.run(`DELETE FROM carts`);
  adminKey = (await seedApiKeys(d)).adminKey;
  const p = await seedProduct(d, { price_cents: 5000, on_hand: 0 });
  sku = p.sku;
  await d.run(`UPDATE variants SET product_type = 'service' WHERE sku = ?`, [sku]);
  [{ product_id: productId }] = await d.query<any>(`SELECT product_id FROM variants WHERE sku = ?`, [sku]) as any;
  await d.run(`INSERT INTO booking_services (product_id, enabled, tz, rules, lead_hours, horizon_days, buffer_min, step_min, default_duration_min, durations) VALUES (?, 1, 'UTC', ?, 0, 30, 0, 60, 60, '{}')`, [productId, JSON.stringify(ALL_DAYS)]);
  await d.run(`INSERT INTO booking_resources (id, name, active, position, rules, created_at) VALUES ('default', 'Main', 1, 0, '[]', '2026-01-01')`);
});

describe('one provider (the default): nothing changes', () => {
  it('slots are offered and held on the default provider', async () => {
    const s = await slotAt(10);
    expect(s.available).toBe(true); expect(s.resource_ids).toEqual(['default']);
    const h = await holdSlot(db(), await cart(), sku, at(10));
    expect(h.resource_id).toBe('default');
    expect((await slotAt(10)).available).toBe(false);
  });
});

describe('two providers', () => {
  beforeEach(async () => { await addProvider('p-b', 'Brice'); });

  it('"any available" gives two customers the same hour, and a third is refused', async () => {
    const h1 = await holdSlot(db(), await cart(), sku, at(10));
    const h2 = await holdSlot(db(), await cart(), sku, at(10));
    expect(new Set([h1.resource_id, h2.resource_id]).size).toBe(2);
    await expect(holdSlot(db(), await cart(), sku, at(10))).rejects.toMatchObject({ statusCode: 409 });
    expect((await slotAt(10)).available).toBe(false);
  });

  it('the least busy provider of the day is chosen first', async () => {
    const first = await holdSlot(db(), await cart(), sku, at(9));       // someone gets 9:00
    const second = await holdSlot(db(), await cart(), sku, at(11));     // the other one should get 11:00
    expect(second.resource_id).not.toBe(first.resource_id);
  });

  it('a chosen provider is respected, and refused only when that provider is taken', async () => {
    const h = await holdSlot(db(), await cart(), sku, at(10), null, 'p-b');
    expect(h.resource_id).toBe('p-b');
    await expect(holdSlot(db(), await cart(), sku, at(10), null, 'p-b')).rejects.toMatchObject({ statusCode: 409 });
    expect((await holdSlot(db(), await cart(), sku, at(10), null, 'default')).resource_id).toBe('default');
    expect((await slotAt(10, 'p-b')).available).toBe(false);
  });

  it('the booking keeps its provider when the hold becomes a booking', async () => {
    const h = await holdSlot(db(), await cart(), sku, at(14), null, 'p-b');
    const [{ cart_id }] = await db().query<any>(`SELECT cart_id FROM appointments WHERE id = ?`, [h.id]);
    const r = await confirmBookings(db(), cart_id, 'ord-1');
    expect(r.booked).toHaveLength(1);
    const [a] = await db().query<any>(`SELECT resource_id, status FROM appointments WHERE id = ?`, [h.id]);
    expect(a).toMatchObject({ resource_id: 'p-b', status: 'booked' });
  });

  it("a provider's own hours narrow what they are offered", async () => {
    await db().run(`UPDATE booking_resources SET rules = ? WHERE id = 'p-b'`, [JSON.stringify([{ dow: 0, start: '09:00', end: '12:00' }, { dow: 1, start: '09:00', end: '12:00' }, { dow: 2, start: '09:00', end: '12:00' }, { dow: 3, start: '09:00', end: '12:00' }, { dow: 4, start: '09:00', end: '12:00' }, { dow: 5, start: '09:00', end: '12:00' }, { dow: 6, start: '09:00', end: '12:00' }])]);
    expect((await slotAt(10)).resource_ids.sort()).toEqual(['default', 'p-b']);
    expect((await slotAt(15)).resource_ids).toEqual(['default']);
    await expect(holdSlot(db(), await cart(), sku, at(15), null, 'p-b')).rejects.toMatchObject({ statusCode: 400 });
    const [pb] = await providersFor(db(), productId).then((l) => l.filter((p) => p.id === 'p-b'));
    expect(withinHours(pb, 'UTC', Date.parse(at(11)), Date.parse(at(12)))).toBe(true);
    expect(withinHours(pb, 'UTC', Date.parse(at(11)) + 30 * 60000, Date.parse(at(12)) + 30 * 60000)).toBe(false);
  });

  it('time off for one provider leaves the other available; a shared block closes both', async () => {
    const s = new Date(at(10)).getTime();
    const mk = (res: string | null) => call('/v1/bookings/blocks', { json: { starts_at: new Date(s).toISOString(), ends_at: new Date(s + 3600_000).toISOString(), resource_id: res } });
    expect((await mk('p-b')).status).toBe(201);
    expect((await slotAt(10)).resource_ids).toEqual(['default']);
    expect((await mk(null)).status).toBe(201);
    expect((await slotAt(10)).available).toBe(false);
  });

  it('a service limited to some providers only offers those', async () => {
    const r = await call(`/v1/bookings/services/${productId}`, { method: 'PUT', json: { enabled: true, tz: 'UTC', rules: ALL_DAYS, lead_hours: 0, horizon_days: 30, buffer_min: 0, step_min: 60, default_duration_min: 60, durations: {}, resource_ids: ['p-b'] } });
    expect(r.status).toBe(200);
    expect((await slotAt(10)).resource_ids).toEqual(['p-b']);
    const list = await j(await call('/v1/bookings/services'));
    expect(list.items.find((x: any) => x.product_id === productId).resource_ids).toEqual(['p-b']);
    await call(`/v1/bookings/services/${productId}`, { method: 'PUT', json: { enabled: true, tz: 'UTC', rules: ALL_DAYS, resource_ids: [] } });
    expect((await slotAt(10)).resource_ids.sort()).toEqual(['default', 'p-b']);
  });

  it('an inactive provider is never offered', async () => {
    await db().run(`UPDATE booking_resources SET active = 0 WHERE id = 'p-b'`);
    expect((await slotAt(10)).resource_ids).toEqual(['default']);
  });

  it('the slots route lists the providers and accepts a provider filter', async () => {
    const d = await j(await call(`/v1/bookings/slots?sku=${sku}&days=4&provider=p-b`));
    expect(d.providers.map((p: any) => p.id).sort()).toEqual(['default', 'p-b']);
    expect(d.slots.every((s: any) => s.resource_ids.every((r: string) => r === 'p-b'))).toBe(true);
  });

  it('the admin books for an order on a chosen provider, and cannot double-book that provider', async () => {
    await db().run(`INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, service_status, created_at) VALUES ('o-1', 'N-1', 'paid', 'a@b.c', 5000, 0, 0, 5000, 'XOF', 'to_schedule', '2026-01-01')`);
    await db().run(`INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES ('oi-1', 'o-1', ?, 'S', 1, 5000)`, [sku]);
    const r = await call('/v1/bookings/appointments', { json: { order_id: 'o-1', start: at(10), resource_id: 'p-b', notify: false } });
    expect(r.status).toBe(201);
    expect((await j(r)).resource_id).toBe('p-b');
    await db().run(`INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, service_status, created_at) VALUES ('o-2', 'N-2', 'paid', 'a@b.c', 5000, 0, 0, 5000, 'XOF', 'to_schedule', '2026-01-01')`);
    await db().run(`INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES ('oi-2', 'o-2', ?, 'S', 1, 5000)`, [sku]);
    expect((await call('/v1/bookings/appointments', { json: { order_id: 'o-2', start: at(10), resource_id: 'p-b', notify: false } })).status).toBe(409);
    // no provider named: the free one is used
    const r3 = await call('/v1/bookings/appointments', { json: { order_id: 'o-2', start: at(10), notify: false } });
    expect(r3.status).toBe(201); expect((await j(r3)).resource_id).toBe('default');
    // move the first one to the other provider: refused, they are busy there
    const id1 = (await j(await call('/v1/bookings/agenda?status=booked'))).items.find((x: any) => x.order_id === 'o-1').id;
    expect((await call(`/v1/bookings/appointments/${id1}`, { method: 'PATCH', json: { start: at(10), resource_id: 'default', notify: false } })).status).toBe(409);
    // agenda shows the provider and can be filtered
    const ag = await j(await call('/v1/bookings/agenda?resource_id=p-b'));
    expect(ag.items.map((x: any) => x.order_id)).toEqual(['o-1']);
    expect(ag.items[0].resource_name).toBe('Brice');
  });
});

describe('managing providers', () => {
  it('add, rename, hide, and the guards that keep bookings working', async () => {
    const created = await j(await call('/v1/bookings/providers', { json: { name: 'Brice' } }));
    expect(created.name).toBe('Brice');
    const list = await j(await call('/v1/bookings/providers'));
    expect(list.items.map((p: any) => p.name)).toEqual(['Main', 'Brice']);
    expect((await call(`/v1/bookings/providers/${created.id}`, { method: 'PUT', json: { name: 'Brice K.', rules: [{ dow: 1, start: '09:00', end: '12:00' }] } })).status).toBe(200);
    expect((await providersFor(db(), productId)).find((p) => p.id === created.id)!.rules).toHaveLength(1);
    // the last active provider cannot be hidden or deleted
    expect((await call(`/v1/bookings/providers/${created.id}`, { method: 'PUT', json: { active: false } })).status).toBe(200);
    expect((await call('/v1/bookings/providers/default', { method: 'PUT', json: { active: false } })).status).toBe(409);
    // a provider with appointments on record cannot be deleted
    await db().run(`UPDATE booking_resources SET active = 1, rules = '[]' WHERE id = ?`, [created.id]);
    await holdSlot(db(), await cart(), sku, at(10), null, created.id);
    expect((await call(`/v1/bookings/providers/${created.id}`, { method: 'DELETE' })).status).toBe(409);
    await db().run(`DELETE FROM appointments`);
    expect((await call(`/v1/bookings/providers/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call('/v1/bookings/providers/default', { method: 'DELETE' })).status).toBe(409);   // the only one left
    expect((await call('/v1/bookings/providers', { json: { name: '   ' } })).status).toBe(400);
  });
});
