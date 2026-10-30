import type { Database } from '../db';
import { bytesToHex, randomBytes, sha256Hex } from './crypto';
import { audit } from './service';

// =============================================================================
// API keys managed from the admin (instead of being fixed at first setup)
//
//  - pk_… "public" keys: used by the storefront, can only reach public routes.
//  - sk_… "admin" keys: full access, meant for scripts and integrations.
//    (People sign in with a link; they do not need an admin key.)
//
// Only the SHA-256 of a key is stored. The secret is shown once, when it is
// created or rotated. A key can be revoked at once, or rotated with a grace
// period so the old key keeps working while the new one is rolled out.
// Keys created by the original /v1/setup/init keep working and show up here too.
// =============================================================================

export type KeyRole = 'public' | 'admin';
export const MAX_ACTIVE_KEYS = 20;
export const MAX_GRACE_HOURS = 24 * 30;
const TOUCH_EVERY_MS = 10 * 60_000;

export type KeyRow = {
  id: string;
  key_prefix: string;
  last4: string | null;
  role: KeyRole;
  label: string | null;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
};

export type KeyView = KeyRow & { status: 'active' | 'expiring' | 'expired' | 'revoked' };

const iso = (ms: number) => new Date(ms).toISOString();
const COLS = `id, key_prefix, last4, role, label, created_at, created_by, last_used_at, revoked_at, expires_at`;

export function keyStatus(k: Pick<KeyRow, 'revoked_at' | 'expires_at'>, nowMs = Date.now()): KeyView['status'] {
  if (k.revoked_at) return 'revoked';
  if (k.expires_at) return Date.parse(k.expires_at) <= nowMs ? 'expired' : 'expiring';
  return 'active';
}

function view(k: KeyRow): KeyView {
  return { ...k, status: keyStatus(k) };
}

export function newKeySecret(role: KeyRole): string {
  return `${role === 'public' ? 'pk' : 'sk'}_${bytesToHex(randomBytes(24))}`;
}

export async function listKeys(db: Database): Promise<KeyView[]> {
  const rows = await db.query<KeyRow>(`SELECT ${COLS} FROM api_keys ORDER BY created_at DESC`);
  return rows.map(view);
}

export async function getKey(db: Database, id: string): Promise<KeyRow | null> {
  const [row] = await db.query<KeyRow>(`SELECT ${COLS} FROM api_keys WHERE id = ?`, [id]);
  return row ?? null;
}

async function activeCount(db: Database): Promise<number> {
  const rows = await db.query<KeyRow>(`SELECT ${COLS} FROM api_keys WHERE revoked_at IS NULL`);
  return rows.filter((k) => keyStatus(k) !== 'expired').length;
}

export async function createKey(
  db: Database,
  input: { role: KeyRole; label?: string | null; by?: string | null }
): Promise<{ key: KeyView; secret: string } | { error: 'too_many' }> {
  if ((await activeCount(db)) >= MAX_ACTIVE_KEYS) return { error: 'too_many' };
  const secret = newKeySecret(input.role);
  const id = crypto.randomUUID();
  const label = input.label?.trim().slice(0, 80) || null;
  await db.run(
    `INSERT INTO api_keys (id, key_hash, key_prefix, last4, role, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, await sha256Hex(secret), secret.slice(0, 3), secret.slice(-4), input.role, label, input.by ?? null, iso(Date.now())]
  );
  return { key: view((await getKey(db, id))!), secret };
}

/**
 * Replace a key. `graceHours` = 0 revokes the old one immediately; otherwise it
 * keeps working until that many hours have passed (so a storefront can be redeployed).
 */
export async function rotateKey(
  db: Database,
  id: string,
  opts: { graceHours: number; by?: string | null }
): Promise<{ key: KeyView; secret: string; old: KeyView } | { error: 'not_found' | 'not_active' | 'too_many' }> {
  const old = await getKey(db, id);
  if (!old) return { error: 'not_found' };
  if (keyStatus(old) !== 'active') return { error: 'not_active' };
  const created = await createKey(db, { role: old.role, label: old.label, by: opts.by });
  if ('error' in created) return created;
  const grace = Math.max(0, Math.min(MAX_GRACE_HOURS, Math.floor(opts.graceHours)));
  if (grace === 0) {
    await db.run(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`, [iso(Date.now()), id]);
  } else {
    await db.run(`UPDATE api_keys SET expires_at = ? WHERE id = ?`, [iso(Date.now() + grace * 3_600_000), id]);
  }
  return { key: created.key, secret: created.secret, old: view((await getKey(db, id))!) };
}

export async function revokeKey(db: Database, id: string): Promise<KeyView | null> {
  const k = await getKey(db, id);
  if (!k) return null;
  if (!k.revoked_at) await db.run(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`, [iso(Date.now()), id]);
  return view((await getKey(db, id))!);
}

/** Used on every API-key request. Returns the role when the key is usable right now. */
export async function lookupApiKey(db: Database, keyHash: string): Promise<{ id: string; role: KeyRole } | null> {
  const [row] = await db.query<{ id: string; role: KeyRole; revoked_at: string | null; expires_at: string | null; last_used_at: string | null }>(
    `SELECT id, role, revoked_at, expires_at, last_used_at FROM api_keys WHERE key_hash = ? LIMIT 1`,
    [keyHash]
  );
  if (!row) return null;
  const status = keyStatus(row);
  if (status === 'revoked' || status === 'expired') return null;
  const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (!(last > Date.now() - TOUCH_EVERY_MS)) {
    await db.run(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [iso(Date.now()), row.id]);
  }
  return { id: row.id, role: row.role };
}

export { audit };
