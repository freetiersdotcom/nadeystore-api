import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../types';

// ============================================================
// HTTP HELPERS FOR STOREFRONT ACCOUNTS
// ============================================================
//
// STORE_ORIGINS  origins of the storefront allowed to use customer cookie sessions
//                (e.g. "https://santenatur.com,https://www.santenatur.com").
//                Defaults to the origin of STORE_URL.
//
// The customer cookie is `__Host-cid` (HttpOnly, Secure, SameSite=Lax, Path=/, no Domain),
// a different name from the admin's `__Host-sid`, so one can never be mistaken for the other.
// Like the admin, it needs the storefront and the API on one registrable domain
// (santenatur.com + api.santenatur.com). Elsewhere (workers.dev, local) the storefront uses
// the bearer-token fallback.

export const CUSTOMER_COOKIE = 'cid';

type EnvLike = Pick<Env, 'STORE_ORIGINS' | 'STORE_URL'>;

const clean = (s: string) => s.trim().replace(/\/+$/, '');

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

export function storeOrigins(env: EnvLike): string[] {
  const list = (env.STORE_ORIGINS ?? '').split(',').map(clean).filter(Boolean);
  const fromUrl = originOf(env.STORE_URL);
  if (fromUrl && !list.includes(fromUrl)) list.push(fromUrl);
  return list;
}

export function isStoreOrigin(env: EnvLike, origin: string | undefined | null): boolean {
  if (!origin) return false;
  return storeOrigins(env).includes(clean(origin));
}

/** Where the link in a sign-in email points: the account page, token in the fragment. */
export function accountConfirmUrl(env: EnvLike, locale: 'fr' | 'en', token: string): string | null {
  const base = originOf(env.STORE_URL) ?? storeOrigins(env)[0];
  if (!base) return null;
  const path = locale === 'en' ? '/en/account/' : '/fr/compte/';
  return `${base}${path}#confirm=${encodeURIComponent(token)}`;
}

export function readCustomerCookie(c: Context): string | undefined {
  return getCookie(c, CUSTOMER_COOKIE, 'host');
}

export function setCustomerCookie(c: Context, token: string, expiresAt: string): void {
  const maxAge = Math.max(60, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  setCookie(c, CUSTOMER_COOKIE, token, {
    prefix: 'host',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge,
  });
}

export function clearCustomerCookie(c: Context): void {
  deleteCookie(c, CUSTOMER_COOKIE, { prefix: 'host', secure: true, path: '/' });
}
