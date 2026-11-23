# Boutik API

The backend of the Boutik online-shop platform: products, stock, carts, checkout, orders, payments, customers, staff accounts, optional modules, backups.
It runs as one Cloudflare Worker with a Durable Object (embedded SQLite) as database and R2 for images and backups.
Each client gets their own deployment of this project. It is used with two front ends: `boutik-storefront` (the public shop) and `boutik-admin` (the back office).

> This repository is a **template**. Do not put a real client's names, addresses, keys or data in it. Create a client's copy as described in the Deployment guide
> (clone the template, keep it as the `upstream` remote, customise the copy).

Started from the open-source [`merchant`](https://github.com/ygwyg/merchant) project (MIT) and has since diverged a lot; see `LICENSE` and `CHANGELOG.md`.

## What it does

- **Catalogue and stock:** products, variants, inventory with reasons, images (R2), digital downloads, services and bookable appointments, discounts, CSV import/export and bulk edits.
- **Checkout and orders:** carts, shipping rates, cash on delivery, deposits and payment plans, manual orders (walk-in, phone), receipts, order profit and costs.
- **Payments:** Stripe, FedaPay (mobile money, XOF) and cash. Provider keys are entered in the admin and stored encrypted.
- **People:** customers with accounts (email link, passkeys), staff with roles (`owner`, `manager`, `staff`, `agency`), personal data export and erasure.
- **Credentials:** public key `pk_…` (storefront), admin key `sk_…`, signed-in sessions, and a setup token that opens first-time setup and recovery. Keys can be rotated.
- **Plans (tiers):** the agency chooses what a client's shop includes (`sells`, limits, optional modules). The storefront and admin read it from `/v1/capabilities`.
- **Optional modules** (off until switched on): ads tracking, affiliates, low-stock alerts, milestone payments, offers (upsell), quotations, abandoned-cart recovery, subscriptions, WiFi vouchers. See `src/modules/MODULES.md` to write one.
- **Operations:** email (Resend, SendGrid, Mailgun, Postmark), web push, outbound webhooks, scheduled backups to a private R2 bucket (the last 14 are kept, `BACKUP_KEEP`) with restore, a launch checklist (`GET /v1/launch`), a 15-minute cron.
- **Agent protocols kept from upstream:** UCP discovery and checkout (`/.well-known/ucp`), OAuth 2.0 with PKCE.

## Project layout

```
src/
  index.ts          entry point: middleware and route mounting
  do.ts, db.ts      the Durable Object (SQLite) and its wrapper
  migrations.ts     schema migrations, run on the next request after a deploy
  routes/           one file per area (catalog, checkout, orders, payments, setup, tier, launch, backup, ...)
  auth/             keys, sessions, passwords, passkeys, permissions
  account/          customer account and privacy
  lib/              checkout, payments, providers, FedaPay, email, push, backup, plans, tiers, shipping, currency, ...
  modules/          optional modules (registry.ts lists them)
  config/           rate limits
  __tests__/        tests (vitest on the Workers runtime)
scripts/            init.ts, init-remote.ts, seed.ts, set-tier.mjs, migrate-d1-to-do.ts
```

## Run it locally

Requires Node.js 22 or later.

```bash
npm install
```

Create `.dev.vars` (never commit it):

```
SETUP_TOKEN=a-long-random-secret
ENVIRONMENT=development
STORE_URL=http://localhost:4321
ADMIN_URL=http://localhost:5173
STORE_ORIGINS=http://localhost:4321
ADMIN_ORIGINS=http://localhost:5173
```

```bash
npm run dev                                          # API on http://localhost:8787
SETUP_TOKEN=a-long-random-secret npx tsx scripts/init.ts   # creates the pk_ and sk_ keys (prints them once)
npx tsx scripts/seed.ts http://localhost:8787 sk_...       # optional demo data
```

Then sign in to the admin: the setup token creates the first owner (`POST /v1/auth/bootstrap` returns a one-time sign-in link). The Deployment guide describes first-time setup step by step.

Tests and type check:

```bash
npx vitest run
npx tsc --noEmit
```

## Configuration

Plain values go in `vars` of `wrangler.jsonc` (store name, `STORE_URL`, `ADMIN_URL`, `STORE_ORIGINS`, `ADMIN_ORIGINS`, `IMAGES_URL`, `COD_COUNTRIES`, ...).
Secrets (`SETUP_TOKEN`, `PASSWORD_PEPPER`, `CONFIG_ENCRYPTION_KEY`, ...) are set with `wrangler secret put` and never go in git.
The template's `wrangler.jsonc` holds placeholders: replace every one for a client. The full list of variables and secrets is in the Deployment guide.

## Deploy

```bash
npx wrangler deploy
```

The first deploy creates the Durable Object database and the R2 buckets (`IMAGES`, and a private `BACKUPS` that must never get a public address). Production is normally deployed by Cloudflare Workers Builds from git
(deploy command `npx wrangler deploy`). Then set the secrets and follow *First-time setup* in the Deployment guide.

## Picking a client's plan

```bash
MERCHANT_URL=https://api.example.com SETUP_TOKEN=... node scripts/set-tier.mjs --list
MERCHANT_URL=https://api.example.com SETUP_TOKEN=... node scripts/set-tier.mjs standard --sells physical,digital
```

## API overview

All routes are under `/v1` and need `Authorization: Bearer <key>` (a `pk_` key can read the public catalogue and create carts; an `sk_` key or a signed-in session can do the rest, within the person's role).
Interactive documentation is served by the Worker at `/docs` (OpenAPI at `/openapi.json`). Main areas:

| Area | Routes |
| --- | --- |
| Catalogue | `/v1/products`, `/v1/inventory`, `/v1/discounts`, `/v1/catalog/*`, `/v1/images`, `/v1/downloads` |
| Checkout | `/v1/carts`, `/v1/shipping`, `/v1/pay`, `/v1/orders`, `/v1/payment-plans`, `/v1/bookings` |
| People | `/v1/auth/*` (sign-in, users, keys, passkeys), `/v1/account/*` (customers), `/v1/customers` |
| Setup | `/v1/setup/*` (init, restore, payment and email providers), `/v1/tier`, `/v1/capabilities`, `/v1/branding`, `/v1/launch` |
| Operations | `/v1/backup`, `/v1/webhooks`, `/v1/push`, `/v1/import`, `/v1/export`, `/v1/profit`, `/v1/costs` |
| Modules | `/v1/m/<id>` (admin), `/m/<id>` (public), `/v1/modules` |
| Agents | `/.well-known/ucp`, `/ucp/v1/checkout-sessions`, `/oauth/*` |

Provider webhooks arrive at `/v1/webhooks/stripe` and `/v1/webhooks/fedapay`.

## Updating a client

Merge the template into the client's repository (`git fetch upstream && git merge upstream/main`), run the tests, push. Read `CHANGELOG.md` first: it says when an update needs a new variable, a secret or a manual step.

## Licence

MIT, see `LICENSE`. Contains code from the `merchant` project (MIT).
