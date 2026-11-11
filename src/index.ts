import { OpenAPIHono } from '@hono/zod-openapi';
import { corsMiddleware } from './middleware/cors';
import { authRoutes } from './routes/auth';
import { launchRoutes } from './routes/launch';
import { profitRoutes, costRoutes } from './routes/profit';
import { shopRoutes } from './routes/shop';
import { accountRoutes } from './routes/account';
import { privacyRoutes } from './routes/privacy';
import { adminPasskeyRoutes, customerPasskeyRoutes } from './routes/passkeys';
import { purgePasskeyData } from './auth/passkeys';
import { purgeAccountData } from './account/service';
import { purgeAuthData } from './auth/service';
import { setConfigKey } from './lib/config-secrets';
import { swaggerUI } from '@hono/swagger-ui';
import { setup } from './routes/setup';
import { catalog } from './routes/catalog';
import { inventory } from './routes/inventory';
import { checkout } from './routes/checkout';
import { cod } from './routes/cod';
import { payments } from './routes/payments';
import { depositRoutes, payLinks, planAdmin, planSettings } from './routes/plans';
import { sweepPlans, storeBase } from './lib/plans';
import { bookings } from './routes/bookings';
import { sweepAppointments } from './lib/appointments';
import { getDb } from './db';
import { orders } from './routes/orders';
import { shippingCart, shippingAdmin } from './routes/shipping';
import { customers } from './routes/customers';
import { webhooks } from './routes/webhooks';
import { webhooksRoutes } from './routes/webhooks-outbound';
import { images } from './routes/images';
import { discounts } from './routes/discounts';
import { oauth } from './routes/oauth';
import { ucp } from './routes/ucp';
import { downloads } from './routes/downloads';
import { assetRoutes } from './routes/assets';
import { submissions } from './routes/submissions';
import { backupRoutes } from './routes/backup';
import { importApp, exportApp } from './routes/bulk';
import { pushApp } from './routes/push';
import { moduleAdmin } from './routes/modules';
import { authMiddleware } from './middleware/auth';
import { MODULES, ensureInstalled, isEnabled, getModule, runScheduledHooks } from './modules/registry';
import { runBackup } from './lib/backup';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { ApiError, type Env, type DOStub } from './types';
import { MerchantDO } from './do';

export { MerchantDO };

type Variables = {
  db: DOStub;
};

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.use('*', corsMiddleware());

app.use('*', async (c, next) => {
  setConfigKey(c.env.CONFIG_ENCRYPTION_KEY);
  const id = c.env.MERCHANT.idFromName('default');
  const stub = c.env.MERCHANT.get(id);
  c.set('db', stub as unknown as DOStub);
  await next();
});

app.use('/v1/*', rateLimitMiddleware());

app.onError((err, c) => {
  console.error(err);

  if (err instanceof ApiError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details && { details: err.details }),
        },
      },
      err.statusCode as any
    );
  }

  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
});

app.get('/', (c) => c.json({ name: 'merchant', version: '0.1.0', ok: true }));

app.route('/v1/setup', setup);
// Passkey routes first: they are more specific than the two areas they live under.
app.route('/v1/auth/passkeys', adminPasskeyRoutes);
app.route('/v1/auth', authRoutes);
app.route('/v1/account/passkeys', customerPasskeyRoutes);
app.route('/v1/account/privacy', privacyRoutes);
app.route('/v1/account', accountRoutes);
app.route('/v1/products', catalog);
app.route('/v1/inventory', inventory);
app.route('/v1/carts', checkout);
app.route('/v1/carts', shippingCart);
app.route('/v1/shipping', shippingAdmin);
app.route('/v1/carts', cod);
app.route('/v1/orders', orders);
app.route('/v1/orders', payments);
app.route('/v1/carts', depositRoutes);
app.route('/v1/pay', payLinks);
app.route('/v1/orders', planAdmin);
app.route('/v1/payment-plans', planSettings);
app.route('/v1/bookings', bookings);
app.route('/v1/customers', customers);
app.route('/v1/webhooks', webhooks);
app.route('/v1/webhooks', webhooksRoutes);
app.route('/v1/images', images);
app.route('/v1/discounts', discounts);
app.route('/oauth', oauth);
app.route('', oauth);
app.route('', ucp);

// Mount downloads (public — no auth wrapper needed, token is the credential)
app.route('/v1/downloads', downloads);

// Mount asset upload under the catalog products path
app.route('/v1/catalog/products', assetRoutes);

app.route('/v1/submissions', submissions);
app.route('/v1/backup', backupRoutes);
app.route('/v1/launch', launchRoutes);
app.route('/v1/shop-profile', shopRoutes);
app.route('/v1/profit', profitRoutes);
app.route('/v1/costs', costRoutes);
// Optional modules (see modules/MODULES.md). Admin routes live at /v1/m/<id>, public pages at /m/<id>.
app.route('/v1/modules', moduleAdmin);
app.use('/v1/push/*', authMiddleware);
app.route('/v1/push', pushApp);
app.use('/v1/m/*', authMiddleware);
app.use('/v1/m/*', async (c, next) => {
  if ((c as any).get('auth').role !== 'admin') throw ApiError.forbidden('Admin access required'); // not a public key, not an OAuth token
  await next();
});
const moduleGate = async (c: any, next: any) => {
  const id = /^\/(?:v1\/)?m\/([a-z][a-z0-9-]*)(\/|$)/.exec(c.req.path)?.[1];
  const mod = id ? getModule(id) : undefined;
  const db = getDb(c.var.db as DOStub);
  if (!mod || !(await isEnabled(db, mod.id))) return c.json({ error: { code: 'not_found', message: 'This module is not enabled.' } }, 404);
  await ensureInstalled(db, mod);
  await next();
};
app.use('/v1/m/*', moduleGate);
app.use('/m/*', rateLimitMiddleware());
app.use('/m/*', moduleGate);
for (const m of MODULES) {
  if (m.routes) app.route(`/v1/m/${m.id}`, m.routes);
  if (m.publicRoutes) app.route(`/m/${m.id}`, m.publicRoutes);
}

app.route('/v1/import', importApp);
app.route('/v1/export', exportApp);

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Merchant API',
    version: '1.0.0',
    description: 'The open-source commerce backend for Cloudflare + Stripe',
  },
  servers: [{ url: '/' }],
});

app.get('/docs', swaggerUI({ url: '/openapi.json' }));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    setConfigKey(env.CONFIG_ENCRYPTION_KEY);
    const id = env.MERCHANT.idFromName('default');
    const stub = env.MERCHANT.get(id);
    const typedStub = stub as unknown as {
      cleanupExpiredCarts: () => Promise<number>;
      cleanupStaleCheckedOutCarts: () => Promise<number>;
    };
    // Optional modules first: abandoned-cart recovery must copy cart contents before they are cleaned up.
    await runScheduledHooks(getDb(stub as unknown as DOStub), { storeBaseUrl: storeBase(env as any), storeName: (env as any).STORE_NAME ?? 'Your Store', stub: stub as unknown as DOStub, exec: ctx });
    const cleaned = await typedStub.cleanupExpiredCarts();
    console.log(`Cron: cleaned ${cleaned} expired carts`);
    try {
      const swept = await sweepPlans(getDb(stub as unknown as DOStub), {
        storeBaseUrl: storeBase(env as any), storeName: (env as any).STORE_NAME ?? 'Your Store',
      });
      console.log(`Cron: payment plans — ${swept.reminded} reminded, ${swept.canceled} canceled`);
    } catch (err) {
      console.error('Cron: payment plan sweep failed', err);
    }
    try {
      const appts = await sweepAppointments(getDb(stub as unknown as DOStub), {
        storeBaseUrl: storeBase(env as any), storeName: (env as any).STORE_NAME ?? 'Your Store',
      });
      console.log(`Cron: appointments — ${appts.reminded} reminded`);
    } catch (err) {
      console.error('Cron: appointment sweep failed', err);
    }
    try {
      await purgeAuthData(getDb(stub as unknown as DOStub));
      await purgeAccountData(getDb(stub as unknown as DOStub));
      await purgePasskeyData(getDb(stub as unknown as DOStub));
    } catch (err) {
      console.error('Cron: auth cleanup failed', err);
    }
    // Daily backup to the private BACKUPS bucket, in the 02:00 UTC run.
    const at = new Date(event.scheduledTime);
    if (at.getUTCHours() === 2 && at.getUTCMinutes() < 15) {
      try {
        const b = await runBackup(env, getDb(stub as unknown as DOStub));
        if (b) console.log(`Cron: backup ${b.key} (${b.rows} rows, ${b.bytes} bytes)`);
      } catch (err) {
        console.error('Cron: backup failed', err);
      }
    }
    const staleCheckouts = await typedStub.cleanupStaleCheckedOutCarts();
    console.log(`Cron: released ${staleCheckouts} stale checked-out carts`);
  },
};
