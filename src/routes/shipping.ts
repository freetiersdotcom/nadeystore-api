import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { CartIdParam, ErrorResponse } from '../schemas';
import {
  quoteShipping, getShippingSettings, saveShippingSettings, listZones,
  variantsMissingWeight, seedStarterZones, resolveCartShipping, type ShippingSettings,
} from '../lib/shipping';

// =============================================================================
// Shipping
//   POST  /v1/carts/shipping-quote            storefront: delivery options + prices for a destination
//   PATCH /v1/carts/:cartId/shipping-method   storefront: choose one of the options for a cart
//   GET|PUT /v1/shipping/settings             admin
//   GET|POST /v1/shipping/zones               admin (zones come with their rates)
//   PUT|DELETE /v1/shipping/zones/:id         admin
//   POST /v1/shipping/zones/:id/rates         admin
//   PUT|DELETE /v1/shipping/rates/:id         admin
//   GET  /v1/shipping/missing-weights         admin: physical variants with no weight
//   POST /v1/shipping/starter                 admin: load editable example zones (only when there are none)
//   POST /v1/shipping/test                    admin: price a destination + weight
// =============================================================================

const j = (description: string, schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } }, description });
const err = (d: string) => j(d, ErrorResponse);

const Option = z.object({
  id: z.string(), kind: z.enum(['flat', 'weight', 'pickup']),
  name_fr: z.string(), name_en: z.string(),
  cents: z.number().int(), free: z.boolean(),
  min_days: z.number().int().nullable(), max_days: z.number().int().nullable(),
  pickup_address: z.string().nullable(),
}).openapi('ShippingOption');

const QuoteResponse = z.object({
  enabled: z.boolean(), needed: z.boolean(), deliverable: z.boolean(),
  reason: z.enum(['no_zone', 'too_heavy', 'currency', 'no_address']).optional(),
  currency: z.string(), weight_g: z.number().int(), estimated: z.boolean(),
  zone: z.object({ id: z.string(), name: z.string() }).nullable(),
  options: z.array(Option),
}).openapi('ShippingQuote');

// ─────────────────────────────── storefront ──────────────────────────────────
export const shippingCart = new OpenAPIHono<HonoEnv>();
shippingCart.use('*', authMiddleware);

const QuoteBody = z.object({
  items: z.array(z.object({ sku: z.string().min(1), qty: z.number().int().positive().max(999) })).min(1).max(50),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  country: z.string().length(2).optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
  discount_cents: z.number().int().min(0).optional().openapi({ description: 'Discount already applied to the goods (for “free over X”).' }),
}).openapi('ShippingQuoteBody');

shippingCart.openapi(createRoute({
  method: 'post', path: '/shipping-quote', tags: ['Checkout'],
  summary: 'Delivery options and prices for a destination, before any cart exists',
  description: 'Prices come from the catalog and the shipping rates. With shipping switched off, `enabled` is false and the storefront shows nothing.',
  request: { body: { content: { 'application/json': { schema: QuoteBody } } } },
  responses: { 200: j('Quote', QuoteResponse), 400: err('Unknown SKU') },
}), async (c) => {
  const b = c.req.valid('json');
  const db = getDb(c.var.db);
  let goods = 0;
  for (const it of b.items) {
    const [v] = await db.query<{ price_cents: number }>(`SELECT price_cents FROM variants WHERE sku = ? LIMIT 1`, [it.sku]);
    if (!v) throw ApiError.invalidRequest(`Unknown SKU: ${it.sku}`);
    goods += Number(v.price_cents) * it.qty;
  }
  const q = await quoteShipping(db, {
    items: b.items, goods_cents: Math.max(goods - (b.discount_cents ?? 0), 0),
    currency: b.currency ?? 'XOF', country: b.country, city: b.city, state: b.state,
  });
  return c.json(q, 200);
});

shippingCart.openapi(createRoute({
  method: 'patch', path: '/{cartId}/shipping-method', tags: ['Checkout'],
  summary: 'Choose the delivery option of a cart',
  description: 'Needs the delivery address to be set first. The price is recomputed here and again at checkout.',
  request: { params: CartIdParam, body: { content: { 'application/json': { schema: z.object({ rate_id: z.string().min(1) }) } } } },
  responses: {
    200: j('Chosen option', z.object({ rate_id: z.string().nullable(), label: z.string().nullable(), shipping_cents: z.number().int() })),
    400: err('Not available'), 404: err('Cart not found'),
  },
}), async (c) => {
  const { cartId } = c.req.valid('param');
  const { rate_id } = c.req.valid('json');
  const db = getDb(c.var.db);
  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ? AND status = 'open'`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');
  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
  cart.shipping_rate_id = rate_id;
  const r = await resolveCartShipping(db, cart, items, Number(cart.discount_amount_cents ?? 0));
  if (r.rate_id !== rate_id) {
    throw new ApiError('shipping_option_unavailable', 400, 'This delivery option is not available for this order.');
  }
  return c.json({ rate_id: r.rate_id, label: r.label, shipping_cents: r.cents }, 200);
});

// ─────────────────────────────── admin ───────────────────────────────────────
export const shippingAdmin = new OpenAPIHono<HonoEnv>();
shippingAdmin.use('*', authMiddleware);

const Settings = z.object({
  enabled: z.boolean(),
  default_weight_g: z.number().int().min(1).max(100000),
  free_over_cents: z.number().int().min(1).nullable(),
  base_currency: z.string().regex(/^[A-Za-z]{3}$/),
  fx: z.record(z.string(), z.number().positive()),
}).openapi('ShippingSettings');

shippingAdmin.openapi(createRoute({
  method: 'get', path: '/settings', tags: ['Shipping'], summary: 'Shipping settings', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  responses: { 200: j('Settings', Settings) },
}), async (c) => c.json(await getShippingSettings(getDb(c.var.db)), 200));

shippingAdmin.openapi(createRoute({
  method: 'put', path: '/settings', tags: ['Shipping'], summary: 'Update shipping settings', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  request: { body: { content: { 'application/json': { schema: Settings.partial() } } } },
  responses: { 200: j('Settings', Settings) },
}), async (c) => {
  const db = getDb(c.var.db);
  const next: ShippingSettings = { ...(await getShippingSettings(db)), ...c.req.valid('json') } as ShippingSettings;
  await saveShippingSettings(db, next);
  return c.json(await getShippingSettings(db), 200);
});

const Band = z.object({ up_to_g: z.number().int().min(1), cents: z.number().int().min(0) });
const RateBody = z.object({
  name_fr: z.string().min(1).max(120),
  name_en: z.string().min(1).max(120),
  kind: z.enum(['flat', 'weight', 'pickup']),
  flat_cents: z.number().int().min(0).default(0),
  bands: z.array(Band).max(20).default([]),
  over_per_kg_cents: z.number().int().min(0).nullable().default(null),
  free_over_cents: z.number().int().min(1).nullable().default(null),
  min_days: z.number().int().min(0).max(365).nullable().default(null),
  max_days: z.number().int().min(0).max(365).nullable().default(null),
  pickup_address: z.string().max(300).nullable().default(null),
  active: z.boolean().default(true),
  position: z.number().int().default(0),
}).openapi('ShippingRateBody');

const RateOut = RateBody.extend({ id: z.string(), zone_id: z.string() }).openapi('ShippingRate');

const ZoneBody = z.object({
  name: z.string().min(1).max(120),
  countries: z.array(z.string().regex(/^([A-Za-z]{2}|\*)$/)).min(1).max(250),
  regions: z.array(z.string().min(1).max(120)).max(100).default([]),
  active: z.boolean().default(true),
  position: z.number().int().default(0),
}).openapi('ShippingZoneBody');

const ZoneOut = ZoneBody.extend({ id: z.string(), rates: z.array(RateOut) }).openapi('ShippingZone');

const IdParam = z.object({ id: z.string().min(1) });

shippingAdmin.openapi(createRoute({
  method: 'get', path: '/zones', tags: ['Shipping'], summary: 'Zones with their rates', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  responses: { 200: j('Zones', z.object({ data: z.array(ZoneOut) })) },
}), async (c) => c.json({ data: await listZones(getDb(c.var.db)) }, 200));

shippingAdmin.openapi(createRoute({
  method: 'post', path: '/zones', tags: ['Shipping'], summary: 'Create a zone', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  request: { body: { content: { 'application/json': { schema: ZoneBody } } } },
  responses: { 200: j('Zone', ZoneOut) },
}), async (c) => {
  const b = c.req.valid('json');
  const db = getDb(c.var.db);
  const id = uuid();
  await db.run(
    `INSERT INTO shipping_zones (id, name, countries, regions, active, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, b.name.trim(), JSON.stringify(b.countries.map((x) => x.toUpperCase())), JSON.stringify(b.regions), b.active ? 1 : 0, b.position, now()]
  );
  const z = (await listZones(db)).find((x) => x.id === id)!;
  return c.json(z, 200);
});

shippingAdmin.openapi(createRoute({
  method: 'put', path: '/zones/{id}', tags: ['Shipping'], summary: 'Update a zone', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  request: { params: IdParam, body: { content: { 'application/json': { schema: ZoneBody.partial() } } } },
  responses: { 200: j('Zone', ZoneOut), 404: err('Not found') },
}), async (c) => {
  const { id } = c.req.valid('param');
  const b = c.req.valid('json');
  const db = getDb(c.var.db);
  const [row] = await db.query<any>(`SELECT id FROM shipping_zones WHERE id = ?`, [id]);
  if (!row) throw ApiError.notFound('Zone not found');
  const sets: string[] = []; const p: unknown[] = [];
  if (b.name !== undefined) { sets.push('name = ?'); p.push(b.name.trim()); }
  if (b.countries !== undefined) { sets.push('countries = ?'); p.push(JSON.stringify(b.countries.map((x) => x.toUpperCase()))); }
  if (b.regions !== undefined) { sets.push('regions = ?'); p.push(JSON.stringify(b.regions)); }
  if (b.active !== undefined) { sets.push('active = ?'); p.push(b.active ? 1 : 0); }
  if (b.position !== undefined) { sets.push('position = ?'); p.push(b.position); }
  if (sets.length) await db.run(`UPDATE shipping_zones SET ${sets.join(', ')} WHERE id = ?`, [...p, id]);
  return c.json((await listZones(db)).find((x) => x.id === id)!, 200);
});

shippingAdmin.openapi(createRoute({
  method: 'delete', path: '/zones/{id}', tags: ['Shipping'], summary: 'Delete a zone and its rates', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  request: { params: IdParam },
  responses: { 200: j('Deleted', z.object({ deleted: z.boolean() })), 404: err('Not found') },
}), async (c) => {
  const { id } = c.req.valid('param');
  const db = getDb(c.var.db);
  const [row] = await db.query<any>(`SELECT id FROM shipping_zones WHERE id = ?`, [id]);
  if (!row) throw ApiError.notFound('Zone not found');
  await db.run(`DELETE FROM shipping_rates WHERE zone_id = ?`, [id]);
  await db.run(`DELETE FROM shipping_zones WHERE id = ?`, [id]);
  return c.json({ deleted: true }, 200);
});

const rateValues = (b: z.infer<typeof RateBody>) => [
  b.name_fr.trim(), b.name_en.trim(), b.kind, b.flat_cents,
  JSON.stringify([...b.bands].sort((x, y) => x.up_to_g - y.up_to_g)),
  b.over_per_kg_cents, b.free_over_cents, b.min_days, b.max_days,
  b.pickup_address?.trim() || null, b.active ? 1 : 0, b.position,
];

shippingAdmin.openapi(createRoute({
  method: 'post', path: '/zones/{id}/rates', tags: ['Shipping'], summary: 'Add a rate to a zone', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  request: { params: IdParam, body: { content: { 'application/json': { schema: RateBody } } } },
  responses: { 200: j('Rate', RateOut), 404: err('Zone not found') },
}), async (c) => {
  const { id } = c.req.valid('param');
  const b = c.req.valid('json');
  const db = getDb(c.var.db);
  const [z] = await db.query<any>(`SELECT id FROM shipping_zones WHERE id = ?`, [id]);
  if (!z) throw ApiError.notFound('Zone not found');
  const rid = uuid();
  await db.run(
    `INSERT INTO shipping_rates (id, zone_id, name_fr, name_en, kind, flat_cents, bands, over_per_kg_cents, free_over_cents, min_days, max_days, pickup_address, active, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [rid, id, ...rateValues(b)]
  );
  const rate = (await listZones(db)).flatMap((x) => x.rates).find((r) => r.id === rid)!;
  return c.json(rate, 200);
});

shippingAdmin.openapi(createRoute({
  method: 'put', path: '/rates/{id}', tags: ['Shipping'], summary: 'Update a rate', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  request: { params: IdParam, body: { content: { 'application/json': { schema: RateBody } } } },
  responses: { 200: j('Rate', RateOut), 404: err('Not found') },
}), async (c) => {
  const { id } = c.req.valid('param');
  const b = c.req.valid('json');
  const db = getDb(c.var.db);
  const [r] = await db.query<any>(`SELECT id FROM shipping_rates WHERE id = ?`, [id]);
  if (!r) throw ApiError.notFound('Rate not found');
  await db.run(
    `UPDATE shipping_rates SET name_fr = ?, name_en = ?, kind = ?, flat_cents = ?, bands = ?, over_per_kg_cents = ?,
       free_over_cents = ?, min_days = ?, max_days = ?, pickup_address = ?, active = ?, position = ? WHERE id = ?`,
    [...rateValues(b), id]
  );
  const rate = (await listZones(db)).flatMap((x) => x.rates).find((x) => x.id === id)!;
  return c.json(rate, 200);
});

shippingAdmin.openapi(createRoute({
  method: 'delete', path: '/rates/{id}', tags: ['Shipping'], summary: 'Delete a rate', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  request: { params: IdParam },
  responses: { 200: j('Deleted', z.object({ deleted: z.boolean() })), 404: err('Not found') },
}), async (c) => {
  const { id } = c.req.valid('param');
  const db = getDb(c.var.db);
  const res = await db.run(`DELETE FROM shipping_rates WHERE id = ?`, [id]);
  if (res.changes === 0) throw ApiError.notFound('Rate not found');
  return c.json({ deleted: true }, 200);
});

shippingAdmin.openapi(createRoute({
  method: 'get', path: '/missing-weights', tags: ['Shipping'],
  summary: 'Physical variants without a weight', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  responses: { 200: j('Variants', z.object({ data: z.array(z.object({ variant_id: z.string(), sku: z.string(), title: z.string(), product_title: z.string(), product_id: z.string() })) })) },
}), async (c) => c.json({ data: await variantsMissingWeight(getDb(c.var.db)) }, 200));

shippingAdmin.openapi(createRoute({
  method: 'post', path: '/starter', tags: ['Shipping'],
  summary: 'Load example zones and rates (only when there are none)', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  responses: { 200: j('Created', z.object({ created: z.number().int() })) },
}), async (c) => c.json({ created: await seedStarterZones(getDb(c.var.db)) }, 200));

shippingAdmin.openapi(createRoute({
  method: 'post', path: '/test', tags: ['Shipping'],
  summary: 'Price a destination and a weight (what a customer would see)', security: [{ bearerAuth: [] }], middleware: [adminOnly] as const,
  request: { body: { content: { 'application/json': { schema: z.object({
    country: z.string().length(2), city: z.string().optional(), state: z.string().optional(),
    weight_g: z.number().int().min(0), goods_cents: z.number().int().min(0).default(0),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  }) } } } },
  responses: { 200: j('Quote', QuoteResponse) },
}), async (c) => {
  const b = c.req.valid('json');
  const db = getDb(c.var.db);
  const s = await getShippingSettings(db);
  // The test works even while shipping is still switched off for customers.
  const q = await quoteShipping(db, { ...b, currency: b.currency ?? s.base_currency, force: true });
  return c.json(q, 200);
});
