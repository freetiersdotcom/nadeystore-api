import { type MerchantDO } from './do';

export type Env = {
  MERCHANT: DurableObjectNamespace<MerchantDO>;
  IMAGES?: R2Bucket;
  IMAGES_URL?: string;
  STORE_NAME?: string;
  STORE_URL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** One-time secret required to call POST /v1/setup/init. Set via `wrangler secret put SETUP_TOKEN`. */
  SETUP_TOKEN?: string;
  /** Optional Cloudflare Workers Builds deploy-hook URL; when set, catalog edits trigger a (debounced) frontstore rebuild. Set via `wrangler secret put REBUILD_HOOK_URL`. */
  REBUILD_HOOK_URL?: string;
  /** Seconds to wait after the first catalog edit before triggering the rebuild (default 60, minimum 10). */
  REBUILD_DEBOUNCE_SECONDS?: string;

  /** Comma-separated origins allowed for credentialed requests and /v1/auth/*, e.g. "https://admin.myshop.com,http://localhost:5173". */
  ADMIN_ORIGINS?: string;
  /** Base URL of the admin app, used in sign-in links. Defaults to the first ADMIN_ORIGINS entry. */
  ADMIN_URL?: string;
  /** Secret mixed into password hashes and sign-in codes. Set with `wrangler secret put PASSWORD_PEPPER`; do not change once users have passwords. */
  PASSWORD_PEPPER?: string;
  /** Storefront origins allowed to use customer cookie sessions, comma-separated. Defaults to the origin of STORE_URL. */
  STORE_ORIGINS?: string;
  /** Encrypts Stripe / FedaPay / email provider keys stored in the database. Set with `wrangler secret put CONFIG_ENCRYPTION_KEY` (32+ random characters). */
  CONFIG_ENCRYPTION_KEY?: string;

  TURNSTILE_SECRET?: string;      // wrangler secret put TURNSTILE_SECRET
  CONTACT_NOTIFY_EMAIL?: string;  // optional: also email each message to this address
};

export type DOStub = {
  query: <T = unknown>(sql: string, params: unknown[]) => Promise<T[]>;
  run: (sql: string, params: unknown[]) => Promise<{ changes: number }>;
  broadcast: (event: { type: string; data: unknown; timestamp: string }) => void;
  scheduleRebuild: () => Promise<void>;
};

export type Variables = {
  db: DOStub;
  auth: AuthContext;
};

export type HonoEnv = {
  Bindings: Env;
  Variables: Variables;
};

export type AuthRole = 'public' | 'admin' | 'oauth';

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  role: 'owner' | 'manager' | 'staff' | 'agency';
};

export type AuthContext = {
  role: AuthRole;
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
  oauthScopes?: string[];
  customerEmail?: string;
  /** Set when the caller signed in as a person (session). Absent for API keys and OAuth tokens. */
  user?: AuthUser;
  /** How the caller authenticated. */
  via?: 'api_key' | 'bearer' | 'cookie' | 'oauth';
  sessionId?: string;
};

export class ApiError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError('unauthorized', 401, message);
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError('forbidden', 403, message);
  }

  static notFound(message = 'Not found') {
    return new ApiError('not_found', 404, message);
  }

  static invalidRequest(message: string, details?: Record<string, unknown>) {
    return new ApiError('invalid_request', 400, message, details);
  }

  static conflict(message: string) {
    return new ApiError('conflict', 409, message);
  }

  static insufficientInventory(sku: string) {
    return new ApiError('insufficient_inventory', 409, `Insufficient inventory for SKU: ${sku}`, {
      sku,
    });
  }

  static stripeError(message: string) {
    return new ApiError('stripe_error', 502, message);
  }
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export function generateOrderNumber(): string {
  const now = new Date();
  const datePart = now.toISOString().slice(2, 10).replace(/-/g, '');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `ORD-${datePart}-${suffix}`;
}

export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
