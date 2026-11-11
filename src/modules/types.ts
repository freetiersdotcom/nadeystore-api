// ============================================================
// OPTIONAL MODULES
// ============================================================
// A module is a self-contained feature that a shop can switch on or off: its own tables, API routes,
// (optionally) public pages and an admin screen. Modules are part of the build (the list lives in
// modules/registry.ts), so there is no runtime code loading: switching one on only creates its
// tables and opens its routes. Core code never imports a module; a module only uses core helpers.
//
// To write one, see MODULES.md.

import type { Hono } from 'hono';
import type { HonoEnv } from '../types';
import type { Database } from '../db';

export type AccessLevel = 'read' | 'write';

/** What the 15-minute cron gives a module. `stub` and `exec` let it create orders (they are only missing in tests that do not need them). */
export type ScheduledCtx = { storeBaseUrl: string; storeName: string; stub?: import('../types').DOStub; exec?: ExecutionContext };

export type ModuleDef = {
  /** Lower-case id, used in URLs: /v1/m/<id>/… (admin API) and /m/<id>/… (public pages). */
  id: string;
  name: { fr: string; en: string };
  description: { fr: string; en: string };
  /** Bump when `migrate` changes; the new statements run on the next request to the module. */
  version: number;
  /** Idempotent SQL (CREATE TABLE IF NOT EXISTS …, ALTER … guarded by the module). Run when the module is enabled. */
  migrate: string[];
  /** What managers and staff may do. Owner and agency can always do everything. Missing = no access. */
  access: { manager?: AccessLevel; staff?: AccessLevel };
  /** Admin routes, mounted at /v1/m/<id>. Signed-in admin only (the framework checks it and the role). */
  routes?: Hono<HonoEnv>;
  /**
   * Called (only while the module is on) whenever an order has just been fully paid or created.
   * Treat it as a nudge, not as the source of truth: it must be idempotent and must work out for itself
   * which orders it still has to deal with (so a missed call is harmless). Errors are swallowed.
   */
  hooks?: {
    orderPaid?: (db: Database) => Promise<void>;
    /** Called by the 15-minute cron, before carts are cleaned up. Errors are swallowed. */
    scheduled?: (db: Database, ctx: ScheduledCtx) => Promise<void>;
  };
  /** Public routes, mounted at /m/<id>. No sign-in: the module must protect what it serves. */
  publicRoutes?: Hono<HonoEnv>;
};
