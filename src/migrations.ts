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
ALTER TABLE api_keys ADD COLUMN label TEXT;
ALTER TABLE api_keys ADD COLUMN last4 TEXT;
ALTER TABLE api_keys ADD COLUMN created_by TEXT;
ALTER TABLE api_keys ADD COLUMN last_used_at TEXT;
ALTER TABLE api_keys ADD COLUMN revoked_at TEXT;
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
ALTER TABLE variants ADD COLUMN product_type TEXT NOT NULL DEFAULT 'physical' CHECK (product_type IN ('physical', 'digital', 'service'));
ALTER TABLE variants ADD COLUMN digital_asset_key TEXT;
ALTER TABLE variants ADD COLUMN updated_at TEXT;
ALTER TABLE carts ADD COLUMN ship_to TEXT;
ALTER TABLE carts ADD COLUMN shipping_name TEXT;
ALTER TABLE carts ADD COLUMN contact_phone TEXT;
ALTER TABLE orders ADD COLUMN cart_id TEXT;
ALTER TABLE orders ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN review_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_cart_id ON orders(cart_id);
ALTER TABLE products ADD COLUMN slug TEXT;
ALTER TABLE products ADD COLUMN description_fr TEXT;
ALTER TABLE products ADD COLUMN description_en TEXT;
ALTER TABLE products ADD COLUMN tags TEXT;
ALTER TABLE products ADD COLUMN video_url TEXT;
ALTER TABLE orders ADD COLUMN service_status TEXT;
ALTER TABLE orders ADD COLUMN service_note TEXT;
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'online';
ALTER TABLE orders ADD COLUMN amount_paid_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN paid_at TEXT;
ALTER TABLE orders ADD COLUMN locale TEXT;
ALTER TABLE carts ADD COLUMN locale TEXT;
CREATE TABLE IF NOT EXISTS order_payments (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), amount_cents INTEGER NOT NULL, method TEXT NOT NULL, reference TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);
UPDATE orders SET amount_paid_cents = total_cents, paid_at = created_at WHERE payment_method = 'online' AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id = orders.id);
INSERT INTO order_payments (id, order_id, amount_cents, method, created_at) SELECT lower(hex(randomblob(16))), id, total_cents, 'online', created_at FROM orders o WHERE o.payment_method = 'online' AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id = o.id);
ALTER TABLE refunds ADD COLUMN source TEXT NOT NULL DEFAULT 'stripe';
ALTER TABLE refunds ADD COLUMN method TEXT;
ALTER TABLE refunds ADD COLUMN reference TEXT;
ALTER TABLE refunds ADD COLUMN note TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON products(slug) WHERE slug IS NOT NULL;
ALTER TABLE products ADD COLUMN deposit_type TEXT;
ALTER TABLE products ADD COLUMN deposit_value INTEGER;
ALTER TABLE products ADD COLUMN deposit_due_days INTEGER;
ALTER TABLE orders ADD COLUMN due_at TEXT;
ALTER TABLE orders ADD COLUMN pay_token TEXT;
ALTER TABLE orders ADD COLUMN reminder_sent_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pay_token ON orders(pay_token) WHERE pay_token IS NOT NULL;
CREATE TABLE IF NOT EXISTS payment_intents (provider TEXT NOT NULL, ref TEXT NOT NULL, kind TEXT NOT NULL, cart_id TEXT, order_id TEXT, amount_cents INTEGER NOT NULL, currency TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (provider, ref));
CREATE INDEX IF NOT EXISTS idx_payment_intents_order ON payment_intents(order_id);
CREATE TABLE IF NOT EXISTS booking_services (product_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, tz TEXT, rules TEXT NOT NULL DEFAULT '[]', lead_hours INTEGER NOT NULL DEFAULT 24, horizon_days INTEGER NOT NULL DEFAULT 60, buffer_min INTEGER NOT NULL DEFAULT 0, step_min INTEGER NOT NULL DEFAULT 30, default_duration_min INTEGER NOT NULL DEFAULT 60, durations TEXT NOT NULL DEFAULT '{}', updated_at TEXT);
CREATE TABLE IF NOT EXISTS booking_blocks (id TEXT PRIMARY KEY, product_id TEXT, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS appointments (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL DEFAULT 'default', product_id TEXT NOT NULL, sku TEXT NOT NULL, title TEXT NOT NULL, cart_id TEXT, order_id TEXT, status TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, customer_tz TEXT, hold_expires_at TEXT, reminder_sent_at TEXT, canceled_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_appointments_time ON appointments(starts_at, status);
CREATE INDEX IF NOT EXISTS idx_appointments_cart ON appointments(cart_id);
CREATE INDEX IF NOT EXISTS idx_appointments_order ON appointments(order_id);
CREATE TABLE IF NOT EXISTS shipping_zones (id TEXT PRIMARY KEY, name TEXT NOT NULL, countries TEXT NOT NULL DEFAULT '[]', regions TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS shipping_rates (id TEXT PRIMARY KEY, zone_id TEXT NOT NULL, name_fr TEXT NOT NULL, name_en TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'flat', flat_cents INTEGER NOT NULL DEFAULT 0, bands TEXT NOT NULL DEFAULT '[]', over_per_kg_cents INTEGER, free_over_cents INTEGER, min_days INTEGER, max_days INTEGER, pickup_address TEXT, active INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_shipping_rates_zone ON shipping_rates(zone_id);
ALTER TABLE carts ADD COLUMN shipping_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE carts ADD COLUMN shipping_label TEXT;
ALTER TABLE carts ADD COLUMN shipping_rate_id TEXT;
ALTER TABLE orders ADD COLUMN shipping_label TEXT
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

export const FEDAPAY_TRANSACTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS fedapay_transactions (
  transaction_id INTEGER PRIMARY KEY,
  cart_id        TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fedapay_transactions_cart ON fedapay_transactions(cart_id)
`;

export const SUBMISSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS submissions (
  id         TEXT PRIMARY KEY,
  form       TEXT NOT NULL DEFAULT 'contact',
  name       TEXT,
  email      TEXT,
  phone      TEXT,
  subject    TEXT,
  message    TEXT NOT NULL,
  locale     TEXT,
  page       TEXT,
  source     TEXT,
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'handled')),
  note       TEXT,
  ip_hash    TEXT,
  created_at TEXT NOT NULL,
  handled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_ip ON submissions(ip_hash, created_at)
`;

// People who sign in to the admin, their sessions, sign-in tokens, throttling and the audit trail.
// (Each statement is run on its own, so none may contain a semicolon.)
export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff', 'agency')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  password_hash TEXT,
  locale        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  last_login_at TEXT,
  created_by    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  idle_seconds INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  via          TEXT NOT NULL DEFAULT 'bearer',
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'login'
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_user ON login_tokens(user_id, created_at);

CREATE TABLE IF NOT EXISTS identities (
  provider   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE TABLE IF NOT EXISTS auth_throttle (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  actor_user_id TEXT,
  actor         TEXT,
  action        TEXT NOT NULL,
  target        TEXT,
  ip            TEXT,
  meta          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at)
`;

// Storefront customer accounts: sign-in tokens and sessions, kept apart from the admin's
// (a customer session can never be read as an admin one). Each statement runs on its own.
export const ACCOUNT_SCHEMA = `
CREATE TABLE IF NOT EXISTS customer_login_tokens (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_login_tokens_email ON customer_login_tokens(email, created_at);

CREATE TABLE IF NOT EXISTS customer_sessions (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  idle_seconds INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  via          TEXT NOT NULL DEFAULT 'bearer',
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions(customer_id)
`;
