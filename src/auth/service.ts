import type { Database } from '../db';
import { uuid } from '../types';
import { hmacSha256, bytesToHex, randomCode, randomToken, sha256Hex, timingSafeEqual } from './crypto';
import {
  DEFAULT_POLICY, PBKDF2_MAX_ITERATIONS, PBKDF2_MIN_ITERATIONS,
  type KdfName, type PasswordPolicy, type ScryptParams,
} from './password';
import { isRole, type Role } from './permissions';

// ============================================================
// AUTH SERVICE: users, login tokens, sessions, throttling, audit
// ============================================================
// All state lives in the Durable Object's SQLite, next to the rest of the shop
// data. Tokens are random and high-entropy, so a plain SHA-256 is enough to
// store them: the database never holds anything that can be replayed.

const iso = (ms: number) => new Date(ms).toISOString();

export const LOGIN_TOKEN_TTL_MIN = 10;
export const CODE_MAX_ATTEMPTS = 5;
const LAST_SEEN_TOUCH_MS = 5 * 60 * 1000;

export const SESSION_PREFIX = 'ses_';
export const LINK_PREFIX = 'lt_';

// ------------------------------------------------------------
// Settings (config table, key 'auth')
// ------------------------------------------------------------

export type AuthSettings = {
  /** Email + password sign-in. Off by default: the sign-in link / code is the default method. */
  password_login: boolean;
  kdf: KdfName;
  iterations: number;
  scrypt: ScryptParams;
  /** Absolute session lifetime. */
  session_days: number;
  /** A session unused for this long is closed. */
  idle_days: number;
};

export const DEFAULT_SETTINGS: AuthSettings = {
  password_login: false,
  kdf: DEFAULT_POLICY.kdf,
  iterations: DEFAULT_POLICY.iterations,
  scrypt: { ...DEFAULT_POLICY.scrypt },
  session_days: 14,
  idle_days: 3,
};

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
};

export function normalizeSettings(raw: Partial<AuthSettings> | null | undefined): AuthSettings {
  const s = raw ?? {};
  const scr = (s.scrypt ?? {}) as Partial<ScryptParams>;
  const n = clamp(scr.n, 2 ** 14, 2 ** 17, DEFAULT_SETTINGS.scrypt.n);
  const session_days = clamp(s.session_days, 1, 90, DEFAULT_SETTINGS.session_days);
  return {
    password_login: s.password_login === true,
    kdf: s.kdf === 'scrypt' ? 'scrypt' : 'pbkdf2',
    iterations: clamp(s.iterations, PBKDF2_MIN_ITERATIONS, PBKDF2_MAX_ITERATIONS, DEFAULT_SETTINGS.iterations),
    // N must be a power of two.
    scrypt: {
      n: 2 ** Math.round(Math.log2(n)),
      r: clamp(scr.r, 8, 16, DEFAULT_SETTINGS.scrypt.r),
      p: clamp(scr.p, 1, 10, DEFAULT_SETTINGS.scrypt.p),
    },
    session_days,
    idle_days: Math.min(clamp(s.idle_days, 1, 30, DEFAULT_SETTINGS.idle_days), session_days),
  };
}

export async function getAuthSettings(db: Database): Promise<AuthSettings> {
  const [row] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'auth' LIMIT 1`);
  if (!row) return normalizeSettings(null);
  try {
    return normalizeSettings(JSON.parse(row.value));
  } catch {
    return normalizeSettings(null);
  }
}

export async function saveAuthSettings(db: Database, patch: Partial<AuthSettings>): Promise<AuthSettings> {
  const current = await getAuthSettings(db);
  const next = normalizeSettings({ ...current, ...patch, scrypt: { ...current.scrypt, ...(patch.scrypt ?? {}) } });
  const value = JSON.stringify(next);
  const t = iso(Date.now());
  await db.run(
    `INSERT INTO config (key, value, updated_at) VALUES ('auth', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
    [value, t, value, t]
  );
  return next;
}

export function policyOf(s: AuthSettings): PasswordPolicy {
  return { kdf: s.kdf, iterations: s.iterations, scrypt: s.scrypt };
}

// ------------------------------------------------------------
// Users
// ------------------------------------------------------------

export type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: 'active' | 'disabled';
  password_hash: string | null;
  locale: string | null;
  created_at: string;
  updated_at: string | null;
  last_login_at: string | null;
};

export type PublicUser = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: 'active' | 'disabled';
  has_password: boolean;
  last_login_at: string | null;
  created_at: string;
};

export const normEmail = (e: string) => e.trim().toLowerCase();

export function publicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    has_password: !!u.password_hash,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
  };
}

export async function getUserByEmail(db: Database, email: string): Promise<UserRow | null> {
  const [u] = await db.query<UserRow>(`SELECT * FROM users WHERE email = ? LIMIT 1`, [normEmail(email)]);
  return u ?? null;
}

export async function getUserById(db: Database, id: string): Promise<UserRow | null> {
  const [u] = await db.query<UserRow>(`SELECT * FROM users WHERE id = ? LIMIT 1`, [id]);
  return u ?? null;
}

export async function listUsers(db: Database, opts: { includeAgency: boolean }): Promise<UserRow[]> {
  return db.query<UserRow>(
    opts.includeAgency
      ? `SELECT * FROM users ORDER BY created_at`
      : `SELECT * FROM users WHERE role != 'agency' ORDER BY created_at`
  );
}

export async function countActiveOwners(db: Database): Promise<number> {
  const [r] = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active'`);
  return r?.n ?? 0;
}

export async function createUser(
  db: Database,
  input: { email: string; name?: string | null; role: Role; locale?: string | null; createdBy?: string | null }
): Promise<UserRow> {
  if (!isRole(input.role)) throw new Error('invalid role');
  const id = uuid();
  const t = iso(Date.now());
  await db.run(
    `INSERT INTO users (id, email, name, role, status, locale, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    [id, normEmail(input.email), input.name ?? null, input.role, input.locale ?? null, t, t, input.createdBy ?? null]
  );
  return (await getUserById(db, id))!;
}

export async function updateUser(
  db: Database,
  id: string,
  patch: { name?: string | null; role?: Role; status?: 'active' | 'disabled' }
): Promise<UserRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if (patch.role !== undefined) { sets.push('role = ?'); params.push(patch.role); }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (!sets.length) return getUserById(db, id);
  sets.push('updated_at = ?');
  params.push(iso(Date.now()), id);
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  return getUserById(db, id);
}

export async function setPasswordHash(db: Database, userId: string, hash: string | null): Promise<void> {
  await db.run(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [hash, iso(Date.now()), userId]);
}

// ------------------------------------------------------------
// Login tokens: one email carries a link token and a 6-digit code
// ------------------------------------------------------------

async function codeHash(pepper: string | undefined, tokenId: string, code: string): Promise<string> {
  return bytesToHex(await hmacSha256(pepper ?? '', `login-code:${tokenId}:${code}`));
}

export type IssuedLoginToken = { token: string; code: string; expires_at: string };

/**
 * Create a sign-in token for `user`. Any older unused token for the same user is
 * invalidated, so at most one link and one code are ever live.
 */
export async function issueLoginToken(
  db: Database,
  user: UserRow,
  pepper: string | undefined,
  opts: { ttlMinutes?: number; purpose?: 'login' | 'invite' | 'bootstrap' } = {}
): Promise<IssuedLoginToken> {
  const nowMs = Date.now();
  const id = uuid();
  const token = LINK_PREFIX + randomToken(32);
  const code = randomCode(6);
  const expires_at = iso(nowMs + (opts.ttlMinutes ?? LOGIN_TOKEN_TTL_MIN) * 60_000);
  await db.run(`UPDATE login_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL`, [iso(nowMs), user.id]);
  await db.run(
    `INSERT INTO login_tokens (id, user_id, token_hash, code_hash, attempts, expires_at, created_at, purpose)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    [id, user.id, await sha256Hex(token), await codeHash(pepper, id, code), expires_at, iso(nowMs), opts.purpose ?? 'login']
  );
  return { token, code, expires_at };
}

/** Redeem a link token. Single use: the UPDATE only succeeds once. */
export async function consumeLinkToken(db: Database, token: string): Promise<UserRow | null> {
  if (typeof token !== 'string' || !token.startsWith(LINK_PREFIX) || token.length > 200) return null;
  const t = iso(Date.now());
  const [hit] = await db.query<{ user_id: string }>(
    `UPDATE login_tokens SET consumed_at = ?
     WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING user_id`,
    [t, await sha256Hex(token), t]
  );
  if (!hit) return null;
  const user = await getUserById(db, hit.user_id);
  return user && user.status === 'active' ? user : null;
}

/** Redeem the 6-digit code that came in the same email. At most 5 tries per token. */
export async function consumeCode(
  db: Database,
  email: string,
  code: string,
  pepper: string | undefined
): Promise<UserRow | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const user = await getUserByEmail(db, email);
  if (!user || user.status !== 'active') return null;
  const t = iso(Date.now());
  const [row] = await db.query<{ id: string; code_hash: string; attempts: number }>(
    `SELECT id, code_hash, attempts FROM login_tokens
     WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`,
    [user.id, t]
  );
  if (!row || row.attempts >= CODE_MAX_ATTEMPTS) return null;
  // Count the attempt before comparing, so concurrent guesses cannot get extra tries.
  const [bumped] = await db.query<{ attempts: number }>(
    `UPDATE login_tokens SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND attempts < ? RETURNING attempts`,
    [row.id, CODE_MAX_ATTEMPTS]
  );
  if (!bumped) return null;
  if (!timingSafeEqual(await codeHash(pepper, row.id, code), row.code_hash)) return null;
  const [won] = await db.query<{ id: string }>(
    `UPDATE login_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING id`,
    [t, row.id]
  );
  return won ? user : null;
}

// ------------------------------------------------------------
// Sessions
// ------------------------------------------------------------

export type CreatedSession = { token: string; id: string; expires_at: string };

export async function createSession(
  db: Database,
  user: UserRow,
  settings: AuthSettings,
  meta: { ip?: string | null; userAgent?: string | null; via: 'cookie' | 'bearer' }
): Promise<CreatedSession> {
  const nowMs = Date.now();
  const id = uuid();
  const token = SESSION_PREFIX + randomToken(32);
  const expires_at = iso(nowMs + settings.session_days * 86_400_000);
  await db.run(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, idle_seconds, ip, user_agent, via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, user.id, await sha256Hex(token), iso(nowMs), iso(nowMs), expires_at,
      settings.idle_days * 86_400, meta.ip ?? null, (meta.userAgent ?? '').slice(0, 300) || null, meta.via,
    ]
  );
  await db.run(`UPDATE users SET last_login_at = ? WHERE id = ?`, [iso(nowMs), user.id]);
  return { token, id, expires_at };
}

export type SessionInfo = {
  session_id: string;
  expires_at: string;
  via: 'cookie' | 'bearer';
  user: UserRow;
};

export async function lookupSession(db: Database, token: string): Promise<SessionInfo | null> {
  if (typeof token !== 'string' || !token.startsWith(SESSION_PREFIX) || token.length > 200) return null;
  const [row] = await db.query<{
    id: string; expires_at: string; last_seen_at: string; idle_seconds: number; via: 'cookie' | 'bearer'; user_id: string;
  }>(
    `SELECT id, expires_at, last_seen_at, idle_seconds, via, user_id FROM sessions
     WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [await sha256Hex(token)]
  );
  if (!row) return null;
  const nowMs = Date.now();
  if (Date.parse(row.expires_at) <= nowMs) return null;
  if (Date.parse(row.last_seen_at) + row.idle_seconds * 1000 <= nowMs) return null;
  const user = await getUserById(db, row.user_id);
  if (!user || user.status !== 'active') return null;
  // Touch last_seen at most every few minutes so reads do not turn into writes.
  if (nowMs - Date.parse(row.last_seen_at) > LAST_SEEN_TOUCH_MS) {
    await db.run(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`, [iso(nowMs), row.id]);
  }
  return { session_id: row.id, expires_at: row.expires_at, via: row.via, user };
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.run(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [iso(Date.now()), sessionId]);
}

export async function revokeUserSessions(db: Database, userId: string, exceptSessionId?: string): Promise<void> {
  await db.run(
    `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?`,
    [iso(Date.now()), userId, exceptSessionId ?? '']
  );
}

// ------------------------------------------------------------
// Throttling (fixed window, kept in SQLite so it holds across isolates)
// ------------------------------------------------------------

export type ThrottleResult = { allowed: boolean; retryAfter: number };

/** Count one hit on `key`. Allowed while the count in the current window is <= limit. */
export async function throttle(db: Database, key: string, limit: number, windowSec: number): Promise<ThrottleResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - windowSec;
  await db.run(
    `INSERT INTO auth_throttle (key, count, window_start) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END`,
    [key, nowSec, cutoff, cutoff, nowSec]
  );
  const [row] = await db.query<{ count: number; window_start: number }>(
    `SELECT count, window_start FROM auth_throttle WHERE key = ?`, [key]
  );
  const count = row?.count ?? 1;
  const retryAfter = Math.max(1, (row?.window_start ?? nowSec) + windowSec - nowSec);
  return { allowed: count <= limit, retryAfter };
}

// ------------------------------------------------------------
// Audit log
// ------------------------------------------------------------

export type AuditEntry = {
  action: string;
  actor_user_id?: string | null;
  actor?: string | null;
  target?: string | null;
  ip?: string | null;
  meta?: Record<string, unknown> | null;
};

export async function audit(db: Database, e: AuditEntry): Promise<void> {
  try {
    await db.run(
      `INSERT INTO audit_log (id, at, actor_user_id, actor, action, target, ip, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), iso(Date.now()), e.actor_user_id ?? null, e.actor ?? null, e.action, e.target ?? null, e.ip ?? null, e.meta ? JSON.stringify(e.meta) : null]
    );
  } catch (err) {
    // The audit trail must never take a request down.
    console.error('[auth] audit write failed', err);
  }
}

// ------------------------------------------------------------
// Housekeeping (called from the cron)
// ------------------------------------------------------------

export async function purgeAuthData(db: Database): Promise<void> {
  const nowMs = Date.now();
  const dayAgo = iso(nowMs - 86_400_000);
  const weekAgo = iso(nowMs - 7 * 86_400_000);
  const yearAgo = iso(nowMs - 365 * 86_400_000);
  await db.run(`DELETE FROM auth_throttle WHERE window_start < ?`, [Math.floor(nowMs / 1000) - 86_400]);
  await db.run(`DELETE FROM login_tokens WHERE expires_at < ?`, [dayAgo]);
  await db.run(`DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`, [weekAgo, weekAgo]);
  await db.run(`DELETE FROM audit_log WHERE at < ?`, [yearAgo]);
}
