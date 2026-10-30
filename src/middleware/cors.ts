import type { Context, Next } from 'hono';
import { isAllowedOrigin } from '../auth/http';
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
//  - /v1/auth/* is not served cross-origin at all except to ADMIN_ORIGINS.

export function corsMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const origin = c.req.header('Origin');
    const trusted = isAllowedOrigin(c.env, origin);
    const authPath = c.req.path.startsWith('/v1/auth/');

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
