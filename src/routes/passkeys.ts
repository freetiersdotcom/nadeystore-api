import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from '@hono/zod-openapi';
import { getDb, type Database } from '../db';
import { ApiError, type HonoEnv } from '../types';
import { clientIp, isAllowedOrigin, setSessionCookie } from '../auth/http';
import { audit, createSession, getAuthSettings, getUserById, publicUser, throttle } from '../auth/service';
import { permissionsFor } from '../auth/permissions';
import { authMiddleware } from '../middleware/auth';
import { createCustomerSession, publicCustomer } from '../account/service';
import { isStoreOrigin, setCustomerCookie } from '../account/http';
import { customerAuth } from './account';
import {
  beginLogin, beginRegistration, deletePasskey, finishLogin, finishRegistration, listPasskeys,
  PasskeyError, type Realm,
} from '../auth/passkeys';

// =============================================================================
// /v1/auth/passkeys (admin) and /v1/account/passkeys (customers): the same routes twice.
//
//   POST /login/options               start a passkey sign-in           (public)
//   POST /login/verify  { challenge_id, response, mode }  finish it → a normal session
//   GET  /                            my passkeys                       (signed in)
//   POST /register/options            start adding one                  (signed in)
//   POST /register/verify { challenge_id, response, name? }  finish it
//   DELETE /:id                       remove one
//
// Signing in with a passkey ends in exactly the same kind of session as an email link
// (same cookie / bearer token, same expiry rules); nothing else changes about sessions.
// =============================================================================

type Subject = { id: string; email: string; name: string | null };

type Adapter = {
  realm: Realm;
  /** Middleware that requires a signed-in person of this realm. */
  auth: MiddlewareHandler;
  subject(c: any): Subject;
  originAllowed(env: any, origin: string | undefined): boolean;
  /** Start a session for subjectId; null when that account may not sign in. */
  start(c: any, db: Database, subjectId: string, mode: 'cookie' | 'bearer'): Promise<Response | null>;
  rpName(c: any): string;
};

const storeName = (c: any) => (c.env.STORE_NAME as string | undefined) ?? 'Your Store';

const adminAdapter: Adapter = {
  realm: 'admin',
  auth: authMiddleware,
  subject(c) {
    const u = c.get('auth')?.user;
    // Admin API keys have no person behind them: they cannot own passkeys.
    if (!u) throw ApiError.forbidden('Sign in as a person to manage passkeys.');
    return { id: u.id, email: u.email, name: u.name ?? null };
  },
  originAllowed: (env, o) => isAllowedOrigin(env, o),
  async start(c, db, subjectId, mode) {
    const user = await getUserById(db, subjectId);
    if (!user || user.status !== 'active') return null;
    const settings = await getAuthSettings(db);
    const ip = clientIp(c);
    const s = await createSession(db, user, settings, { ip, userAgent: c.req.header('User-Agent'), via: mode });
    await audit(db, { action: 'auth.login', actor_user_id: user.id, actor: user.email, ip, meta: { how: 'passkey', mode } });
    if (mode === 'cookie') setSessionCookie(c, s.token, s.expires_at);
    return c.json({
      ok: true, user: publicUser(user), role: user.role, permissions: permissionsFor(user.role), expires_at: s.expires_at,
      ...(mode === 'bearer' ? { session_token: s.token } : {}),
    });
  },
  rpName: storeName,
};

const customerAdapter: Adapter = {
  realm: 'customer',
  auth: customerAuth,
  subject(c) {
    const cu = c.get('acct').customer;
    return { id: cu.id, email: cu.email, name: cu.name ?? null };
  },
  originAllowed: (env, o) => isStoreOrigin(env, o),
  async start(c, db, subjectId, mode) {
    const [row] = await db.query<any>(
      `SELECT id, email, name, phone, locale, accepts_marketing, email_verified_at, order_count, created_at FROM customers WHERE id = ?`, [subjectId]);
    if (!row) return null;
    const s = await createCustomerSession(db, row.id, { ip: clientIp(c), userAgent: c.req.header('User-Agent'), via: mode });
    if (mode === 'cookie') {
      setCustomerCookie(c, s.token, s.expires_at);
      return c.json({ ok: true, customer: publicCustomer(row), expires_at: s.expires_at });
    }
    return c.json({ ok: true, customer: publicCustomer(row), expires_at: s.expires_at, session_token: s.token });
  },
  rpName: storeName,
};

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
async function readJson(c: any): Promise<unknown> { try { return await c.req.json(); } catch { return {}; } }
async function limit(c: any, db: Database, key: string, max: number, windowSec: number) {
  const r = await throttle(db, key, max, windowSec);
  if (!r.allowed) {
    c.header('Retry-After', String(r.retryAfter));
    throw new ApiError('rate_limit_exceeded', 429, `Too many attempts. Try again in ${Math.max(1, Math.ceil(r.retryAfter / 60))} minute(s).`);
  }
}
/** Library/domain errors become clean 4xx answers. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof PasskeyError) {
      throw e.status === 401 ? ApiError.unauthorized(e.message)
        : e.status === 409 ? ApiError.conflict(e.message)
        : ApiError.invalidRequest(e.message);
    }
    throw e;
  }
}

// A WebAuthn response is a small JSON object; refuse anything oversized before it reaches the parser.
const ResponseJson = z.object({ id: z.string().max(1400), rawId: z.string().max(1400), type: z.literal('public-key'), response: z.record(z.string(), z.any()) }).passthrough();
const Mode = z.enum(['cookie', 'bearer']).default('bearer');
const LoginVerify = z.object({ challenge_id: z.string().max(80), response: ResponseJson, mode: Mode });
const RegisterVerify = z.object({ challenge_id: z.string().max(80), response: ResponseJson, name: z.string().trim().max(60).optional() });

export function passkeyRoutes(a: Adapter) {
  const r = new Hono<HonoEnv>();
  r.use('*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store'); });
  const origin = (c: any) => c.req.header('Origin') as string | undefined;

  r.post('/login/options', async (c) => {
    const db = getDb(c.var.db);
    await limit(c, db, `pk-opt:${a.realm}:${clientIp(c)}`, 60, 900);
    return c.json(await guarded(() => beginLogin(db, c.env, a.realm, origin(c))));
  });

  r.post('/login/verify', async (c) => {
    const b = parse(LoginVerify, await readJson(c));
    const db = getDb(c.var.db);
    const ip = clientIp(c);
    await limit(c, db, `pk-verify:${a.realm}:${ip}`, 30, 900);
    if (b.mode === 'cookie' && !a.originAllowed(c.env, origin(c))) {
      throw ApiError.invalidRequest('Cookie sessions are not available from this origin. Use mode "bearer".');
    }
    const who = await guarded(() => finishLogin(db, c.env, a.realm, origin(c), b.challenge_id, b.response as any));
    const res = who ? await a.start(c, db, who.subject_id, b.mode) : null;
    if (!res) {
      if (a.realm === 'admin') await audit(db, { action: 'auth.verify_failed', actor: null, ip, meta: { how: 'passkey' } });
      throw ApiError.unauthorized('This passkey could not be used to sign in. Use your email instead.');
    }
    return res;
  });

  r.get('/', a.auth, async (c) => {
    const s = a.subject(c);
    return c.json({ items: await listPasskeys(getDb(c.var.db), a.realm, s.id) });
  });

  r.post('/register/options', a.auth, async (c) => {
    const s = a.subject(c);
    const db = getDb(c.var.db);
    await limit(c, db, `pk-reg:${a.realm}:${s.id}`, 20, 3600);
    return c.json(await guarded(() => beginRegistration(db, c.env, a.realm, origin(c), s, a.rpName(c))));
  });

  r.post('/register/verify', a.auth, async (c) => {
    const b = parse(RegisterVerify, await readJson(c));
    const s = a.subject(c);
    const db = getDb(c.var.db);
    const passkey = await guarded(() => finishRegistration(db, c.env, a.realm, origin(c), s.id, b.challenge_id, b.response as any, b.name ?? null));
    if (a.realm === 'admin') await audit(db, { action: 'auth.passkey_added', actor_user_id: s.id, actor: s.email, ip: clientIp(c), meta: { id: passkey.id } });
    return c.json({ passkey }, 201);
  });

  r.delete('/:id', a.auth, async (c) => {
    const s = a.subject(c);
    const db = getDb(c.var.db);
    const ok = await deletePasskey(db, a.realm, s.id, c.req.param('id'));
    if (!ok) throw ApiError.notFound('Passkey not found');
    if (a.realm === 'admin') await audit(db, { action: 'auth.passkey_removed', actor_user_id: s.id, actor: s.email, ip: clientIp(c), meta: { id: c.req.param('id') } });
    return c.json({ ok: true });
  });

  return r;
}

export const adminPasskeyRoutes = passkeyRoutes(adminAdapter);
export const customerPasskeyRoutes = passkeyRoutes(customerAdapter);
