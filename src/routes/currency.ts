// → src/routes/currency.ts
//   GET  /v1/catalog/currency          which currency label the variants carry, compared with the store currency
//   POST /v1/catalog/currency/align    give every variant the store currency label
//
// The store currency is the one set in Admin → Shipping ("base currency", XOF by default). Prices are kept as they are:
// they are already written in the store currency, only the label stored on the variant is old (it used to default to USD).
// Carts and orders already placed keep the currency they were made in.
// Permissions: the /v1/catalog rule in auth/permissions.ts (read = products.read, align = products.write).
import { Hono } from 'hono';
import { getDb, type Database } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { audit } from '../auth/service';
import { type HonoEnv } from '../types';
import { requestSiteRebuild } from '../lib/rebuild';
import { getShippingSettings } from '../lib/shipping';
import { CUSTOM_SKU } from '../lib/custom';

const app = new Hono<HonoEnv>();
app.use('*', authMiddleware, adminOnly);

async function report(db: Database) {
  const store_currency = (await getShippingSettings(db)).base_currency;
  // The hidden free-hand line variant (CUSTOM) is not a product: it is not counted, but it is aligned with the others.
  const rows = await db.query<{ currency: string; n: number }>(
    `SELECT UPPER(TRIM(currency)) AS currency, COUNT(*) AS n FROM variants WHERE sku <> ? GROUP BY UPPER(TRIM(currency)) ORDER BY n DESC, currency`, [CUSTOM_SKU]);
  const by_currency = rows.map((r) => ({ currency: r.currency, count: r.n }));
  const total = by_currency.reduce((a, r) => a + r.count, 0);
  const mismatched = by_currency.filter((r) => r.currency !== store_currency).reduce((a, r) => a + r.count, 0);
  return { store_currency, total, mismatched, by_currency };
}

app.get('/', async (c) => c.json(await report(getDb(c.var.db))));

app.post('/align', async (c) => {
  const db = getDb(c.var.db);
  const before = await report(db);
  const { changes } = await db.run(`UPDATE variants SET currency = ? WHERE currency <> ?`, [before.store_currency, before.store_currency]);
  if (changes === 0) return c.json({ store_currency: before.store_currency, updated: 0 });
  const a = c.get('auth') as any;
  await audit(db, {
    action: 'catalog.currency_align', actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null,
    meta: { to: before.store_currency, updated: before.mismatched, from: before.by_currency.filter((r) => r.currency !== before.store_currency) },
  });
  await requestSiteRebuild(c.var.db);
  return c.json({ store_currency: before.store_currency, updated: before.mismatched });
});

export { app as currencyApp };
