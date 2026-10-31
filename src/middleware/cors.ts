import type { Context, Next } from 'hono';
import { isAllowedOrigin } from '../auth/http';
import { isStoreOrigin } from '../account/http';
import type { Env } from '../types';

// ============================================================
// CORS
// ============================================================
//
// The storefront calls this API from the browser with a public key, from
// whatever origin it is served on, so non-credentialed requests stay open
// (Access-Control-Allow-Origin: *). A wildcard response can never be used with
// cookies, so that is safe: nothing ambient is attached.
//
// Credentialed requests (the admin's session cookie) are different:
//  - an origin listed in ADMIN_ORIGINS is echoed back with
//    Access-Control-Allow-Credentials: true;
//  - any other origin only ever gets the wildcard, so the browser will not
//    send or accept cookies for it;
//  - /v1/auth/* is not served cross-origin at all except to ADMIN_ORIGINS;
//  - /v1/account/* (the customer's own area) is credentialed for STORE_ORIGINS only, and an
//    admin origin is not trusted there (nor a store origin on /v1/auth/*).

export function corsMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const origin = c.req.header('Origin');
    const accountPath = c.req.path.startsWith('/v1/account/');
    const authPath = c.req.path.startsWith('/v1/auth/');
    const trusted = accountPath ? isStoreOrigin(c.env, origin) : isAllowedOrigin(c.env, origin);

    if (trusted) {
      c.header('Access-Control-Allow-Origin', origin!);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
    } else if (!authPath) {
      c.header('Access-Control-Allow-Origin', '*');
    }

    if (c.req.method === 'OPTIONS') {
      if (trusted || !authPath) {
        c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        const asked = c.req.header('Access-Control-Request-Headers');
        if (asked) {
          c.header('Access-Control-Allow-Headers', asked);
          c.header('Vary', 'Origin, Access-Control-Request-Headers');
        }
        c.header('Access-Control-Max-Age', '600');
      }
      return c.body(null, 204);
    }

    if (trusted || !authPath) {
      c.header('Access-Control-Expose-Headers', 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
    }
    await next();
  };
}
