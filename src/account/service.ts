import type { Database } from '../db';
import { uuid } from '../types';
import { bytesToHex, hmacSha256, randomCode, randomToken, sha256Hex, timingSafeEqual } from '../auth/crypto';

// =============================================================================
// Storefront customer sign-in: tokens, sessions, the customer record.
//
// Same idea as the admin sign-in (one email = a link + a 6-digit code, both single use,
// opaque server-side sessions, only hashes stored), but in separate tables and with its
// own token prefixes. A customer session cannot be read as an admin session or the reverse.
//
// A customer does not need to exist before signing in: proving control of the email
// creates the account (or opens the one made by an earlier order, which is how past
// guest orders show up).
// =============================================================================

export const CUSTOMER_TOKEN_TTL_MIN = 10;
export const CUSTOMER_CODE_MAX_ATTEMPTS = 5;
export const CUSTOMER_SESSION_DAYS = 30;
export const CUSTOMER_IDLE_DAYS = 14;
export const CUSTOMER_SESSION_PREFIX = 'cus_';
export const CUSTOMER_LINK_PREFIX = 'ct_';
const TOUCH_MS = 5 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
export const normCustomerEmail = (e: string) => e.trim().toLowerCase();

async function codeHash(pepper: string | undefined, tokenId: string, code: string): Promise<string> {
  return bytesToHex(await hmacSha256(pepper ?? '', `customer-code:${tokenId}:${code}`));
}

// ------------------------------------------------------------
// Sign-in tokens (keyed by email: the customer may not exist yet)
// ------------------------------------------------------------

export async function issueCustomerToken(
  db: Database,
  email: string,
  pepper: string | undefined
): Promise<{ token: string; code: string; expires_at: string }> {
  const nowMs = Date.now();
  const id = uuid();
  const token = CUSTOMER_LINK_PREFIX + randomToken(32);
  const code = randomCode(6);
  const expires_at = iso(nowMs + CUSTOMER_TOKEN_TTL_MIN * 60_000);
  // A newer request replaces any older unused one: at most one live link and code per email.
  await db.run(`UPDATE customer_login_tokens SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL`, [iso(nowMs), email]);
  await db.run(
    `INSERT INTO customer_login_tokens (id, email, token_hash, code_hash, attempts, expires_at, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [id, email, await sha256Hex(token), await codeHash(pepper, id, code), expires_at, iso(nowMs)]
  );
  return { token, code, expires_at };
}

/** Redeem a link token. Returns the verified email. Single use. */
export async function consumeCustomerLink(db: Database, token: string): Promise<string | null> {
  if (typeof token !== 'string' || !token.startsWith(CUSTOMER_LINK_PREFIX) || token.length > 200) return null;
  const t = iso(Date.now());
  const [hit] = await db.query<{ email: string }>(
    `UPDATE customer_login_tokens SET consumed_at = ?
     WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING email`,
    [t, await sha256Hex(token), t]
  );
  return hit?.email ?? null;
}

/** Redeem the 6-digit code. At most 5 tries per token. Returns the verified email. */
export async function consumeCustomerCode(
  db: Database,
  email: string,
  code: string,
  pepper: string | undefined
): Promise<string | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const t = iso(Date.now());
  const [row] = await db.query<{ id: string; code_hash: string; attempts: number }>(
    `SELECT id, code_hash, attempts FROM customer_login_tokens
     WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
    [email, t]
  );
  if (!row || row.attempts >= CUSTOMER_CODE_MAX_ATTEMPTS) return null;
  const [bumped] = await db.query<{ attempts: number }>(
    `UPDATE customer_login_tokens SET attempts = attempts + 1
     WHERE id = ? AND consumed_at IS NULL AND attempts < ? RETURNING attempts`,
    [row.id, CUSTOMER_CODE_MAX_ATTEMPTS]
  );
  if (!bumped) return null;
  if (!timingSafeEqual(await codeHash(pepper, row.id, code), row.code_hash)) return null;
  const [won] = await db.query<{ id: string }>(
    `UPDATE customer_login_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING id`,
    [t, row.id]
  );
  return won ? email : null;
}

// ------------------------------------------------------------
// The customer record
// ------------------------------------------------------------

export type CustomerRow = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  locale: string | null;
  accepts_marketing: number | null;
  email_verified_at: string | null;
  order_count: number | null;
  created_at: string;
};

const CUSTOMER_COLS = `id, email, name, phone, locale, accepts_marketing, email_verified_at, order_count, created_at`;

export async function getCustomerById(db: Database, id: string): Promise<CustomerRow | null> {
  const [row] = await db.query<CustomerRow>(`SELECT ${CUSTOMER_COLS} FROM customers WHERE id = ?`, [id]);
  return row ?? null;
}

/**
 * Open (or create) the customer for a VERIFIED email, and mark it verified.
 * Matches case-insensitively so an order placed as "Ana@Mail.com" is the same person.
 */
export async function openCustomer(db: Database, email: string, locale: 'fr' | 'en' | undefined): Promise<CustomerRow> {
  const nowIso = iso(Date.now());
  const [existing] = await db.query<{ id: string }>(`SELECT id FROM customers WHERE lower(email) = ? LIMIT 1`, [email]);
  if (existing) {
    await db.run(
      `UPDATE customers SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?`,
      [nowIso, nowIso, existing.id]
    );
    return (await getCustomerById(db, existing.id))!;
  }
  const id = uuid();
  await db.run(
    `INSERT INTO customers (id, email, locale, email_verified_at, order_count, total_spent_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    [id, email, locale ?? 'fr', nowIso, nowIso, nowIso]
  );
  return (await getCustomerById(db, id))!;
}

export function publicCustomer(c: CustomerRow) {
  return {
    id: c.id,
    email: c.email,
    name: c.name,
    phone: c.phone,
    locale: c.locale === 'en' ? 'en' : 'fr',
    accepts_marketing: !!c.accepts_marketing,
    email_verified: !!c.email_verified_at,
    order_count: c.order_count ?? 0,
    created_at: c.created_at,
  };
}

// ------------------------------------------------------------
// Sessions
// ------------------------------------------------------------

export async function createCustomerSession(
  db: Database,
  customerId: string,
  meta: { ip?: string | null; userAgent?: string | null; via: 'cookie' | 'bearer' }
): Promise<{ token: string; id: string; expires_at: string }> {
  const nowMs = Date.now();
  const id = uuid();
  const token = CUSTOMER_SESSION_PREFIX + randomToken(32);
  const expires_at = iso(nowMs + CUSTOMER_SESSION_DAYS * 86_400_000);
  await db.run(
    `INSERT INTO customer_sessions (id, customer_id, token_hash, created_at, last_seen_at, expires_at, idle_seconds, ip, user_agent, via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, customerId, await sha256Hex(token), iso(nowMs), iso(nowMs), expires_at,
      CUSTOMER_IDLE_DAYS * 86_400, meta.ip ?? null, (meta.userAgent ?? '').slice(0, 300) || null, meta.via,
    ]
  );
  return { token, id, expires_at };
}

export type CustomerSession = { session_id: string; expires_at: string; via: 'cookie' | 'bearer'; customer: CustomerRow };

export async function lookupCustomerSession(db: Database, token: string): Promise<CustomerSession | null> {
  if (typeof token !== 'string' || !token.startsWith(CUSTOMER_SESSION_PREFIX) || token.length > 200) return null;
  const [row] = await db.query<{
    id: string; expires_at: string; last_seen_at: string; idle_seconds: number; via: 'cookie' | 'bearer'; customer_id: string;
  }>(
    `SELECT id, expires_at, last_seen_at, idle_seconds, via, customer_id FROM customer_sessions
     WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [await sha256Hex(token)]
  );
  if (!row) return null;
  const nowMs = Date.now();
  if (Date.parse(row.expires_at) <= nowMs) return null;
  if (Date.parse(row.last_seen_at) + row.idle_seconds * 1000 <= nowMs) return null;
  const customer = await getCustomerById(db, row.customer_id);
  if (!customer) return null;
  if (nowMs - Date.parse(row.last_seen_at) > TOUCH_MS) {
    await db.run(`UPDATE customer_sessions SET last_seen_at = ? WHERE id = ?`, [iso(nowMs), row.id]);
  }
  return { session_id: row.id, expires_at: row.expires_at, via: row.via, customer };
}

export async function revokeCustomerSession(db: Database, sessionId: string): Promise<void> {
  await db.run(`UPDATE customer_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [iso(Date.now()), sessionId]);
}

export async function revokeCustomerSessions(db: Database, customerId: string): Promise<void> {
  await db.run(`UPDATE customer_sessions SET revoked_at = ? WHERE customer_id = ? AND revoked_at IS NULL`, [iso(Date.now()), customerId]);
}

export async function purgeAccountData(db: Database): Promise<void> {
  const nowMs = Date.now();
  await db.run(`DELETE FROM customer_login_tokens WHERE expires_at < ?`, [iso(nowMs - 86_400_000)]);
  await db.run(
    `DELETE FROM customer_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
    [iso(nowMs - 7 * 86_400_000), iso(nowMs - 7 * 86_400_000)]
  );
}
