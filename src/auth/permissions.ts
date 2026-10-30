// ============================================================
// ROLES AND PERMISSIONS
// ============================================================
//
// Roles are fixed and live in code on purpose: a DB-editable permission matrix
// is more power than a small shop needs, and one more thing to get wrong.
//
//   owner    the business owner: everything, including users and settings
//   manager  runs the shop day to day: orders (incl. refunds), catalog,
//            stock, customers, discounts, shipping, appointments, messages
//   staff    fulfils: sees orders, updates status, records payments, answers
//            messages, handles appointments. No refunds, discounts, settings
//   agency   the developer/agency: same power as owner, but not listed to the
//            owner in the users list (it still shows in the audit log)
//
// Authorization is resolved from the request (method + path) in one place, so
// route files do not each need a guard. A route that is not listed here is
// denied for manager and staff (deny by default); owner and agency may use it.

export const ROLES = ['owner', 'manager', 'staff', 'agency'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'orders.read', 'orders.write', 'orders.payments', 'orders.refund',
  'products.read', 'products.write',
  'inventory.read', 'inventory.write',
  'customers.read', 'customers.write',
  'discounts.read', 'discounts.write',
  'shipping.read', 'shipping.write',
  'appointments.read', 'appointments.write',
  'messages.read', 'messages.write',
  'webhooks.manage',
  'settings.manage',
  'users.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MANAGER: Permission[] = [
  'orders.read', 'orders.write', 'orders.payments', 'orders.refund',
  'products.read', 'products.write',
  'inventory.read', 'inventory.write',
  'customers.read', 'customers.write',
  'discounts.read', 'discounts.write',
  'shipping.read', 'shipping.write',
  'appointments.read', 'appointments.write',
  'messages.read', 'messages.write',
];

const STAFF: Permission[] = [
  'orders.read', 'orders.write', 'orders.payments',
  'products.read',
  'inventory.read',
  'customers.read',
  'shipping.read',
  'appointments.read', 'appointments.write',
  'messages.read', 'messages.write',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  agency: PERMISSIONS,
  manager: MANAGER,
  staff: STAFF,
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function roleCan(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** Roles that can reach routes this map does not list. */
export function isSuperRole(role: Role): boolean {
  return role === 'owner' || role === 'agency';
}

// ------------------------------------------------------------
// ROUTE -> PERMISSION
// ------------------------------------------------------------

type Rule = { match: RegExp; methods?: string[]; permission: Permission | 'by-method'; resource?: string };

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// First match wins, so specific rules come before general ones.
const RULES: Rule[] = [
  // Money movement on an order
  { match: /^\/v1\/orders\/[^/]+\/refunds?(\/|$)/, methods: ['POST', 'PUT', 'PATCH', 'DELETE'], permission: 'orders.refund' },
  { match: /^\/v1\/orders\/[^/]+\/payments(\/|$)/, methods: ['POST', 'PUT', 'PATCH', 'DELETE'], permission: 'orders.payments' },
  { match: /^\/v1\/orders\/[^/]+\/pay-link$/, permission: 'orders.payments' },
  { match: /^\/v1\/pay(\/|$)/, permission: 'orders.payments' },
  { match: /^\/v1\/orders\/sweep$/, permission: 'orders.payments' },
  // Payment-plan (deposit / installment) settings
  { match: /^\/v1\/payment-plans(\/|$)/, permission: 'settings.manage' },
  // Orders in general
  { match: /^\/v1\/orders(\/|$)/, permission: 'by-method', resource: 'orders' },

  { match: /^\/v1\/(products|catalog|images)(\/|$)/, permission: 'by-method', resource: 'products' },
  { match: /^\/v1\/inventory(\/|$)/, permission: 'by-method', resource: 'inventory' },
  { match: /^\/v1\/customers(\/|$)/, permission: 'by-method', resource: 'customers' },
  { match: /^\/v1\/discounts(\/|$)/, permission: 'by-method', resource: 'discounts' },
  { match: /^\/v1\/shipping(\/|$)/, permission: 'by-method', resource: 'shipping' },
  { match: /^\/v1\/bookings(\/|$)/, permission: 'by-method', resource: 'appointments' },
  { match: /^\/v1\/submissions(\/|$)/, permission: 'by-method', resource: 'messages' },

  { match: /^\/v1\/webhooks(\/|$)/, permission: 'webhooks.manage' },
  { match: /^\/v1\/setup(\/|$)/, permission: 'settings.manage' },
];

/** Permission a request needs, or null when the route is not in the map. */
export function requiredPermission(method: string, path: string): Permission | null {
  const m = method.toUpperCase();
  for (const rule of RULES) {
    if (!rule.match.test(path)) continue;
    if (rule.methods && !rule.methods.includes(m)) continue;
    if (rule.permission !== 'by-method') return rule.permission;
    return `${rule.resource}.${SAFE.has(m) ? 'read' : 'write'}` as Permission;
  }
  return null;
}

/** Can `role` perform this request? Unlisted routes are for owner/agency only. */
export function roleCanRequest(role: Role, method: string, path: string): { ok: boolean; needed: Permission | null } {
  const needed = requiredPermission(method, path);
  if (!needed) return { ok: isSuperRole(role), needed };
  return { ok: roleCan(role, needed), needed };
}

/**
 * OAuth (customer / agent) tokens may only reach the routes listed here.
 * Returns the scope the route needs, '' when any valid token will do, or
 * null when OAuth tokens are not accepted there at all (the default).
 */
export function oauthScopeFor(method: string, path: string): string | null {
  const m = method.toUpperCase();
  if (/^\/v1\/products(\/|$)/.test(path) && SAFE.has(m)) return '';
  if (/^\/v1\/carts(\/|$)/.test(path)) return 'ucp:scopes:checkout_session';
  if (/^\/v1\/orders(\/|$)/.test(path) && SAFE.has(m)) return 'ucp:scopes:order';
  return null;
}
