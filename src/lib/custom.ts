// Free-hand lines: one hidden product ("CUSTOM") that every free-hand quote or order line points at.
// It is a draft Digital variant with no file and no stock, so it never shows in the shop (checkout refuses a
// draft variant), needs no stock or delivery address, and sends no download link. Each line carries its own title and price.
import type { Database } from '../db';
import { uuid } from '../types';

export const CUSTOM_SKU = 'CUSTOM';

export async function ensureCustomItem(db: Database): Promise<void> {
  const [v] = await db.query<{ id: string }>(`SELECT id FROM variants WHERE sku = ?`, [CUSTOM_SKU]);
  if (v) return;
  const [cur] = await db.query<{ currency: string }>(`SELECT currency FROM variants WHERE sku <> ? LIMIT 1`, [CUSTOM_SKU]);
  const pid = 'custom-line-product';                           // fixed id: a second call (or a race) finds it instead of adding another
  await db.run(`INSERT OR IGNORE INTO products (id, title, status) VALUES (?, 'Free-hand line (internal)', 'draft')`, [pid]);
  await db.run(
    `INSERT OR IGNORE INTO variants (id, product_id, sku, title, price_cents, currency, weight_g, product_type, status) VALUES (?, ?, ?, 'Free-hand line', 0, ?, 0, 'digital', 'draft')`,
    [uuid(), pid, CUSTOM_SKU, cur?.currency ?? 'XOF']
  );
  await db.run(`INSERT OR IGNORE INTO inventory (id, sku, on_hand, reserved) VALUES (?, ?, 0, 0)`, [uuid(), CUSTOM_SKU]);
}

/** A free-hand line must say what it is and what it costs the customer. */
export function checkCustomLine(l: { title?: string | null; unit_price_cents?: number | null }): string | null {
  if (!l.title || !l.title.trim()) return 'A free-hand line needs a description.';
  if (l.unit_price_cents == null || !Number.isInteger(l.unit_price_cents) || l.unit_price_cents < 0) return 'A free-hand line needs a price.';
  return null;
}
