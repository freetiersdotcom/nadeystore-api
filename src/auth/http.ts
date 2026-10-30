import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../types';

// ============================================================
// HTTP HELPERS FOR AUTH: origins, client IP, session cookie
// ============================================================
//
// ADMIN_ORIGINS  comma-separated origins allowed to use credentialed requests
//                and the /v1/auth/* endpoints, e.g.
//                "https://admin.myshop.com,http://localhost:5173"
// ADMIN_URL      where sign-in links point (defaults to the first ADMIN_ORIGINS)
//
// The session cookie is `__Host-sid`: HttpOnly, Secure, Path=/, no Domain,
// SameSite=Lax. It works when the admin and the API share a registrable domain
// (admin.shop.com + api.shop.com). On workers.dev / pages.dev the two are
// different sites, so the admin uses the bearer-token fallback there.

export const COOKIE_NAME = 'sid';

type EnvLike = Pick<Env, 'ADMIN_ORIGINS' | 'ADMIN_URL'>;

const clean = (s: string) => s.trim().replace(/\/+$/, '');

export function allowedOrigins(env: EnvLike): string[] {
  return (env.ADMIN_ORIGINS ?? '').split(',').map(clean).filter(Boolean);
}

export function isAllowedOrigin(env: EnvLike, origin: string | undefined | null): boolean {
  if (!origin) return false;
  return allowedOrigins(env).includes(clean(origin));
}

export function adminBaseUrl(env: EnvLike): string | null {
  const base = env.ADMIN_URL ? clean(env.ADMIN_URL) : allowedOrigins(env)[0];
  return base || null;
}

/** The link in a sign-in email. The token is in the fragment, so it never reaches a server log or a Referer header. */
export function confirmUrl(env: EnvLike, token: string): string | null {
  const base = adminBaseUrl(env);
  return base ? `${base}/#confirm=${encodeURIComponent(token)}` : null;
}

export function clientIp(c: Context): string {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, COOKIE_NAME, 'host');
}

export function setSessionCookie(c: Context, token: string, expiresAt: string): void {
  const maxAge = Math.max(60, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  setCookie(c, COOKIE_NAME, token, {
    prefix: 'host',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { prefix: 'host', secure: true, path: '/' });
}
