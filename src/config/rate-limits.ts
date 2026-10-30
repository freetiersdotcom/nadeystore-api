// ============================================================
// RATE LIMIT CONFIGURATION
// ============================================================
// Easy to update - just modify these values
// Limits are per API key, per window

export type RateLimitConfig = {
  requests: number; // Max requests allowed
  windowMs: number; // Time window in milliseconds
  /**
   * Count in the database instead of in this isolate's memory, so the limit holds
   * across all isolates and restarts. One extra write per request: use it for the
   * endpoints that are worth abusing (checkout, forms, uploads, payment links).
   */
  durable?: boolean;
};

export const rateLimits = {
  // Default for all endpoints
  default: {
    requests: 100,
    windowMs: 60 * 1000, // 1 minute
  },

  // Per role overrides
  roles: {
    admin: {
      requests: 500,
      windowMs: 60 * 1000,
    },
    public: {
      requests: 60,
      windowMs: 60 * 1000,
    },
  },

  // Per endpoint overrides (path prefix -> config)
  // More specific paths take precedence
  endpoints: {
    // Checkout is rate limited more strictly to prevent abuse
    '/v1/carts': {
      requests: 30,
      windowMs: 60 * 1000,
      durable: true,
    },
    // Public forms and payment links: cheap to abuse, so counted durably per IP
    '/v1/submissions': {
      requests: 10,
      windowMs: 60 * 1000,
      durable: true,
    },
    '/v1/pay': {
      requests: 30,
      windowMs: 60 * 1000,
      durable: true,
    },
    '/v1/downloads': {
      requests: 30,
      windowMs: 60 * 1000,
      durable: true,
    },
    // Webhooks from Stripe need higher limits
    '/v1/webhooks/stripe': {
      requests: 1000,
      windowMs: 60 * 1000,
    },
    // Images upload is expensive
    '/v1/images': {
      requests: 20,
      windowMs: 60 * 1000,
      durable: true,
    },
	// Webhooks from FedaPay need higher limits
	'/v1/webhooks/fedapay': {
	  requests: 1000,
      windowMs: 60 * 1000,
	},
  },

  // IPs/keys to never rate limit (e.g., internal services)
  // Add API key prefixes or full keys here
  whitelist: [] as string[],

  // Whether to include rate limit headers in responses
  includeHeaders: true,
} as const;

// Helper to get limit for a specific request
export function getLimitForRequest(path: string, role?: 'admin' | 'public'): RateLimitConfig {
  return resolveLimit(path, role).config;
}

/** Same lookup, also saying which bucket the request counts against. */
export function resolveLimit(path: string, role?: 'admin' | 'public'): { config: RateLimitConfig; bucket: string } {
  // Check endpoint-specific overrides first
  for (const [prefix, config] of Object.entries(rateLimits.endpoints) as [string, RateLimitConfig][]) {
    if (path.startsWith(prefix)) {
      return { config, bucket: prefix };
    }
  }

  // Check role-based limits
  if (role && rateLimits.roles[role]) {
    return { config: rateLimits.roles[role], bucket: `role:${role}` };
  }

  // Fall back to default
  return { config: rateLimits.default, bucket: 'default' };
}
