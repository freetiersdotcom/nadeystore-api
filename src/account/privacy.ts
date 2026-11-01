import type { Database } from '../db';
import { uuid } from '../types';
import { bytesToHex, hmacSha256, randomCode, timingSafeEqual } from '../auth/crypto';
import { getCustomerById, normCustomerEmail, type CustomerRow } from './service';

// =============================================================================
// Customer privacy: change the email, export my data, erase my account.
//
// Both sensitive steps (new email, erasure) need a 6-digit code sent to the address being
// proven, on top of being signed in: a stolen session alone cannot take over or delete
// an account. Codes last 10 minutes, work once, and allow 5 tries.
// =============================================================================

export const CODE_TTL_MIN = 10;
export const CODE_MAX_ATTEMPTS = 5;
export type CodePurpose = 'email_change' | 'delete';

const iso = (ms: number) => new Date(ms).toISOString();

async function hashOf(pepper: string | undefined, id: string, purpose: string, code: string) {
  return bytesToHex(await hmacSha256(pepper ?? '', `customer-${purpose}:${id}:${code}`));
}

export async function issueCode(
  db: Database, customerId: string, purpose: CodePurpose, pepper: string | undefined, newEmail?: string
): Promise<{ code: string }> {
  const id = uuid();
  const code = randomCode(6);
  const now = Date.now();
  // A newer request replaces any older unused one.
  await db.run(`UPDATE customer_codes SET consumed_at = ? WHERE customer_id = ? AND purpose = ? AND consumed_at IS NULL`, [iso(now), customerId, purpose]);
  await db.run(
    `INSERT INTO customer_codes (id, customer_id, purpose, new_email, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [id, customerId, purpose, newEmail ?? null, await hashOf(pepper, id, purpose, code), iso(now + CODE_TTL_MIN * 60_000), iso(now)]
  );
  return { code };
}

/** Redeem a code for this customer and purpose. Single use, 5 tries. Returns the proven address (email_change) or '' . */
export async function consumeCode(
  db: Database, customerId: string, purpose: CodePurpose, code: string, pepper: string | undefined
): Promise<{ new_email: string | null } | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const t = iso(Date.now());
  const [row] = await db.query<{ id: string; code_hash: string; attempts: number; new_email: string | null }>(
    `SELECT id, code_hash, attempts, new_email FROM customer_codes
     WHERE customer_id = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
    [customerId, purpose, t]
  );
  if (!row || row.attempts >= CODE_MAX_ATTEMPTS) return null;
  const [bumped] = await db.query<{ attempts: number }>(
    `UPDATE customer_codes SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND attempts < ? RETURNING attempts`,
    [row.id, CODE_MAX_ATTEMPTS]
  );
  if (!bumped) return null;
  if (!timingSafeEqual(await hashOf(pepper, row.id, purpose, code), row.code_hash)) return null;
  const [won] = await db.query<{ id: string }>(`UPDATE customer_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING id`, [t, row.id]);
  return won ? { new_email: row.new_email } : null;
}

// ---------------------------------------------------------------------------
// Email change
// ---------------------------------------------------------------------------
export async function emailTaken(db: Database, email: string, exceptCustomerId: string): Promise<boolean> {
  const [r] = await db.query<{ id: string }>(`SELECT id FROM customers WHERE lower(email) = ? AND id <> ? LIMIT 1`, [email, exceptCustomerId]);
  return !!r;
}

export type ChangeResult = { ok: true; customer: CustomerRow; old_email: string } | { ok: false; reason: 'taken' | 'gone' };

/** Move the account to a proven address. Past guest orders from either address stay attached. */
export async function applyEmailChange(db: Database, customerId: string, newEmailRaw: string, keepSessionId: string): Promise<ChangeResult> {
  const newEmail = normCustomerEmail(newEmailRaw);
  const current = await getCustomerById(db, customerId);
  if (!current) return { ok: false, reason: 'gone' };
  if (await emailTaken(db, newEmail, customerId)) return { ok: false, reason: 'taken' };
  const oldEmail = current.email;
  const now = iso(Date.now());
  try {
    await db.run(`UPDATE customers SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ?`, [newEmail, now, now, customerId]);
  } catch {
    return { ok: false, reason: 'taken' }; // the UNIQUE constraint caught a race
  }
  // Orders made as a guest with either address belong to this person now: tie them to the account,
  // so they stay visible whatever address is used later.
  await db.run(
    `UPDATE orders SET customer_id = ? WHERE customer_id IS NULL AND (lower(customer_email) = ? OR lower(customer_email) = ?)`,
    [customerId, oldEmail.toLowerCase(), newEmail]
  );
  // Sign out every other device; the one that made the change stays signed in.
  await db.run(`UPDATE customer_sessions SET revoked_at = ? WHERE customer_id = ? AND id <> ? AND revoked_at IS NULL`, [now, customerId, keepSessionId]);
  await db.run(`UPDATE customer_codes SET consumed_at = ? WHERE customer_id = ? AND consumed_at IS NULL`, [now, customerId]);
  return { ok: true, customer: (await getCustomerById(db, customerId))!, old_email: oldEmail };
}

// ---------------------------------------------------------------------------
// Export: everything held about this person, as one JSON document
// ---------------------------------------------------------------------------
const parseJson = (s: unknown) => { try { return typeof s === 'string' ? JSON.parse(s) : s ?? null; } catch { return s ?? null; } };

export async function buildExport(db: Database, customer: CustomerRow) {
  const email = customer.email.toLowerCase();
  const [full] = await db.query<any>(
    `SELECT id, email, name, phone, locale, accepts_marketing, email_verified_at, order_count, total_spent_cents, created_at, updated_at, last_order_at
     FROM customers WHERE id = ?`, [customer.id]);
  const addresses = await db.query<any>(
    `SELECT label, is_default, name, company, line1, line2, city, state, postal_code, country, phone, created_at FROM customer_addresses WHERE customer_id = ? ORDER BY created_at`,
    [customer.id]);
  const orders = await db.query<any>(
    `SELECT * FROM orders WHERE customer_id = ? OR lower(customer_email) = ? ORDER BY created_at`, [customer.id, email]);
  const outOrders = [];
  for (const o of orders) {
    const items = await db.query<any>(`SELECT sku, title, qty, unit_price_cents FROM order_items WHERE order_id = ?`, [o.id]);
    let payments: any[] = [];
    try { payments = await db.query<any>(`SELECT amount_cents, method, reference, created_at FROM order_payments WHERE order_id = ? ORDER BY created_at`, [o.id]); } catch { /* table not installed */ }
    outOrders.push({
      number: o.number, status: o.status, created_at: o.created_at, currency: o.currency,
      subtotal_cents: o.subtotal_cents, shipping_cents: o.shipping_cents, tax_cents: o.tax_cents,
      discount_cents: o.discount_amount_cents ?? 0, total_cents: o.total_cents, amount_paid_cents: o.amount_paid_cents ?? null,
      payment_method: o.payment_method ?? null, contact_email: o.customer_email,
      shipping: { name: o.shipping_name, phone: o.shipping_phone, address: parseJson(o.ship_to), method: o.shipping_label ?? null },
      tracking_number: o.tracking_number, shipped_at: o.shipped_at, items, payments,
    });
  }
  const passkeys = await db.query<any>(
    `SELECT name, device_type, backed_up, created_at, last_used_at FROM passkey_credentials WHERE realm = 'customer' AND subject_id = ?`, [customer.id]).catch(() => []);
  const messages = await db.query<any>(
    `SELECT form, name, email, phone, subject, message, created_at FROM submissions WHERE lower(email) = ? ORDER BY created_at`, [email]).catch(() => []);
  const sessions = await db.query<any>(
    `SELECT created_at, last_seen_at, expires_at, via, user_agent FROM customer_sessions WHERE customer_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    [customer.id, iso(Date.now())]).catch(() => []);
  return {
    exported_at: iso(Date.now()),
    note: 'Everything this store holds that is linked to your account or your email address. Secrets (session tokens, passkey keys) are not included.',
    account: full ?? null,
    addresses, orders: outOrders, passkeys, contact_messages: messages, active_sessions: sessions,
  };
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------
export type EraseMode = 'keep' | 'scrub';
export const erasureMode = (v: string | undefined): EraseMode => (String(v ?? '').toLowerCase() === 'scrub' ? 'scrub' : 'keep');

/** Orders that must be finished before the account can go. */
export async function openOrderCount(db: Database, customer: CustomerRow, mode: EraseMode): Promise<number> {
  const email = customer.email.toLowerCase();
  const [r] = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM orders o WHERE (o.customer_id = ? OR lower(o.customer_email) = ?) AND (
       o.status IN ('pending', 'processing', 'shipped')
       ${mode === 'scrub' ? `OR (o.status = 'paid' AND EXISTS (
            SELECT 1 FROM order_items i LEFT JOIN variants v ON v.sku = i.sku WHERE i.order_id = o.id AND COALESCE(v.product_type, 'physical') <> 'digital'))` : ''}
     )`, [customer.id, email]);
  return r?.n ?? 0;
}

async function tableHas(db: Database, table: string): Promise<boolean> {
  const [r] = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
  return (r?.n ?? 0) > 0;
}

export async function eraseCustomer(db: Database, customer: CustomerRow, mode: EraseMode): Promise<{ pseudonym: string }> {
  const id = customer.id;
  const email = customer.email.toLowerCase();
  const now = iso(Date.now());
  const pseudonym = `erased+${id.replace(/-/g, '').slice(0, 12)}@erased.invalid`;

  // Order ids first: download links hang off them.
  const orders = await db.query<{ id: string }>(`SELECT id FROM orders WHERE customer_id = ? OR lower(customer_email) = ?`, [id, email]);

  // Sign-in material and everything only the account itself used
  await db.run(`DELETE FROM customer_sessions WHERE customer_id = ?`, [id]);
  await db.run(`DELETE FROM customer_login_tokens WHERE lower(email) = ?`, [email]);
  await db.run(`DELETE FROM customer_codes WHERE customer_id = ?`, [id]);
  await db.run(`DELETE FROM passkey_credentials WHERE realm = 'customer' AND subject_id = ?`, [id]);
  await db.run(`DELETE FROM webauthn_challenges WHERE realm = 'customer' AND subject_id = ?`, [id]);
  await db.run(`DELETE FROM customer_addresses WHERE customer_id = ?`, [id]);
  await db.run(`DELETE FROM oauth_tokens WHERE customer_id = ?`, [id]);
  await db.run(`DELETE FROM oauth_authorizations WHERE lower(customer_email) = ?`, [email]);
  if (await tableHas(db, 'ucp_checkout_sessions')) {
    // Agent-checkout sessions keep the buyer's details as JSON: blank them (the order record is separate).
    await db.run(`UPDATE ucp_checkout_sessions SET buyer = NULL WHERE instr(lower(buyer), ?) > 0`, [email]);
  }
  for (const o of orders) await db.run(`DELETE FROM download_tokens WHERE order_id = ?`, [o.id]).catch(() => {});

  // Contact-form messages are not accounting records: they go.
  await db.run(`DELETE FROM submissions WHERE lower(email) = ?`, [email]).catch(() => {});

  // Carts are working data: blank who they belonged to.
  await db.run(
    `UPDATE carts SET customer_email = ?, shipping_name = NULL, contact_phone = NULL, ship_to = NULL WHERE lower(customer_email) = ?`,
    [pseudonym, email]).catch(() => {});

  // Orders: amounts, items and dates stay (accounting). Who they were for depends on the mode.
  if (mode === 'scrub') {
    await db.run(
      `UPDATE orders SET customer_email = ?, shipping_name = NULL, shipping_phone = NULL, ship_to = NULL, customer_id = ? WHERE customer_id = ? OR lower(customer_email) = ?`,
      [pseudonym, id, id, email]);
  } else {
    // Keep the contact details the store must retain, but make sure they belong to the (now anonymous) record.
    await db.run(`UPDATE orders SET customer_id = ? WHERE customer_id IS NULL AND lower(customer_email) = ?`, [id, email]);
  }

  // The account itself keeps only its id and totals, so order links and statistics stay whole.
  await db.run(
    `UPDATE customers SET email = ?, name = NULL, phone = NULL, password_hash = NULL, auth_provider = NULL, auth_provider_id = NULL,
       email_verified_at = NULL, accepts_marketing = 0, metadata = ?, updated_at = ? WHERE id = ?`,
    [pseudonym, JSON.stringify({ erased_at: now }), now, id]);
  return { pseudonym };
}
