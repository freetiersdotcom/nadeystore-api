// ============================================================
// BACKUPS: a portable copy of the whole database
// ============================================================
//
// The database lives in one Durable Object (SQLite). Cloudflare keeps its own 30-day point-in-time
// history, but that stays inside Cloudflare and cannot be opened by the shop owner. This module writes
// a plain NDJSON copy that can be stored in a private R2 bucket, downloaded, and loaded into a fresh
// deployment (POST /v1/setup/restore).
//
// File format (one JSON object per line, optionally gzip-compressed):
//   {"kind":"meta","format":1,"created_at":"…","tables":{"orders":12,…}}
//   {"t":"orders","r":{…column: value…}}
//
// Left out on purpose: sign-in sessions, one-time codes and tokens, challenges and throttle counters.
// They are short-lived, and a copy of them would be a copy of live credentials. Provider keys stay in
// the file only as the encrypted values stored in `config`; they are useless without CONFIG_ENCRYPTION_KEY,
// which is not part of the backup (keep it in your password manager).

import type { Database } from '../db';
import type { Env } from '../types';

export const BACKUP_FORMAT = 1;
const SKIP = new Set([
  'sessions', 'customer_sessions', 'login_tokens', 'customer_login_tokens', 'customer_codes',
  'webauthn_challenges', 'auth_throttle', 'oauth_tokens', 'oauth_authorizations',
]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PAGE = 500;

async function tableNames(db: Database): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`
  );
  return rows.map((r) => r.name).filter((n) => NAME.test(n) && !n.startsWith('__') && !SKIP.has(n));
}

function enc(v: unknown): unknown {
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let s = ''; for (const b of bytes) s += String.fromCharCode(b);
    return { $b64: btoa(s) };
  }
  return v;
}
function dec(v: unknown): unknown {
  if (v && typeof v === 'object' && '$b64' in (v as any)) {
    const s = atob((v as any).$b64); const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return v;
}

/** The whole database as NDJSON text. */
export async function buildBackup(db: Database): Promise<{ text: string; rows: number; tables: Record<string, number> }> {
  const lines: string[] = []; const counts: Record<string, number> = {}; let total = 0;
  for (const t of await tableNames(db)) {
    let offset = 0; counts[t] = 0;
    for (;;) {
      let page: Record<string, unknown>[];
      try { page = await db.query(`SELECT * FROM "${t}" ORDER BY rowid LIMIT ${PAGE} OFFSET ${offset}`); }
      catch { page = await db.query(`SELECT * FROM "${t}" LIMIT ${PAGE} OFFSET ${offset}`); }
      for (const r of page) {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) o[k] = enc(v);
        lines.push(JSON.stringify({ t, r: o }));
      }
      counts[t] += page.length; total += page.length;
      if (page.length < PAGE) break;
      offset += PAGE;
    }
  }
  const meta = JSON.stringify({ kind: 'meta', format: BACKUP_FORMAT, created_at: new Date().toISOString(), tables: counts });
  return { text: [meta, ...lines].join('\n') + '\n', rows: total, tables: counts };
}

export async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
export async function gunzipIfNeeded(buf: ArrayBuffer): Promise<string> {
  const b = new Uint8Array(buf);
  if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(buf);
}

/** Write today's backup to the private BACKUPS bucket and prune old ones. Returns null when no bucket is bound. */
export async function runBackup(env: Env, db: Database): Promise<{ key: string; bytes: number; rows: number } | null> {
  const bucket = env.BACKUPS;
  if (!bucket) return null;
  const { text, rows } = await buildBackup(db);
  const body = await gzip(text);
  const key = `backups/${new Date().toISOString().slice(0, 10)}.ndjson.gz`;
  await bucket.put(key, body, { httpMetadata: { contentType: 'application/gzip' } });
  const keep = Math.max(3, Number(env.BACKUP_KEEP) || 14);
  const listed = await bucket.list({ prefix: 'backups/' });
  const old = listed.objects.map((o) => o.key).sort().reverse().slice(keep);
  for (const k of old) await bucket.delete(k);
  return { key, bytes: body.byteLength, rows };
}

/**
 * Load a backup into this database. Rows are written with INSERT OR REPLACE, in several passes so
 * that foreign keys are satisfied whatever order the tables come in. Returns what was restored.
 */
export async function restoreBackup(db: Database, text: string): Promise<{ restored: number; skipped: number; tables: Record<string, number> }> {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) throw new Error('The file is empty.');
  const meta = JSON.parse(lines[0]);
  if (meta.kind !== 'meta' || meta.format !== BACKUP_FORMAT) throw new Error('This is not a backup file this version can read.');

  const known = new Set(await tableNames(db));
  const columns = new Map<string, Set<string>>();
  for (const t of known) {
    const info = await db.query<{ name: string }>(`PRAGMA table_info("${t}")`);
    columns.set(t, new Set(info.map((c) => c.name)));
  }

  type Row = { t: string; r: Record<string, unknown> };
  let pending: Row[] = []; let skipped = 0;
  for (const l of lines.slice(1)) {
    const row = JSON.parse(l) as Row;
    if (!known.has(row.t)) { skipped++; continue; }
    pending.push(row);
  }

  const done: Record<string, number> = {}; let restored = 0;
  for (let pass = 0; pass < 6 && pending.length; pass++) {
    const next: Row[] = [];
    for (const row of pending) {
      const cols = Object.keys(row.r).filter((c) => NAME.test(c) && columns.get(row.t)!.has(c));
      if (!cols.length) { skipped++; continue; }
      try {
        await db.run(
          `INSERT OR REPLACE INTO "${row.t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          cols.map((c) => dec(row.r[c]))
        );
        done[row.t] = (done[row.t] ?? 0) + 1; restored++;
      } catch { next.push(row); }
    }
    if (next.length === pending.length) break; // no progress: stop
    pending = next;
  }
  skipped += pending.length;
  return { restored, skipped, tables: done };
}

/** True when this deployment holds no shop data yet (the only state a restore is allowed in). */
export async function isFreshDatabase(db: Database): Promise<boolean> {
  for (const t of ['users', 'api_keys', 'orders', 'products', 'customers']) {
    try {
      const [r] = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t}"`);
      if (r && r.n > 0) return false;
    } catch { /* table missing: counts as empty */ }
  }
  return true;
}
