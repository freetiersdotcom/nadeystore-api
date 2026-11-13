// Managing codes already loaded: by batch (everything that came in with one file) or one at a time.
// A code that was sold is a record of what a customer received: it is never deleted or moved, whatever you do to its batch.
// "Unsold" below means: not given to any order.
import type { Database } from '../../db';
import { ApiError } from '../../types';
import { reconcile } from './lib';

export type BatchRow = { sku: string; batch: string | null; total: number; available: number; sold: number; void: number; first_at: string };
export type BatchAction = 'void' | 'restore' | 'delete' | 'move' | 'rename';
export type BatchResult = { action: BatchAction; affected: number; kept_sold: number; dry_run: boolean };

export async function listBatches(db: Database, sku?: string): Promise<BatchRow[]> {
  return db.query<BatchRow>(
    `SELECT sku, batch, COUNT(*) AS total,
            SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available, SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END) AS sold, SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) AS void,
            MIN(created_at) AS first_at
       FROM voucher_codes ${sku ? 'WHERE sku = ?' : ''} GROUP BY sku, batch ORDER BY MIN(seq) DESC`, sku ? [sku] : []);
}

const FREE = `order_id IS NULL AND sold_at IS NULL`;

export async function applyBatch(db: Database, o: { sku: string; batch: string | null; action: BatchAction; to_sku?: string; new_name?: string; dry_run?: boolean }): Promise<BatchResult> {
  const where = `sku = ? AND batch IS ?`; const args = [o.sku, o.batch];
  const [{ n: inBatch }] = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM voucher_codes WHERE ${where}`, args);
  if (!inBatch) throw ApiError.notFound('Batch not found');
  const count = async (cond: string) => Number((await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM voucher_codes WHERE ${where} AND ${cond}`, args))[0].n);
  const kept_sold = await count(`NOT (${FREE})`);
  const res = (affected: number): BatchResult => ({ action: o.action, affected, kept_sold, dry_run: !!o.dry_run });
  switch (o.action) {
    case 'void': {
      const n = await count(`status = 'available' AND ${FREE}`); if (o.dry_run) return res(n);
      await db.run(`UPDATE voucher_codes SET status = 'void' WHERE ${where} AND status = 'available' AND ${FREE}`, args); return res(n);
    }
    case 'restore': {
      const n = await count(`status = 'void' AND ${FREE}`); if (o.dry_run) return res(n);
      await db.run(`UPDATE voucher_codes SET status = 'available' WHERE ${where} AND status = 'void' AND ${FREE}`, args);
      await reconcile(db); return res(n);   // paid orders that were waiting for codes are served
    }
    case 'delete': {
      const n = await count(FREE); if (o.dry_run) return res(n);
      await db.run(`DELETE FROM voucher_codes WHERE ${where} AND ${FREE}`, args); return res(n);
    }
    case 'move': {
      if (!o.to_sku || o.to_sku === o.sku) throw ApiError.invalidRequest('Choose another voucher product to move the codes to.');
      const [to] = await db.query(`SELECT 1 FROM voucher_plans WHERE sku = ?`, [o.to_sku]); if (!to) throw ApiError.invalidRequest('That product is not a voucher plan.');
      const n = await count(FREE); if (o.dry_run) return res(n);
      await db.run(`UPDATE voucher_codes SET sku = ? WHERE ${where} AND ${FREE}`, [o.to_sku, ...args]);
      await reconcile(db); return res(n);
    }
    case 'rename': {
      const name = (o.new_name ?? '').trim().slice(0, 80) || null; if (o.dry_run) return res(inBatch);
      await db.run(`UPDATE voucher_codes SET batch = ? WHERE ${where}`, [name, ...args]); return res(inBatch);   // only a label: sold codes may be renamed too
    }
  }
}
