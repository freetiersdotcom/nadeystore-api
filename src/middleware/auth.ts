import { createMiddleware } from 'hono/factory';
import { parseConfig } from '../lib/config-secrets';
import { getDb } from '../db';
import { ApiError, now, type HonoEnv } from '../types';
import { isAllowedOrigin, readSessionCookie } from '../auth/http';
import { lookupSession, SESSION_PREFIX } from '../auth/service';
import { roleCanRequest, type Permission, roleCan, oauthScopeFor } from '../auth/permissions';
import { lookupApiKey } from '../auth/keys';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

export const authMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  // A session cookie is only considered when no Authorization header is sent.
  const cookieToken = bearer === null ? readSessionCookie(c) : undefined;

  if (bearer === null && !cookieToken) {
    throw ApiError.unauthorized('Missing or invalid Authorization header');
  }

  const db = getDb(c.var.db);
  
  let stripeSecretKey = c.env.STRIPE_SECRET_KEY || null;
  let stripeWebhookSecret = c.env.STRIPE_WEBHOOK_SECRET || null;

  if (!stripeSecretKey) {
    const db = getDb(c.var.db);
    const [configRow] = await db.query<{ value: string }>(
      `SELECT value FROM config WHERE key = 'stripe' LIMIT 1`
    );
    if (configRow) {
      try {
        const parsed = await parseConfig('stripe', configRow.value);
        stripeSecretKey = parsed.secret_key || null;
        stripeWebhookSecret = parsed.webhook_secret || null;
      } catch {
        // malformed config, leave as null
      }
    }
  }

  // ── Signed-in person: session token (bearer) or session cookie ──
  const sessionToken = bearer?.startsWith(SESSION_PREFIX) ? bearer : cookieToken;
  if (sessionToken) {
    const via = bearer ? 'bearer' : 'cookie';
    // Cookies are sent automatically by the browser, so a state-changing request must
    // come from one of our own origins. (Bearer tokens are not ambient: no check needed.)
    if (via === 'cookie' && !SAFE_METHODS.has(c.req.method) && !isAllowedOrigin(c.env, c.req.header('Origin'))) {
      throw ApiError.forbidden('Cross-site request blocked');
    }
    const found = await lookupSession(db, sessionToken);
    if (!found) throw ApiError.unauthorized('Session expired or invalid');
    c.set('auth', {
      role: 'admin',
      stripeSecretKey,
      stripeWebhookSecret,
      via,
      sessionId: found.session_id,
      user: { id: found.user.id, email: found.user.email, name: found.user.name, role: found.user.role },
    });
    await next();
    return;
  }

  const token = bearer as string;

  const isOAuthToken = token.length === 64 && /^[a-f0-9]+$/.test(token);
  if (isOAuthToken) {
    const tokenHash = await hashKey(token);
    const oauthResult = await db.query<any>(
      `SELECT t.*, c.email as customer_email
       FROM oauth_tokens t
       JOIN customers c ON t.customer_id = c.id
       WHERE t.access_token_hash = ? AND t.access_expires_at > ?
       LIMIT 1`,
      [tokenHash, now()]
    );

    if (oauthResult.length > 0) {
      const row = oauthResult[0];
      c.set('auth', {
        role: 'oauth',
        via: 'oauth',
        stripeSecretKey,
        stripeWebhookSecret,
        oauthScopes: row.scope?.split(' ') || [],
        customerEmail: row.customer_email,
      });

      // An OAuth token only reaches the routes its scopes allow (deny by default).
      const need = oauthScopeFor(c.req.method, c.req.path);
      const granted: string[] = row.scope?.split(' ') || [];
      if (need === null || (need !== '' && !granted.includes(need))) {
        throw ApiError.forbidden(need ? `Required scope: ${need}` : 'This route is not available to OAuth tokens');
      }

      await next();
      return;
    }
  }

  const keyHash = await hashKey(token);
  const found = await lookupApiKey(db, keyHash);

  if (!found) {
    throw ApiError.unauthorized('Invalid API key');
  }

  c.set('auth', {
    role: found.role,
    via: 'api_key',
    stripeSecretKey,
    stripeWebhookSecret,
  });

  await next();
});

export const adminOnly = createMiddleware<HonoEnv>(async (c, next) => {
  const auth = c.get('auth');

  if (auth.role !== 'admin') {
    throw ApiError.forbidden('Admin access required');
  }

  // A signed-in person is checked against their role. Admin API keys keep full access.
  if (auth.user) {
    const { ok, needed } = roleCanRequest(auth.user.role, c.req.method, c.req.path);
    if (!ok) {
      throw ApiError.forbidden(needed ? `Your role cannot do this (needs ${needed})` : 'Your role cannot access this route');
    }
  }

  await next();
});

/**
 * Require one specific permission. A signed-in person needs a role that has it;
 * an admin API key is treated like the agency.
 */
export function requirePermission(permission: Permission) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const auth = c.get('auth');
    if (auth.role !== 'admin') throw ApiError.forbidden('Admin access required');
    if (auth.user && !roleCan(auth.user.role, permission)) {
      throw ApiError.forbidden(`Your role cannot do this (needs ${permission})`);
    }
    await next();
  });
}

export function requireScope(...requiredScopes: string[]) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const auth = c.get('auth');

    if (auth.role === 'oauth') {
      const hasAllScopes = requiredScopes.every(
        (scope) => auth.oauthScopes?.includes(scope)
      );
      if (!hasAllScopes) {
        throw ApiError.forbidden(`Required scopes: ${requiredScopes.join(', ')}`);
      }
    }

    await next();
  });
}

export async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateApiKey(prefix: 'pk' | 'sk'): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}_${key}`;
}
