import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, now, type HonoEnv } from '../types';
import { SetupStripeBody, OkResponse, ErrorResponse } from '../schemas';
import { createEmailProvider, type EmailProviderName } from '../lib/email/index';


const app = new OpenAPIHono<HonoEnv>();

const InitKeysBody = z.object({
  keys: z.array(z.object({
    id: z.string().uuid(),
    key_hash: z.string(),
    key_prefix: z.string(),
    role: z.enum(['public', 'admin']),
  })),
}).openapi('InitKeysBody');

const initKeys = createRoute({
  method: 'post',
  path: '/init',
  tags: ['Setup'],
  summary: 'Initialize API keys',
  description: 'Create initial API keys (only works if no keys exist)',
  request: {
    body: { content: { 'application/json': { schema: InitKeysBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: OkResponse } }, description: 'Keys created' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Keys already exist' },
  },
});

app.openapi(initKeys, async (c) => {
  const { keys } = c.req.valid('json');
  const db = getDb(c.var.db);

  const existing = await db.query<{ id: string }>(`SELECT id FROM api_keys LIMIT 1`);
  if (existing.length > 0) {
    throw ApiError.conflict('API keys already exist. Use admin key to manage keys.');
  }

  for (const key of keys) {
    await db.run(
      `INSERT INTO api_keys (id, key_hash, key_prefix, role, created_at) VALUES (?, ?, ?, ?, ?)`,
      [key.id, key.key_hash, key.key_prefix, key.role, now()]
    );
  }

  return c.json({ ok: true as const }, 200);
});

// ============================================================
// SETUP STRIPE
// ============================================================

const setupStripe = createRoute({
  method: 'post',
  path: '/stripe',
  tags: ['Setup'],
  summary: 'Connect Stripe',
  description: 'Configure Stripe API keys for payment processing',
  security: [{ bearerAuth: [] }],
  middleware: [authMiddleware, adminOnly] as const,
  request: {
    body: { content: { 'application/json': { schema: SetupStripeBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: OkResponse } }, description: 'Stripe connected' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid Stripe key' },
  },
});

app.openapi(setupStripe, async (c) => {
  const { stripe_secret_key, stripe_webhook_secret } = c.req.valid('json');

  const res = await fetch('https://api.stripe.com/v1/balance', {
    headers: { Authorization: `Bearer ${stripe_secret_key}` },
  });

  if (!res.ok) {
    throw ApiError.invalidRequest('Invalid Stripe secret key');
  }

  const db = getDb(c.var.db);

  const configValue = JSON.stringify({
    secret_key: stripe_secret_key,
    webhook_secret: stripe_webhook_secret || null,
  });

  await db.run(
    `INSERT INTO config (key, value, updated_at) VALUES ('stripe', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
    [configValue, now(), configValue, now()]
  );

  return c.json({ ok: true as const }, 200);
});

// ============================================================
// SETUP EMAIL
// ============================================================

const SetupEmailBody = z.object({
  provider: z.enum(['resend', 'sendgrid', 'mailgun', 'postmark']).openapi({
    example: 'resend',
    description: 'Email provider. Can be swapped at any time by calling this endpoint again.',
  }),
  api_key: z.string().min(1).openapi({ example: 're_abc123' }),
  from_address: z.string().min(1).openapi({
    example: 'Your Store <noreply@yourstore.com>',
    description: 'Sender address used for all outbound emails',
  }),
  mailgun_domain: z.string().optional().openapi({
    example: 'mg.yourstore.com',
    description: 'Required when provider is "mailgun"',
  }),
  mailgun_region: z.enum(['us', 'eu']).optional().openapi({
    description: 'Mailgun region. Defaults to "us".',
  }),
}).openapi('SetupEmail');

const EmailStatusResponse = z.object({
  ok: z.literal(true),
  provider: z.string(),
  from_address: z.string(),
}).openapi('EmailStatus');

const setupEmailRoute = createRoute({
  method: 'post',
  path: '/email',
  tags: ['Setup'],
  summary: 'Configure email provider',
  description: [
    'Set or swap the email provider used for order confirmation emails.',
    'The API key is validated by sending a test request to the provider.',
    'Supported providers: resend, sendgrid, mailgun, postmark.',
    'Call this endpoint again at any time to switch providers.',
  ].join(' '),
  security: [{ bearerAuth: [] }],
  middleware: [authMiddleware, adminOnly] as const,
  request: {
    body: { content: { 'application/json': { schema: SetupEmailBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: EmailStatusResponse } }, description: 'Email provider configured' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid configuration' },
  },
});

app.openapi(setupEmailRoute, async (c) => {
  const body = c.req.valid('json');

  if (body.provider === 'mailgun' && !body.mailgun_domain) {
    throw ApiError.invalidRequest('mailgun_domain is required when provider is "mailgun"');
  }

  // Validate the provider config by instantiating it
  // (throws if required fields are missing)
  try {
    await createEmailProvider({
      provider: body.provider as EmailProviderName,
      api_key: body.api_key,
      from_address: body.from_address,
      mailgun_domain: body.mailgun_domain,
      mailgun_region: body.mailgun_region,
    });
  } catch (err: any) {
    throw ApiError.invalidRequest(`Invalid email configuration: ${err.message}`);
  }

  const db = getDb(c.var.db);
  const configValue = JSON.stringify({
    provider: body.provider,
    api_key: body.api_key,
    from_address: body.from_address,
    mailgun_domain: body.mailgun_domain ?? null,
    mailgun_region: body.mailgun_region ?? 'us',
  });

  await db.run(
    `INSERT INTO config (key, value, updated_at) VALUES ('email', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
    [configValue, now(), configValue, now()]
  );

  return c.json({
    ok: true as const,
    provider: body.provider,
    from_address: body.from_address,
  }, 200);
});

// ============================================================
// GET /setup/email — check current config (no secrets returned)
// ============================================================

const getEmailRoute = createRoute({
  method: 'get',
  path: '/email',
  tags: ['Setup'],
  summary: 'Get current email provider',
  security: [{ bearerAuth: [] }],
  middleware: [authMiddleware, adminOnly] as const,
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            configured: z.boolean(),
            provider: z.string().nullable(),
            from_address: z.string().nullable(),
          }),
        },
      },
      description: 'Current email config (API key omitted)',
    },
  },
});

app.openapi(getEmailRoute, async (c) => {
  const db = getDb(c.var.db);
  const [row] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'email' LIMIT 1`);

  if (!row) {
    return c.json({ configured: false, provider: null, from_address: null }, 200);
  }

  try {
    const cfg = JSON.parse(row.value);
    return c.json({
      configured: true,
      provider: cfg.provider ?? null,
      from_address: cfg.from_address ?? null,
    }, 200);
  } catch {
    return c.json({ configured: false, provider: null, from_address: null }, 200);
  }
});


const SetupFedaPayBody = z.object({
  secret_key: z.string().min(1).openapi({
    example: 'sk_sandbox_...',
    description: 'FedaPay API secret key (sandbox or live)',
  }),
  webhook_secret: z.string().min(1).openapi({
    example: 'wh_sandbox_...',
    description: [
      'FedaPay webhook signing secret.',
      'Retrieve from: Dashboard → Workbench → Webhooks → Click to reveal.',
    ].join(' '),
  }),
  sandbox: z.boolean().default(false).openapi({
    description: 'true for sandbox/test mode, false for live. Defaults to false.',
  }),
}).openapi('SetupFedaPay');

// ── POST /v1/setup/fedapay ────────────────────────────────────────────────────

const setupFedaPay = createRoute({
  method: 'post',
  path: '/fedapay',
  tags: ['Setup'],
  summary: 'Connect FedaPay',
  description: [
    'Configure FedaPay as a payment gateway.',
    'Validates the secret key against the FedaPay API before saving.',
    'Call again at any time to update credentials or switch sandbox/live mode.',
    'FedaPay config is read by the checkout and webhook routes at request time —',
    'no restart required after updating.',
  ].join(' '),
  security: [{ bearerAuth: [] }],
  middleware: [authMiddleware, adminOnly] as const,
  request: {
    body: { content: { 'application/json': { schema: SetupFedaPayBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: OkResponse } }, description: 'FedaPay connected' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid FedaPay key' },
  },
});

app.openapi(setupFedaPay, async (c) => {
  const { secret_key, webhook_secret, sandbox } = c.req.valid('json');

  // Validate key by calling FedaPay API — use transactions list (a safe read-only endpoint)
  const base = sandbox ? 'https://sandbox-api.fedapay.com' : 'https://api.fedapay.com';
  const res = await fetch(`${base}/v1/transactions/search`, {
    headers: { Authorization: `Bearer ${secret_key}` },
  });

  if (!res.ok) {
    throw ApiError.invalidRequest('Invalid FedaPay secret key');
  }

  const db = getDb(c.var.db);
  const configValue = JSON.stringify({ secret_key, webhook_secret, sandbox });

  await db.run(
    `INSERT INTO config (key, value, updated_at) VALUES ('fedapay', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
    [configValue, now(), configValue, now()]
  );

  return c.json({ ok: true as const }, 200);
});

// ── GET /v1/setup/fedapay ─────────────────────────────────────────────────────

const getFedaPayStatus = createRoute({
  method: 'get',
  path: '/fedapay',
  tags: ['Setup'],
  summary: 'Get FedaPay configuration status',
  description: 'Returns current config status. Secret key and webhook secret are never returned.',
  security: [{ bearerAuth: [] }],
  middleware: [authMiddleware, adminOnly] as const,
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            configured: z.boolean(),
            sandbox: z.boolean().nullable(),
            has_secret_key: z.boolean(),
            has_webhook_secret: z.boolean(),
          }),
        },
      },
      description: 'FedaPay config status (no secrets)',
    },
  },
});

app.openapi(getFedaPayStatus, async (c) => {
  const db = getDb(c.var.db);
  const [row] = await db.query<{ value: string }>(
    `SELECT value FROM config WHERE key = 'fedapay' LIMIT 1`
  );

  if (!row) {
    return c.json({ configured: false, sandbox: null, has_secret_key: false, has_webhook_secret: false }, 200);
  }

  try {
    const cfg = JSON.parse(row.value);
    return c.json({
      configured: true,
      sandbox: cfg.sandbox ?? false,
      has_secret_key: !!cfg.secret_key,
      has_webhook_secret: !!cfg.webhook_secret,
    }, 200);
  } catch {
    return c.json({ configured: false, sandbox: null, has_secret_key: false, has_webhook_secret: false }, 200);
  }
});


export { app as setup };
