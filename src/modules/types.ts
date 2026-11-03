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

export type AccessLevel = 'read' | 'write';

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
  /** Public routes, mounted at /m/<id>. No sign-in: the module must protect what it serves. */
  publicRoutes?: Hono<HonoEnv>;
};
