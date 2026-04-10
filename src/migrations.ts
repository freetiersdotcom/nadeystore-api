// ============================================================
// SCHEMA ADDITIONS FOR do.ts
// ============================================================
//
// Add these statements to the SCHEMA string in do.ts.
// They use IF NOT EXISTS / ADD COLUMN so they're safe to run
// against an existing database.
//
// 1. Add product_type + digital_asset_key to variants
// 2. Add last_downloaded_at to download_tokens
// 3. Create download_tokens table
// 4. Add index on download_tokens

// ----------------------------------------------------------------
// PASTE INTO the SCHEMA constant in do.ts (before the closing backtick)
// ----------------------------------------------------------------

/*

-- Digital product support on variants
-- product_type: 'physical' (default, ships as goods) | 'digital' (downloadable asset)
-- digital_asset_key: R2 object key, e.g. "assets/ebook-v2.pdf"
ALTER TABLE variants ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'physical'
  CHECK (product_type IN ('physical', 'digital'));

ALTER TABLE variants ADD COLUMN IF NOT EXISTS digital_asset_key TEXT;

-- Download tokens (one per order+sku pair for digital items)
CREATE TABLE IF NOT EXISTS download_tokens (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  max_downloads INTEGER NOT NULL DEFAULT 5,
  download_count INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_download_tokens_order ON download_tokens(order_id);
CREATE INDEX IF NOT EXISTS idx_download_tokens_sku ON download_tokens(sku);
CREATE INDEX IF NOT EXISTS idx_download_tokens_expires ON download_tokens(expires_at);

*/

// ----------------------------------------------------------------
// NOTE ON SQLite ALTER TABLE
// ----------------------------------------------------------------
// Cloudflare Durable Objects use SQLite which supports
// ADD COLUMN but not IF NOT EXISTS on ALTER TABLE.
// The ensureInitialized() method in MerchantDO runs on every
// cold start, so we need these statements to be idempotent.
//
// The safest pattern for the existing codebase is to wrap the
// ALTER TABLE calls in a try/catch inside ensureInitialized():
//
//   private ensureInitialized(): void {
//     if (this.initialized) return;
//     // Run CREATE TABLE statements (all use IF NOT EXISTS — safe)
//     const statements = SCHEMA.split(';')...
//     for (const stmt of statements) { this.sql.exec(stmt); }
//
//     // Run ALTER TABLE migrations (may fail if column already exists)
//     const migrations = MIGRATIONS.split(';')...
//     for (const stmt of migrations) {
//       try { this.sql.exec(stmt); } catch { /* column already exists */ }
//     }
//     this.initialized = true;
//   }
//
// See the MIGRATIONS constant below for the exact statements to use.

export const MIGRATIONS = `
ALTER TABLE variants ADD COLUMN product_type TEXT NOT NULL DEFAULT 'physical' CHECK (product_type IN ('physical', 'digital'));
ALTER TABLE variants ADD COLUMN digital_asset_key TEXT
`;

// The download_tokens table and its indexes go into SCHEMA (already uses IF NOT EXISTS).
export const DOWNLOAD_TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS download_tokens (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  max_downloads INTEGER NOT NULL DEFAULT 5,
  download_count INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_download_tokens_order ON download_tokens(order_id);
CREATE INDEX IF NOT EXISTS idx_download_tokens_sku ON download_tokens(sku);
CREATE INDEX IF NOT EXISTS idx_download_tokens_expires ON download_tokens(expires_at)
`;
