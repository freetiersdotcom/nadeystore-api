// ============================================================
// DOWNLOAD TOKEN UTILITIES
// ============================================================
//
// Tokens are generated per (order, sku) pair at checkout completion.
// The plain token is embedded in the confirmation email URL.
// Only the SHA-256 hash is stored in the database.
//
// Defaults (all overridable per-variant in the future):
//   expires_in_days  : 7
//   max_downloads    : 5

import type { Database } from '../db';
import { uuid, now } from '../types';

export const DOWNLOAD_DEFAULTS = {
  expires_in_days: 7,
  max_downloads: 5,
} as const;

// ============================================================
// HELPERS
// ============================================================

/** Generate a 32-byte URL-safe random token */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** SHA-256 hash of a token for safe DB storage */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================
// CREATE TOKENS FOR AN ORDER
// ============================================================

export interface DownloadTokenRecord {
  /** Plain (unhashed) token — used in email URLs, never stored */
  plain_token: string;
  sku: string;
  order_id: string;
}

/**
 * Create download tokens for all digital items in an order.
 * Returns records including the plain tokens (for email embedding).
 */
export async function createDownloadTokens(
  db: Database,
  orderId: string,
  digitalItems: Array<{ sku: string; expires_in_days?: number; max_downloads?: number }>
): Promise<DownloadTokenRecord[]> {
  const records: DownloadTokenRecord[] = [];

  for (const item of digitalItems) {
    const plainToken = generateToken();
    const tokenHash = await hashToken(plainToken);

    const expiresInDays = item.expires_in_days ?? DOWNLOAD_DEFAULTS.expires_in_days;
    const maxDownloads = item.max_downloads ?? DOWNLOAD_DEFAULTS.max_downloads;
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();

    await db.run(
      `INSERT INTO download_tokens (id, order_id, sku, token_hash, expires_at, max_downloads, download_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [uuid(), orderId, item.sku, tokenHash, expiresAt, maxDownloads]
    );

    records.push({ plain_token: plainToken, sku: item.sku, order_id: orderId });
  }

  return records;
}

// ============================================================
// VALIDATE A TOKEN AT DOWNLOAD TIME
// ============================================================

export interface DownloadTokenRow {
  id: string;
  order_id: string;
  sku: string;
  token_hash: string;
  expires_at: string;
  download_count: number;
  max_downloads: number;
}

export type ValidateResult =
  | { ok: true; token: DownloadTokenRow }
  | { ok: false; reason: 'not_found' | 'expired' | 'limit_reached' };

export async function validateDownloadToken(
  db: Database,
  plainToken: string
): Promise<ValidateResult> {
  const tokenHash = await hashToken(plainToken);

  const [row] = await db.query<DownloadTokenRow>(
    `SELECT * FROM download_tokens WHERE token_hash = ? LIMIT 1`,
    [tokenHash]
  );

  if (!row) return { ok: false, reason: 'not_found' };

  if (new Date(row.expires_at) < new Date()) {
    return { ok: false, reason: 'expired' };
  }

  if (row.download_count >= row.max_downloads) {
    return { ok: false, reason: 'limit_reached' };
  }

  return { ok: true, token: row };
}

/**
 * Atomically increment the download counter.
 * Returns false if the limit was exceeded (race condition guard).
 */
export async function incrementDownloadCount(
  db: Database,
  tokenId: string,
  maxDownloads: number
): Promise<boolean> {
  const result = await db.run(
    `UPDATE download_tokens
     SET download_count = download_count + 1, last_downloaded_at = ?
     WHERE id = ? AND download_count < ?`,
    [now(), tokenId, maxDownloads]
  );
  return result.changes > 0;
}
