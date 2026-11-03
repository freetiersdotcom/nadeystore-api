// → src/routes/bulk.ts
//   POST /v1/import/products?dry_run=1&currency=XOF   body: CSV text. Checks the whole file first; writes nothing if any row is wrong.
//   GET  /v1/export/products.csv?currency=XOF
//   GET  /v1/export/orders.csv?from=2026-01-01&to=2026-01-31&status=paid
//   GET  /v1/export/customers.csv?currency=XOF
// Permissions: see auth/permissions.ts (import = products.write; exports follow what the person may already read).
import { Hono } from 'hono';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { audit } from '../auth/service';
import { ApiError, type HonoEnv } from '../types';
import { requestSiteRebuild } from '../lib/rebuild';
import { getShippingSettings } from '../lib/shipping';
import { applyProductImport, exportCustomersCsv, exportOrdersCsv, exportProductsCsv, planProductImport } from '../lib/bulk';

// Two small apps, mounted at /v1/import and /v1/export, so the sign-in check never touches other /v1 routes.
const importApp = new Hono<HonoEnv>();
const exportApp = new Hono<HonoEnv>();
importApp.use('*', authMiddleware);
exportApp.use('*', authMiddleware);

const MAX_BYTES = 2_000_000;
const who = (c: any) => {
  const a = c.get('auth');
  return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null };
};
async function currencyOf(c: any, db: ReturnType<typeof getDb>): Promise<string> {
  const q = c.req.query('currency');
  if (q !== undefined) {
    if (!/^[A-Za-z]{3}$/.test(q)) throw ApiError.invalidRequest('currency must be a 3-letter code, e.g. XOF');
    return q.toUpperCase();
  }
  return (await getShippingSettings(db)).base_currency;
}
const csvResponse = (c: any, csv: string, name: string) =>
  c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
const stamp = () => new Date().toISOString().slice(0, 10);

importApp.post('/products', async (c) => {
  const db = getDb(c.var.db);
  const declared = Number(c.req.header('Content-Length') ?? 0);
  if (declared > MAX_BYTES) throw ApiError.invalidRequest('The file is too large (2 MB at most).');
  const text = await c.req.text();
  if (text.length > MAX_BYTES) throw ApiError.invalidRequest('The file is too large (2 MB at most).');
  const dryRun = ['1', 'true', 'yes'].includes((c.req.query('dry_run') ?? '').toLowerCase());
  const currency = await currencyOf(c, db);

  const plan = await planProductImport(db, text, currency);
  const report = { dry_run: dryRun, currency, ok: plan.errors.length === 0, summary: plan.summary, errors: plan.errors.slice(0, 100), error_count: plan.errors.length, warnings: plan.warnings.slice(0, 50) };
  if (!report.ok) return c.json({ ...report, applied: false }, dryRun ? 200 : 422);
  if (dryRun) return c.json({ ...report, applied: false });

  await applyProductImport(db, plan);
  await audit(db, { action: 'import.products', ...who(c), meta: plan.summary });
  await requestSiteRebuild(c.var.db);
  return c.json({ ...report, applied: true });
});

exportApp.get('/products.csv', async (c) => {
  const db = getDb(c.var.db);
  const { csv, rows } = await exportProductsCsv(db, await currencyOf(c, db));
  await audit(db, { action: 'export.products', ...who(c), meta: { rows } });
  return csvResponse(c, csv, `products-${stamp()}.csv`);
});

exportApp.get('/orders.csv', async (c) => {
  const db = getDb(c.var.db);
  const from = c.req.query('from'); const to = c.req.query('to');
  for (const d of [from, to]) if (d && !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(d)) throw ApiError.invalidRequest('Dates look like 2026-01-31.');
  const { csv, rows } = await exportOrdersCsv(db, { from, to, status: c.req.query('status') || undefined });
  await audit(db, { action: 'export.orders', ...who(c), meta: { rows, from, to } });
  return csvResponse(c, csv, `orders-${stamp()}.csv`);
});

exportApp.get('/customers.csv', async (c) => {
  const db = getDb(c.var.db);
  const { csv, rows } = await exportCustomersCsv(db, await currencyOf(c, db));
  await audit(db, { action: 'export.customers', ...who(c), meta: { rows } });
  return csvResponse(c, csv, `customers-${stamp()}.csv`);
});

export { importApp, exportApp };
