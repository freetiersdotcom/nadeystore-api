# Writing an optional module

A module is a self-contained feature that a shop can switch on or off (Team page → Optional modules).
Modules are compiled in (no runtime code loading) but **off by default**: until enabled, a module has
no tables, no routes (404) and no menu entry.

## API side

1. Create `src/modules/<id>/index.ts` exporting a `ModuleDef` (see `types.ts`):
   - `id` (lowercase, a-z 0-9 and `-`), `name` and `description` in `fr` and `en`
   - `version` and `migrate`: SQL statements, idempotent (`CREATE TABLE IF NOT EXISTS …`).
     Bump `version` when you change the schema; migrations re-run on the next request.
     Prefix table names with the module id to avoid clashes.
   - `access`: what `manager` / `staff` may do (`'read'` or `'write'`). Owners and agency can do everything.
   - `routes`: Hono app, mounted at `/v1/m/<id>` (admin session or admin API key only).
   - `publicRoutes` (optional): mounted at `/m/<id>`, no login, rate-limited. Escape everything you render.
   - `hooks.orderPaid(db)` (optional): called after an order becomes fully paid (online, cash, manual). Must be idempotent and cheap; failures are logged and never block the payment.
   - `hooks.scheduled(db, ctx)` (optional): called by the 15-minute cron, before expired carts are cleaned up, with `{ storeBaseUrl, storeName }`. Idempotent; errors are logged.
2. Add it to `MODULES` in `src/modules/registry.ts`.
3. Write tests (see `src/__tests__/modules.test.ts`).

Disabling a module keeps its data. Modules must not change core tables; talk to the core through its
public routes (e.g. the quotes admin page creates the order with `POST /v1/orders/manual`).

## Admin side

Add one line to `MODULE_UI` in `admin/src/lib/modules.tsx` (icon + page component) and put the page in
`admin/src/pages/modules/`. Keep its strings inside the page (FR/EN) so core translations stay untouched.
