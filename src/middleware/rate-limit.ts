import { Context, Next } from 'hono';
import { rateLimits, resolveLimit, type RateLimitConfig } from '../config/rate-limits';
import { throttle } from '../auth/service';
import { getDb } from '../db';
import { ApiError, type Env } from '../types';
import { readSessionCookie } from '../auth/http';

const hasSessionCookie = (c: Context) => !!readSessionCookie(c);

// ============================================================
// RATE LIMITING MIDDLEWARE
// ============================================================
// Two tiers, both keyed by client IP:
//  - durable (config.durable): fixed-window counters in the database, exact across
//    all isolates. Used for checkout, forms, uploads, payment links.
//  - in memory: cheap, per isolate, so only approximate. Used for everything else.

type WindowCounter = {
  count: number;
  windowStart: number;
};

// In-memory store - resets when isolate recycles
// Key format: `${identifier}:${windowStart}`
const counters = new Map<string, WindowCounter>();

// Cleanup old entries periodically
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 60 * 1000; // 1 minute

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;

  lastCleanup = now;
  const cutoff = now - 5 * 60 * 1000; // Remove entries older than 5 minutes

  for (const [key, value] of counters.entries()) {
    if (value.windowStart < cutoff) {
      counters.delete(key);
    }
  }
}

function getWindowStart(windowMs: number): number {
  const now = Date.now();
  return Math.floor(now / windowMs) * windowMs;
}

function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): { allowed: boolean; remaining: number; resetAt: number } {
  cleanup();

  const windowStart = getWindowStart(config.windowMs);
  const key = `${identifier}:${windowStart}`;

  let counter = counters.get(key);

  if (!counter || counter.windowStart !== windowStart) {
    counter = { count: 0, windowStart };
    counters.set(key, counter);
  }

  const remaining = Math.max(0, config.requests - counter.count);
  const resetAt = windowStart + config.windowMs;

  if (counter.count >= config.requests) {
    return { allowed: false, remaining: 0, resetAt };
  }

  counter.count++;
  return { allowed: true, remaining: remaining - 1, resetAt };
}

/**
 * Rate limiting middleware
 * Must be applied after auth middleware to get role info
 */
export function rateLimitMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const path = c.req.path;

    // The caller is identified by IP address, never by the Authorization header:
    // that header is chosen by the caller, so keying on it would let anyone get a
    // fresh bucket per request by sending a different fake token.
    const authHeader = c.req.header('Authorization');
    const apiKey = authHeader?.replace('Bearer ', '');
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';

    // Check whitelist
    if (apiKey && rateLimits.whitelist.some((w) => apiKey.startsWith(w))) {
      return next();
    }

    // Determine role from API key prefix
    let role: 'admin' | 'public' | undefined;
    if (apiKey?.startsWith('sk_') || apiKey?.startsWith('ses_') || (!apiKey && hasSessionCookie(c))) {
      role = 'admin';
    } else if (apiKey?.startsWith('pk_')) {
      role = 'public';
    }

    // Get rate limit config for this request
    const { config, bucket } = resolveLimit(path, role);

    // Check rate limit: durable (database) for the sensitive endpoints, in memory otherwise
    let allowed: boolean, remaining: number, resetAt: number;
    if (config.durable) {
      const r = await throttle(getDb((c as any).var.db), `rl:${bucket}:${ip}`, config.requests, Math.ceil(config.windowMs / 1000));
      allowed = r.allowed;
      remaining = 0;
      resetAt = Date.now() + r.retryAfter * 1000;
    } else {
      ({ allowed, remaining, resetAt } = checkRateLimit(`${bucket}:${ip}`, config));
    }

    // Add headers if configured (the durable tier does not know the remaining count)
    if (rateLimits.includeHeaders && !config.durable) {
      c.header('X-RateLimit-Limit', String(config.requests));
      c.header('X-RateLimit-Remaining', String(remaining));
      c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    }

    if (!allowed) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      c.header('Retry-After', String(retryAfter));

      throw new ApiError(
        'rate_limit_exceeded',
        429,
        `Rate limit exceeded. Try again in ${retryAfter} seconds.`
      );
    }

    return next();
  };
}

/**
 * Get current rate limit status for an identifier
 * Useful for debugging or admin endpoints
 */
export function getRateLimitStatus(identifier: string, config: RateLimitConfig) {
  const windowStart = getWindowStart(config.windowMs);
  const key = `${identifier}:${windowStart}`;
  const counter = counters.get(key);

  return {
    identifier,
    requests_made: counter?.count || 0,
    requests_limit: config.requests,
    requests_remaining: Math.max(0, config.requests - (counter?.count || 0)),
    window_ms: config.windowMs,
    window_reset_at: new Date(windowStart + config.windowMs).toISOString(),
  };
}
