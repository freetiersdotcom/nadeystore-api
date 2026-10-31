import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from '@hono/zod-openapi';
import { getDb, type Database } from '../db';
import { ApiError, isValidEmail, type HonoEnv } from '../types';
import { sha256Hex } from '../auth/crypto';
import { clientIp, } from '../auth/http';
import { throttle } from '../auth/service';
import {
  CUSTOMER_CODE_MAX_ATTEMPTS, CUSTOMER_SESSION_PREFIX, CUSTOMER_TOKEN_TTL_MIN, consumeCustomerCode,
  consumeCustomerLink, createCustomerSession, issueCustomerToken, lookupCustomerSession, normCustomerEmail,
  openCustomer, publicCustomer, revokeCustomerSession, revokeCustomerSessions, type CustomerSession,
} from '../account/service';
import {
  accountConfirmUrl, clearCustomerCookie, isStoreOrigin, readCustomerCookie, setCustomerCookie,
} from '../account/http';
import { sendCustomerLoginEmail } from '../account/email';
import { verifyTurnstile } from '../lib/turnstile';
import { normalizePhone, resolveContact } from '../lib/geo';
import { createDownloadTokens, DOWNLOAD_DEFAULTS } from '../lib/downloads';
import { payUrl } from '../lib/email/planNotice';

// =============================================================================
// /v1/account: the storefront customer's own area
//
//  public
//   GET  /config                                  which sign-in options exist
//   POST /login-link   { email, locale?, turnstile_token? }   emails a link + 6-digit code
//   POST /verify       { token } | { email, code }, mode      redeems it, starts a session
//  signed in as a customer (cookie __Host-cid, or Authorization: Bearer cus_…)
//   GET/PATCH /me · POST /logout · POST /logout-all
//   GET /orders · GET /orders/:number · POST /orders/:number/downloads { sku }
//   GET/POST /addresses · PATCH/DELETE /addresses/:id
//
// A customer session is a different kind of credential from an admin session: it is
// stored in other tables, has another prefix and cookie, and is only ever read here.
// Everything a customer sees is selected by THEIR customer id / verified email.
// =============================================================================

type AcctEnv = { Bindings: HonoEnv['Bindings']; Variables: HonoEnv['Variables'] & { acct: CustomerSession } };

export const accountRoutes = new Hono<AcctEnv>();

accountRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

async function readJson(c: any): Promise<unknown> {
  try { return await c.req.json(); } catch { return {}; }
}

async function limit(c: any, db: Database, key: string, max: number, windowSec: number) {
  const r = await throttle(db, key, max, windowSec);
  if (!r.allowed) {
    c.header('Retry-After', String(r.retryAfter));
    throw new ApiError('rate_limit_exceeded', 429, `Too many attempts. Try again in ${Math.max(1, Math.ceil(r.retryAfter / 60))} minute(s).`);
  }
}

const emailSchema = z.string().trim().max(254).refine(isValidEmail, 'Invalid email address');
const modeSchema = z.enum(['cookie', 'bearer']).default('bearer');
const localeSchema = z.enum(['fr', 'en']).optional();
const storeName = (c: any) => (c.env.STORE_NAME as string | undefined) ?? 'Your Store';

// ---------------------------------------------------------------------------
// Customer authentication
// ---------------------------------------------------------------------------
const customerAuth = createMiddleware<AcctEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const cookie = bearer === null ? readCustomerCookie(c) : undefined;
  const token = bearer ?? cookie;
  if (!token) throw ApiError.unauthorized('Sign in to see your account');
  if (!token.startsWith(CUSTOMER_SESSION_PREFIX)) throw ApiError.unauthorized('Session expired or invalid');

  // A cookie is sent by the browser on its own, so a state-changing request must come
  // from one of our own storefront origins. (A bearer token is not ambient: no check.)
  if (!bearer && !SAFE.has(c.req.method) && !isStoreOrigin(c.env, c.req.header('Origin'))) {
    throw ApiError.forbidden('Cross-site request blocked');
  }
  const found = await lookupCustomerSession(getDb(c.var.db), token);
  if (!found) throw ApiError.unauthorized('Session expired or invalid');
  c.set('acct', found);
  await next();
});

function assertModeAllowed(c: any, mode: 'cookie' | 'bearer') {
  if (mode === 'cookie' && !isStoreOrigin(c.env, c.req.header('Origin'))) {
    throw ApiError.invalidRequest('Cookie sessions are not available from this origin. Use mode "bearer", or add the storefront URL to STORE_ORIGINS.');
  }
}

// ---------------------------------------------------------------------------
// GET /config
// ---------------------------------------------------------------------------
accountRoutes.get('/config', (c) => {
  return c.json({
    methods: { link: true, code: true },
    cookie_mode: isStoreOrigin(c.env, c.req.header('Origin')),
    turnstile: !!(c.env as any).TURNSTILE_SECRET,
  });
});

// ---------------------------------------------------------------------------
// POST /login-link
// ---------------------------------------------------------------------------
const LoginLinkBody = z.object({ email: emailSchema, locale: localeSchema, turnstile_token: z.string().max(4096).optional() });

accountRoutes.post('/login-link', async (c) => {
  const b = parse(LoginLinkBody, await readJson(c));
  const email = normCustomerEmail(b.email);
  const db = getDb(c.var.db);
  const ip = clientIp(c);

  // Anyone can ask for an email to be sent to any address, so this is limited per address
  // (nobody can be flooded) and per client, and protected by Turnstile when it is configured.
  await limit(c, db, `acct-link:ip:${ip}`, 10, 3600);
  await limit(c, db, `acct-link:email:${(await sha256Hex(email)).slice(0, 32)}`, 5, 3600);
  const secret = (c.env as any).TURNSTILE_SECRET as string | undefined;
  if (secret && !(await verifyTurnstile(secret, b.turnstile_token, ip))) {
    throw new ApiError('captcha_failed', 400, 'Verification failed. Please try again.');
  }

  const locale = b.locale ?? 'fr';
  const issued = await issueCustomerToken(db, email, c.env.PASSWORD_PEPPER);
  const job = sendCustomerLoginEmail(db, {
    to: email, storeName: storeName(c), link: accountConfirmUrl(c.env, locale, issued.token),
    code: issued.code, ttlMinutes: CUSTOMER_TOKEN_TTL_MIN, locale,
  });
  try { c.executionCtx.waitUntil(job); } catch { await job; }
  // The same answer for every address: nothing says whether an account exists.
  return c.json({ ok: true, expires_in: CUSTOMER_TOKEN_TTL_MIN * 60 });
});

// ---------------------------------------------------------------------------
// POST /verify
// ---------------------------------------------------------------------------
const VerifyBody = z
  .object({ token: z.string().max(200).optional(), email: emailSchema.optional(), code: z.string().max(12).optional(), mode: modeSchema, locale: localeSchema })
  .refine((v) => !!v.token || (!!v.email && !!v.code), 'Provide a token, or an email and a code');

accountRoutes.post('/verify', async (c) => {
  const b = parse(VerifyBody, await readJson(c));
  assertModeAllowed(c, b.mode);
  const db = getDb(c.var.db);
  const ip = clientIp(c);
  await limit(c, db, `acct-verify:ip:${ip}`, 30, 900);
  if (b.email) await limit(c, db, `acct-verify:email:${(await sha256Hex(normCustomerEmail(b.email))).slice(0, 32)}`, 10, 900);

  const email = b.token
    ? await consumeCustomerLink(db, b.token)
    : await consumeCustomerCode(db, normCustomerEmail(b.email!), b.code!, c.env.PASSWORD_PEPPER);
  if (!email) throw ApiError.unauthorized('This link or code is invalid or has expired. Request a new one.');

  const customer = await openCustomer(db, email, b.locale);
  const s = await createCustomerSession(db, customer.id, { ip, userAgent: c.req.header('User-Agent'), via: b.mode });
  if (b.mode === 'cookie') {
    setCustomerCookie(c, s.token, s.expires_at);
    return c.json({ ok: true, customer: publicCustomer(customer), expires_at: s.expires_at });
  }
  return c.json({ ok: true, customer: publicCustomer(customer), expires_at: s.expires_at, session_token: s.token });
});

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------
accountRoutes.get('/me', customerAuth, (c) => {
  const a = c.get('acct');
  return c.json({ customer: publicCustomer(a.customer), via: a.via, expires_at: a.expires_at });
});

const PatchMeBody = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  country: z.string().length(2).optional(),
  locale: z.enum(['fr', 'en']).optional(),
  accepts_marketing: z.boolean().optional(),
});

accountRoutes.patch('/me', customerAuth, async (c) => {
  const b = parse(PatchMeBody, await readJson(c));
  const a = c.get('acct');
  const db = getDb(c.var.db);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (b.name !== undefined) { sets.push('name = ?'); params.push(b.name || null); }
  if (b.phone !== undefined) {
    let phone: string | null = null;
    if (b.phone) {
      phone = normalizePhone(b.phone, b.country);
      if (!phone) throw ApiError.invalidRequest('Enter a valid phone number, with its country code (e.g. +229 01 61 00 00 00).');
    }
    sets.push('phone = ?'); params.push(phone);
  }
  if (b.locale !== undefined) { sets.push('locale = ?'); params.push(b.locale); }
  if (b.accepts_marketing !== undefined) { sets.push('accepts_marketing = ?'); params.push(b.accepts_marketing ? 1 : 0); }
  if (sets.length) {
    sets.push('updated_at = ?'); params.push(new Date().toISOString());
    await db.run(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`, [...params, a.customer.id]);
  }
  const [row] = await db.query<any>(
    `SELECT id, email, name, phone, locale, accepts_marketing, email_verified_at, order_count, created_at FROM customers WHERE id = ?`,
    [a.customer.id]
  );
  return c.json({ customer: publicCustomer(row) });
});

accountRoutes.post('/logout', customerAuth, async (c) => {
  await revokeCustomerSession(getDb(c.var.db), c.get('acct').session_id);
  clearCustomerCookie(c);
  return c.json({ ok: true });
});

accountRoutes.post('/logout-all', customerAuth, async (c) => {
  await revokeCustomerSessions(getDb(c.var.db), c.get('acct').customer.id);
  clearCustomerCookie(c);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Orders (only the signed-in customer's own, matched by id or verified email)
// ---------------------------------------------------------------------------
const OWN = `(o.customer_id = ? OR lower(o.customer_email) = ?)`;
const PAID_STATES = ['paid', 'processing', 'shipped', 'delivered'];

function orderSummary(o: any, items: any[]) {
  const total = o.total_cents as number;
  const paid = (o.amount_paid_cents as number) ?? 0;
  return {
    number: o.number,
    status: o.status,
    created_at: o.created_at,
    currency: o.currency,
    total_cents: total,
    amount_paid_cents: paid,
    balance_cents: Math.max(0, total - paid),
    items: items.map((i) => ({ title: i.title, qty: i.qty })),
  };
}

accountRoutes.get('/orders', customerAuth, async (c) => {
  const a = c.get('acct');
  const db = getDb(c.var.db);
  const limitN = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
  const cursor = c.req.query('cursor');
  const rows = await db.query<any>(
    `SELECT o.* FROM orders o WHERE ${OWN} ${cursor ? 'AND o.created_at < ?' : ''} ORDER BY o.created_at DESC LIMIT ?`,
    [a.customer.id, a.customer.email.toLowerCase(), ...(cursor ? [cursor] : []), limitN + 1]
  );
  const hasMore = rows.length > limitN;
  const page = hasMore ? rows.slice(0, limitN) : rows;
  const byOrder = new Map<string, any[]>();
  if (page.length) {
    const ids = page.map((o: any) => o.id);
    const items = await db.query<any>(`SELECT order_id, title, qty FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const i of items) byOrder.set(i.order_id, [...(byOrder.get(i.order_id) ?? []), i]);
  }
  return c.json({
    items: page.map((o: any) => orderSummary(o, byOrder.get(o.id) ?? [])),
    pagination: { has_more: hasMore, next_cursor: hasMore ? page[page.length - 1].created_at : null },
  });
});

async function loadOwnOrder(db: Database, a: CustomerSession, number: string) {
  const [o] = await db.query<any>(
    `SELECT o.* FROM orders o WHERE o.number = ? AND ${OWN} LIMIT 1`,
    [number, a.customer.id, a.customer.email.toLowerCase()]
  );
  // The same answer for "not yours" and "does not exist".
  if (!o) throw ApiError.notFound('Order not found');
  return o;
}

accountRoutes.get('/orders/:number', customerAuth, async (c) => {
  const a = c.get('acct');
  const db = getDb(c.var.db);
  const o = await loadOwnOrder(db, a, c.req.param('number'));
  const items = await db.query<any>(
    `SELECT i.sku, i.title, i.qty, i.unit_price_cents, v.product_type
     FROM order_items i LEFT JOIN variants v ON v.sku = i.sku WHERE i.order_id = ?`,
    [o.id]
  );
  const base = { ...orderSummary(o, items) };
  const canDownload = PAID_STATES.includes(o.status);
  const balance = base.balance_cents;
  const storeBase = String((c.env as any).STORE_URL ?? '').replace(/\/$/, '');
  let address: unknown = null;
  try { address = o.ship_to ? JSON.parse(o.ship_to) : null; } catch { /* leave null */ }
  return c.json({
    order: {
      ...base,
      payment_method: o.payment_method ?? 'online',
      due_at: o.due_at ?? null,
      service_status: o.service_status ?? null,
      items: items.map((i) => ({
        sku: i.sku, title: i.title, qty: i.qty, unit_price_cents: i.unit_price_cents,
        digital: i.product_type === 'digital',
        can_download: i.product_type === 'digital' && canDownload,
      })),
      amounts: {
        subtotal_cents: o.subtotal_cents, shipping_cents: o.shipping_cents ?? 0, tax_cents: o.tax_cents ?? 0,
        discount_cents: o.discount_amount_cents ?? 0, total_cents: o.total_cents, currency: o.currency,
      },
      shipping: { name: o.shipping_name, phone: o.shipping_phone, address, label: o.shipping_label ?? null },
      tracking: o.tracking_number ? { number: o.tracking_number, url: o.tracking_url, shipped_at: o.shipped_at } : null,
      pay_url: balance > 0 && o.pay_token && storeBase && o.status !== 'canceled' && o.status !== 'refunded'
        ? payUrl(storeBase, o.locale, o.pay_token) : null,
    },
  });
});

// A fresh download link for a digital item the customer has paid for.
const DownloadBody = z.object({ sku: z.string().min(1).max(100) });

accountRoutes.post('/orders/:number/downloads', customerAuth, async (c) => {
  const b = parse(DownloadBody, await readJson(c));
  const a = c.get('acct');
  const db = getDb(c.var.db);
  const o = await loadOwnOrder(db, a, c.req.param('number'));
  if (!PAID_STATES.includes(o.status)) throw ApiError.forbidden('Downloads are available once the order is paid.');
  const [item] = await db.query<any>(
    `SELECT i.sku FROM order_items i JOIN variants v ON v.sku = i.sku
     WHERE i.order_id = ? AND i.sku = ? AND v.product_type = 'digital' LIMIT 1`,
    [o.id, b.sku]
  );
  if (!item) throw ApiError.notFound('Digital item not found in this order');
  await limit(c, db, `acct-dl:${a.customer.id}`, 20, 3600);
  const [rec] = await createDownloadTokens(db, o.id, [{ sku: b.sku }]);
  const path = o.locale === 'en' ? '/en/downloads/' : '/fr/telechargements/';
  const base = String((c.env as any).STORE_URL ?? '').replace(/\/$/, '');
  return c.json({
    token: rec.plain_token,
    download_url: `${base}${path}?token=${rec.plain_token}`,
    expires_at: new Date(Date.now() + DOWNLOAD_DEFAULTS.expires_in_days * 86_400_000).toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------
const AddressBody = z.object({
  label: z.string().trim().max(60).optional(),
  is_default: z.boolean().optional(),
  name: z.string().trim().max(120).optional(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().max(120).optional(),
  postal_code: z.string().trim().max(20).optional().default(''),
  country: z.string().length(2),
  phone: z.string().trim().max(40).optional(),
});

function formatAddress(a: any) {
  return {
    id: a.id, label: a.label, is_default: !!a.is_default, name: a.name, line1: a.line1, line2: a.line2,
    city: a.city, state: a.state, postal_code: a.postal_code, country: a.country, phone: a.phone,
  };
}

const MAX_ADDRESSES = 10;

accountRoutes.get('/addresses', customerAuth, async (c) => {
  const rows = await getDb(c.var.db).query<any>(
    `SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, created_at ASC`,
    [c.get('acct').customer.id]
  );
  return c.json({ items: rows.map(formatAddress) });
});

accountRoutes.post('/addresses', customerAuth, async (c) => {
  const b = parse(AddressBody, await readJson(c));
  const cid = c.get('acct').customer.id;
  const db = getDb(c.var.db);
  const [{ n }] = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ?`, [cid]);
  if (n >= MAX_ADDRESSES) throw ApiError.conflict(`You can save up to ${MAX_ADDRESSES} addresses.`);
  const contact = resolveContact(b, { phoneRequired: false });
  const id = crypto.randomUUID();
  const makeDefault = b.is_default || n === 0;
  if (makeDefault) await db.run(`UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?`, [cid]);
  await db.run(
    `INSERT INTO customer_addresses (id, customer_id, label, is_default, name, line1, line2, city, state, postal_code, country, phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, cid, b.label || null, makeDefault ? 1 : 0, b.name || null, b.line1, b.line2 || null, b.city, b.state || null, contact.postal_code, contact.country, contact.phone]
  );
  const [row] = await db.query<any>(`SELECT * FROM customer_addresses WHERE id = ?`, [id]);
  return c.json({ address: formatAddress(row) }, 201);
});

accountRoutes.patch('/addresses/:id', customerAuth, async (c) => {
  const b = parse(AddressBody.partial(), await readJson(c));
  const cid = c.get('acct').customer.id;
  const db = getDb(c.var.db);
  const [cur] = await db.query<any>(`SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?`, [c.req.param('id'), cid]);
  if (!cur) throw ApiError.notFound('Address not found');
  const merged = {
    label: b.label ?? cur.label, name: b.name ?? cur.name, line1: b.line1 ?? cur.line1, line2: b.line2 ?? cur.line2,
    city: b.city ?? cur.city, state: b.state ?? cur.state, country: b.country ?? cur.country,
    postal_code: b.postal_code ?? cur.postal_code, phone: b.phone ?? cur.phone,
  };
  const contact = resolveContact(merged, { phoneRequired: false });
  if (b.is_default) await db.run(`UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?`, [cid]);
  await db.run(
    `UPDATE customer_addresses SET label = ?, name = ?, line1 = ?, line2 = ?, city = ?, state = ?, postal_code = ?, country = ?, phone = ?,
       is_default = ?, updated_at = ? WHERE id = ? AND customer_id = ?`,
    [merged.label || null, merged.name || null, merged.line1, merged.line2 || null, merged.city, merged.state || null,
     contact.postal_code, contact.country, contact.phone, b.is_default ? 1 : cur.is_default, new Date().toISOString(), cur.id, cid]
  );
  const [row] = await db.query<any>(`SELECT * FROM customer_addresses WHERE id = ?`, [cur.id]);
  return c.json({ address: formatAddress(row) });
});

accountRoutes.delete('/addresses/:id', customerAuth, async (c) => {
  const cid = c.get('acct').customer.id;
  const db = getDb(c.var.db);
  const [cur] = await db.query<any>(`SELECT id, is_default FROM customer_addresses WHERE id = ? AND customer_id = ?`, [c.req.param('id'), cid]);
  if (!cur) throw ApiError.notFound('Address not found');
  await db.run(`DELETE FROM customer_addresses WHERE id = ? AND customer_id = ?`, [cur.id, cid]);
  if (cur.is_default) {
    // Keep one address marked as the default.
    await db.run(
      `UPDATE customer_addresses SET is_default = 1 WHERE id = (SELECT id FROM customer_addresses WHERE customer_id = ? ORDER BY created_at ASC LIMIT 1)`,
      [cid]
    );
  }
  return c.json({ ok: true });
});

export const ACCOUNT_LIMITS = { codeMaxAttempts: CUSTOMER_CODE_MAX_ATTEMPTS, linkTtlMinutes: CUSTOMER_TOKEN_TTL_MIN };
