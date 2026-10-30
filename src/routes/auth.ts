import { Hono } from 'hono';
import { z } from '@hono/zod-openapi';
import { getDb, type Database } from '../db';
import { ApiError, isValidEmail, type HonoEnv } from '../types';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { getEmailProvider } from '../lib/email/index';
import { sha256Hex, timingSafeEqual } from '../auth/crypto';
import {
  clearSessionCookie, clientIp, confirmUrl, isAllowedOrigin, setSessionCookie,
} from '../auth/http';
import { sendLoginEmail } from '../auth/email';
import {
  checkPasswordShape, hashPassword, needsRehash, verifyPassword, PASSWORD_MAX_BYTES,
  PBKDF2_MAX_ITERATIONS,
} from '../auth/password';
import { configEncryptionEnabled, isSealed, parseConfig, sealConfig } from '../lib/config-secrets';
import { createKey, listKeys, revokeKey, rotateKey, MAX_GRACE_HOURS, type KeyRole } from '../auth/keys';
import { PERMISSIONS, ROLES, isSuperRole, permissionsFor, type Role } from '../auth/permissions';
import {
  CODE_MAX_ATTEMPTS, LOGIN_TOKEN_TTL_MIN, audit, consumeCode, consumeLinkToken, countActiveOwners,
  createSession, createUser, getAuthSettings, getUserByEmail, getUserById, issueLoginToken, listUsers,
  normEmail, policyOf, publicUser, revokeSession, revokeUserSessions, saveAuthSettings, setPasswordHash,
  throttle, updateUser, type AuthSettings, type UserRow,
} from '../auth/service';

// =============================================================================
// /v1/auth: sign-in for the people who run the shop
//
//  public
//   GET  /config          which sign-in methods are on
//   POST /login-link      { email, locale? }            emails a link and a 6-digit code
//   POST /verify          { token } | { email, code }   redeems them, starts a session
//   POST /login           { email, password }           only when password sign-in is enabled
//   POST /bootstrap       X-Setup-Token                 creates (or re-opens) an owner / agency account
//  signed in
//   GET  /me · POST /logout · POST /logout-all · PUT /password
//  users.manage (owner, agency)
//   GET/PUT /settings · GET/POST /users · PATCH /users/:id · POST /users/:id/invite
//  audit.read
//   GET  /audit
//
// `mode` on verify/login: "cookie" sets the __Host-sid session cookie (needs an
// origin from ADMIN_ORIGINS); "bearer" returns the session token in the body
// for the admin to send as `Authorization: Bearer ses_...`.
// =============================================================================

export const authRoutes = new Hono<HonoEnv>();

authRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw ApiError.invalidRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

async function readJson(c: any): Promise<unknown> {
  try { return await c.req.json(); } catch { return {}; }
}

async function limit(c: any, db: Database, key: string, max: number, windowSec: number) {
  const r = await throttle(db, key, max, windowSec);
  if (!r.allowed) {
    c.header('Retry-After', String(r.retryAfter));
    throw new ApiError('rate_limit_exceeded', 429, `Too many attempts. Try again in ${Math.max(1, Math.ceil(r.retryAfter / 60))} minute(s).`);
  }
}

const emailSchema = z.string().trim().max(254).refine(isValidEmail, 'Invalid email address');
const modeSchema = z.enum(['cookie', 'bearer']).default('bearer');
const localeSchema = z.enum(['fr', 'en']).optional();

const storeName = (c: any) => (c.env.STORE_NAME as string | undefined) ?? 'Your Store';

function sessionPayload(user: UserRow, expires_at: string, token: string | null) {
  return {
    ok: true as const,
    user: publicUser(user),
    role: user.role,
    permissions: permissionsFor(user.role),
    expires_at,
    ...(token ? { session_token: token } : {}),
  };
}

/** Start a session for `user` and shape the response for the chosen mode. */
async function startSession(c: any, db: Database, user: UserRow, mode: 'cookie' | 'bearer', how: string) {
  const settings = await getAuthSettings(db);
  const ip = clientIp(c);
  const s = await createSession(db, user, settings, { ip, userAgent: c.req.header('User-Agent'), via: mode });
  await audit(db, { action: 'auth.login', actor_user_id: user.id, actor: user.email, ip, meta: { how, mode } });
  if (mode === 'cookie') {
    setSessionCookie(c, s.token, s.expires_at);
    return c.json(sessionPayload(user, s.expires_at, null));
  }
  return c.json(sessionPayload(user, s.expires_at, s.token));
}

/** Refuse cookie mode early (before a one-time token is spent) when the origin cannot use it. */
function assertModeAllowed(c: any, mode: 'cookie' | 'bearer') {
  if (mode === 'cookie' && !isAllowedOrigin(c.env, c.req.header('Origin'))) {
    throw ApiError.invalidRequest('Cookie sessions are not available from this origin. Use mode "bearer", or add the admin URL to ADMIN_ORIGINS.');
  }
}

// ---------------------------------------------------------------------------
// GET /config
// ---------------------------------------------------------------------------
authRoutes.get('/config', async (c) => {
  const db = getDb(c.var.db);
  const settings = await getAuthSettings(db);
  const provider = await getEmailProvider(db).catch(() => null);
  return c.json({
    methods: { link: true, code: true, password: settings.password_login },
    email_ready: !!provider,
    cookie_mode: isAllowedOrigin(c.env, c.req.header('Origin')),
  });
});

// ---------------------------------------------------------------------------
// POST /login-link
// ---------------------------------------------------------------------------
const LoginLinkBody = z.object({ email: emailSchema, locale: localeSchema });

authRoutes.post('/login-link', async (c) => {
  const b = parse(LoginLinkBody, await readJson(c));
  const email = normEmail(b.email);
  const db = getDb(c.var.db);
  const ip = clientIp(c);

  await limit(c, db, `link:ip:${ip}`, 20, 3600);
  await limit(c, db, `link:email:${(await sha256Hex(email)).slice(0, 32)}`, 5, 3600);

  const user = await getUserByEmail(db, email);
  if (user && user.status === 'active') {
    const issued = await issueLoginToken(db, user, c.env.PASSWORD_PEPPER);
    // Send in the background so the response time does not tell whether the account exists.
    const job = sendLoginEmail(db, {
      to: user.email, name: user.name, role: user.role, storeName: storeName(c),
      link: confirmUrl(c.env, issued.token), code: issued.code, ttlMinutes: LOGIN_TOKEN_TTL_MIN,
      kind: 'login', locale: b.locale ?? user.locale,
    });
    try { c.executionCtx.waitUntil(job); } catch { await job; }
    await audit(db, { action: 'auth.link_requested', actor_user_id: user.id, actor: user.email, ip });
  }
  // Same answer whether or not the address belongs to an account.
  return c.json({ ok: true, expires_in: LOGIN_TOKEN_TTL_MIN * 60 });
});

// ---------------------------------------------------------------------------
// POST /verify
// ---------------------------------------------------------------------------
const VerifyBody = z
  .object({
    token: z.string().max(200).optional(),
    email: emailSchema.optional(),
    code: z.string().max(12).optional(),
    mode: modeSchema,
  })
  .refine((v) => !!v.token || (!!v.email && !!v.code), 'Provide a token, or an email and a code');

authRoutes.post('/verify', async (c) => {
  const b = parse(VerifyBody, await readJson(c));
  assertModeAllowed(c, b.mode);
  const db = getDb(c.var.db);
  const ip = clientIp(c);

  await limit(c, db, `verify:ip:${ip}`, 30, 900);
  if (b.email) await limit(c, db, `verify:email:${(await sha256Hex(normEmail(b.email))).slice(0, 32)}`, 10, 900);

  const user = b.token
    ? await consumeLinkToken(db, b.token)
    : await consumeCode(db, b.email!, b.code!, c.env.PASSWORD_PEPPER);

  if (!user) {
    await audit(db, { action: 'auth.verify_failed', actor: b.email ? normEmail(b.email) : null, ip, meta: { how: b.token ? 'link' : 'code' } });
    throw ApiError.unauthorized('This link or code is invalid or has expired. Request a new one.');
  }
  return startSession(c, db, user, b.mode, b.token ? 'link' : 'code');
});

// ---------------------------------------------------------------------------
// POST /login (email + password, when enabled)
// ---------------------------------------------------------------------------
const LoginBody = z.object({ email: emailSchema, password: z.string().min(1).max(PASSWORD_MAX_BYTES), mode: modeSchema });

authRoutes.post('/login', async (c) => {
  const b = parse(LoginBody, await readJson(c));
  const db = getDb(c.var.db);
  const settings = await getAuthSettings(db);
  if (!settings.password_login) {
    throw new ApiError('password_login_disabled', 403, 'Password sign-in is not enabled. Use the sign-in link.');
  }
  assertModeAllowed(c, b.mode);
  const email = normEmail(b.email);
  const ip = clientIp(c);

  // Throttle before any hashing: one limit per account and one per address, so neither
  // a single IP guessing many accounts nor many IPs guessing one account gets far.
  await limit(c, db, `login:ip:${ip}`, 30, 900);
  await limit(c, db, `login:email:${(await sha256Hex(email)).slice(0, 32)}`, 8, 900);

  const user = await getUserByEmail(db, email);
  const pepper = c.env.PASSWORD_PEPPER;
  const policy = policyOf(settings);
  let ok = false;
  if (user && user.status === 'active' && user.password_hash) {
    ok = await verifyPassword(b.password, user.password_hash, pepper);
  } else {
    // Spend comparable CPU when there is nothing to check, so timing does not reveal the account.
    await hashPassword(b.password, policy, pepper);
  }
  if (!ok || !user) {
    await audit(db, { action: 'auth.login_failed', actor: email, ip, meta: { how: 'password' } });
    throw ApiError.unauthorized('Invalid email or password');
  }
  // Bring the stored hash up to the current policy (new iteration count, pepper added, ...).
  if (needsRehash(user.password_hash!, policy, pepper)) {
    await setPasswordHash(db, user.id, await hashPassword(b.password, policy, pepper));
  }
  return startSession(c, db, user, b.mode, 'password');
});

// ---------------------------------------------------------------------------
// POST /bootstrap
// ---------------------------------------------------------------------------
// The holder of SETUP_TOKEN (a Worker secret) can create an owner or agency
// account and get a one-time sign-in link back, even before email works. It is
// also the way back in if every owner is locked out: run it again for the same
// address. Unset the secret to switch this off.
const BootstrapBody = z.object({
  email: emailSchema,
  name: z.string().trim().max(120).optional(),
  role: z.enum(['owner', 'agency']).default('owner'),
  password: z.string().max(PASSWORD_MAX_BYTES).optional(),
});

authRoutes.post('/bootstrap', async (c) => {
  if (!c.env.SETUP_TOKEN) {
    throw ApiError.invalidRequest('SETUP_TOKEN is not configured. Set it with `wrangler secret put SETUP_TOKEN` to use this endpoint.');
  }
  const db = getDb(c.var.db);
  const ip = clientIp(c);
  await limit(c, db, `bootstrap:ip:${ip}`, 5, 900);

  const provided = c.req.header('X-Setup-Token');
  if (!provided || !timingSafeEqual(provided, c.env.SETUP_TOKEN)) {
    await audit(db, { action: 'auth.bootstrap_denied', ip });
    throw ApiError.unauthorized('Missing or invalid X-Setup-Token header');
  }

  const b = parse(BootstrapBody, await readJson(c));
  if (b.password !== undefined) {
    const bad = checkPasswordShape(b.password);
    if (bad) throw ApiError.invalidRequest(bad);
  }
  const settings = await getAuthSettings(db);

  let user = await getUserByEmail(db, b.email);
  const created = !user;
  if (!user) {
    user = await createUser(db, { email: b.email, name: b.name ?? null, role: b.role, createdBy: 'bootstrap' });
  } else {
    user = (await updateUser(db, user.id, { role: b.role, status: 'active', ...(b.name ? { name: b.name } : {}) }))!;
  }
  if (b.password) await setPasswordHash(db, user.id, await hashPassword(b.password, policyOf(settings), c.env.PASSWORD_PEPPER));

  const issued = await issueLoginToken(db, user, c.env.PASSWORD_PEPPER, { ttlMinutes: 30, purpose: 'bootstrap' });
  await audit(db, { action: created ? 'auth.bootstrap_created' : 'auth.bootstrap_reopened', actor: 'setup-token', target: user.email, ip, meta: { role: user.role } });

  return c.json({
    ok: true,
    created,
    user: publicUser(user),
    login_url: confirmUrl(c.env, issued.token),
    token: issued.token,
    code: issued.code,
    expires_at: issued.expires_at,
  });
});

// ---------------------------------------------------------------------------
// GET /me · POST /logout · POST /logout-all
// ---------------------------------------------------------------------------
authRoutes.get('/me', authMiddleware, (c) => {
  const auth = c.get('auth');
  if (auth.role !== 'admin') throw ApiError.forbidden('Admin access required');
  if (auth.user) {
    return c.json({
      kind: 'session' as const,
      user: auth.user,
      role: auth.user.role,
      permissions: permissionsFor(auth.user.role),
      via: auth.via,
    });
  }
  // An admin API key is not a person. It keeps full access (agency level).
  return c.json({ kind: 'api_key' as const, user: null, role: null, permissions: [...PERMISSIONS], via: 'api_key' });
});

authRoutes.post('/logout', authMiddleware, async (c) => {
  const auth = c.get('auth');
  const db = getDb(c.var.db);
  if (auth.sessionId) {
    await revokeSession(db, auth.sessionId);
    await audit(db, { action: 'auth.logout', actor_user_id: auth.user?.id, actor: auth.user?.email, ip: clientIp(c) });
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.post('/logout-all', authMiddleware, async (c) => {
  const auth = c.get('auth');
  if (!auth.user) throw ApiError.invalidRequest('Only a signed-in person can sign out everywhere');
  const db = getDb(c.var.db);
  await revokeUserSessions(db, auth.user.id);
  await audit(db, { action: 'auth.logout_all', actor_user_id: auth.user.id, actor: auth.user.email, ip: clientIp(c) });
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// PUT /password: set or change your own password
// ---------------------------------------------------------------------------
const PasswordBody = z.object({
  current_password: z.string().max(PASSWORD_MAX_BYTES).optional(),
  new_password: z.string().max(PASSWORD_MAX_BYTES),
});

authRoutes.put('/password', authMiddleware, async (c) => {
  const auth = c.get('auth');
  if (!auth.user) throw ApiError.forbidden('Sign in as a person to set a password');
  const db = getDb(c.var.db);
  const settings = await getAuthSettings(db);
  if (!settings.password_login) throw new ApiError('password_login_disabled', 403, 'Password sign-in is not enabled.');
  const b = parse(PasswordBody, await readJson(c));
  const bad = checkPasswordShape(b.new_password);
  if (bad) throw ApiError.invalidRequest(bad);

  await limit(c, db, `pwchange:user:${auth.user.id}`, 5, 900);
  const user = (await getUserById(db, auth.user.id))!;
  const pepper = c.env.PASSWORD_PEPPER;
  if (user.password_hash) {
    if (!b.current_password || !(await verifyPassword(b.current_password, user.password_hash, pepper))) {
      throw ApiError.unauthorized('Current password is incorrect');
    }
  }
  await setPasswordHash(db, user.id, await hashPassword(b.new_password, policyOf(settings), pepper));
  // A new password closes every other session.
  await revokeUserSessions(db, user.id, auth.sessionId);
  await audit(db, { action: 'auth.password_changed', actor_user_id: user.id, actor: user.email, ip: clientIp(c) });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET/PUT /settings
// ---------------------------------------------------------------------------
function settingsView(c: any, s: AuthSettings) {
  const cost = s.scrypt.n * s.scrypt.r * s.scrypt.p;
  return {
    ...s,
    pepper_configured: !!c.env.PASSWORD_PEPPER,
    pbkdf2_max_iterations: PBKDF2_MAX_ITERATIONS,
    // OWASP: PBKDF2-HMAC-SHA256 needs 600,000 iterations (not reachable here); scrypt needs
    // roughly N*r*p >= 655,360 (e.g. N=2^15, r=8, p=3).
    meets_owasp: s.kdf === 'scrypt' && cost >= 655_360,
  };
}

authRoutes.get('/settings', authMiddleware, requirePermission('users.manage'), async (c) => {
  return c.json(settingsView(c, await getAuthSettings(getDb(c.var.db))));
});

const SettingsBody = z.object({
  password_login: z.boolean().optional(),
  kdf: z.enum(['pbkdf2', 'scrypt']).optional(),
  iterations: z.number().int().optional(),
  scrypt: z.object({ n: z.number().int(), r: z.number().int(), p: z.number().int() }).partial().optional(),
  session_days: z.number().int().optional(),
  idle_days: z.number().int().optional(),
});

authRoutes.put('/settings', authMiddleware, requirePermission('users.manage'), async (c) => {
  const b = parse(SettingsBody, await readJson(c));
  const db = getDb(c.var.db);
  const next = await saveAuthSettings(db, b as Partial<AuthSettings>);
  const auth = c.get('auth');
  await audit(db, { action: 'auth.settings_changed', actor_user_id: auth.user?.id, actor: auth.user?.email ?? 'api-key', ip: clientIp(c), meta: b as Record<string, unknown> });
  return c.json(settingsView(c, next));
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
const isAgencyLevel = (auth: { user?: { role: Role } }) => !auth.user || auth.user.role === 'agency';

authRoutes.get('/users', authMiddleware, requirePermission('users.manage'), async (c) => {
  const auth = c.get('auth');
  const rows = await listUsers(getDb(c.var.db), { includeAgency: isAgencyLevel(auth) });
  return c.json({ items: rows.map(publicUser) });
});

const INVITE_TTL_MIN = 7 * 24 * 60;

async function inviteUser(c: any, db: Database, user: UserRow, locale: string | null | undefined) {
  const issued = await issueLoginToken(db, user, c.env.PASSWORD_PEPPER, { ttlMinutes: INVITE_TTL_MIN, purpose: 'invite' });
  const link = confirmUrl(c.env, issued.token);
  const sent = await sendLoginEmail(db, {
    to: user.email, name: user.name, role: user.role, storeName: storeName(c),
    link, code: issued.code, ttlMinutes: INVITE_TTL_MIN, kind: 'invite', locale: locale ?? user.locale,
  });
  // When no email could be sent, hand the link back so the owner can pass it on.
  return { invite_sent: sent, ...(sent ? {} : { invite_url: link, invite_code: issued.code }) };
}

const CreateUserBody = z.object({
  email: emailSchema,
  name: z.string().trim().max(120).optional(),
  role: z.enum(ROLES),
  locale: localeSchema,
});

authRoutes.post('/users', authMiddleware, requirePermission('users.manage'), async (c) => {
  const auth = c.get('auth');
  const b = parse(CreateUserBody, await readJson(c));
  if (b.role === 'agency' && !isAgencyLevel(auth)) throw ApiError.forbidden('Only the agency can create an agency account');
  const db = getDb(c.var.db);
  if (await getUserByEmail(db, b.email)) throw ApiError.conflict('A user with this email already exists');
  const user = await createUser(db, { email: b.email, name: b.name ?? null, role: b.role, locale: b.locale ?? null, createdBy: auth.user?.id ?? 'api-key' });
  await audit(db, { action: 'user.created', actor_user_id: auth.user?.id, actor: auth.user?.email ?? 'api-key', target: user.email, ip: clientIp(c), meta: { role: user.role } });
  const invite = await inviteUser(c, db, user, b.locale);
  return c.json({ user: publicUser(user), ...invite }, 201);
});

authRoutes.post('/users/:id/invite', authMiddleware, requirePermission('users.manage'), async (c) => {
  const auth = c.get('auth');
  const db = getDb(c.var.db);
  const user = await getUserById(db, c.req.param('id'));
  // Agency accounts do not exist as far as the owner is concerned.
  if (!user || (user.role === 'agency' && !isAgencyLevel(auth))) throw ApiError.notFound('User not found');
  if (user.status !== 'active') throw ApiError.invalidRequest('This user is disabled');
  const invite = await inviteUser(c, db, user, null);
  await audit(db, { action: 'user.invited', actor_user_id: auth.user?.id, actor: auth.user?.email ?? 'api-key', target: user.email, ip: clientIp(c) });
  return c.json({ user: publicUser(user), ...invite });
});

const UpdateUserBody = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

authRoutes.patch('/users/:id', authMiddleware, requirePermission('users.manage'), async (c) => {
  const auth = c.get('auth');
  const b = parse(UpdateUserBody, await readJson(c));
  const db = getDb(c.var.db);
  const target = await getUserById(db, c.req.param('id'));
  if (!target || (target.role === 'agency' && !isAgencyLevel(auth))) throw ApiError.notFound('User not found');
  if (b.role === 'agency' && !isAgencyLevel(auth)) throw ApiError.forbidden('Only the agency can grant the agency role');

  // Never leave the shop without an active owner.
  const losesOwner =
    target.role === 'owner' && target.status === 'active' &&
    ((b.role !== undefined && b.role !== 'owner') || b.status === 'disabled');
  if (losesOwner && (await countActiveOwners(db)) <= 1) {
    throw ApiError.conflict('This is the last active owner. Add another owner first.');
  }

  const updated = (await updateUser(db, target.id, b))!;
  if (b.status === 'disabled') await revokeUserSessions(db, target.id);
  await audit(db, {
    action: 'user.updated', actor_user_id: auth.user?.id, actor: auth.user?.email ?? 'api-key',
    target: target.email, ip: clientIp(c), meta: b as Record<string, unknown>,
  });
  return c.json({ user: publicUser(updated) });
});

// ---------------------------------------------------------------------------
// GET /audit
// ---------------------------------------------------------------------------
authRoutes.get('/audit', authMiddleware, requirePermission('audit.read'), async (c) => {
  const limitN = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const before = c.req.query('before');
  const db = getDb(c.var.db);
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, at, actor_user_id, actor, action, target, ip, meta FROM audit_log
     ${before ? 'WHERE at < ?' : ''} ORDER BY at DESC LIMIT ?`,
    before ? [before, limitN] : [limitN]
  );
  return c.json({
    items: rows.map((r) => ({ ...r, meta: typeof r.meta === 'string' ? safeJson(r.meta) : null })),
  });
});

// ---------------------------------------------------------------------------
// API keys (users.manage; a signed-in person is required, an API key cannot mint keys)
// ---------------------------------------------------------------------------
function requirePerson(c: any) {
  const auth = c.get('auth');
  if (!auth.user) throw ApiError.forbidden('Sign in as a person to manage API keys');
  return auth.user as { id: string; email: string };
}

authRoutes.get('/keys', authMiddleware, requirePermission('users.manage'), async (c) => {
  requirePerson(c);
  return c.json({ items: await listKeys(getDb(c.var.db)) });
});

const CreateKeyBody = z.object({ role: z.enum(['public', 'admin']), label: z.string().max(80).optional() });

authRoutes.post('/keys', authMiddleware, requirePermission('users.manage'), async (c) => {
  const me = requirePerson(c);
  const b = parse(CreateKeyBody, await readJson(c));
  const db = getDb(c.var.db);
  const r = await createKey(db, { role: b.role as KeyRole, label: b.label, by: me.email });
  if ('error' in r) throw ApiError.conflict('Too many active keys. Revoke some first.');
  await audit(db, { action: 'key.created', actor_user_id: me.id, actor: me.email, target: r.key.id, ip: clientIp(c), meta: { role: b.role, label: r.key.label } });
  return c.json({ key: r.key, secret: r.secret }, 201);
});

const RotateBody = z.object({ grace_hours: z.number().int().min(0).max(MAX_GRACE_HOURS).default(0) });

authRoutes.post('/keys/:id/rotate', authMiddleware, requirePermission('users.manage'), async (c) => {
  const me = requirePerson(c);
  const b = parse(RotateBody, await readJson(c));
  const db = getDb(c.var.db);
  const r = await rotateKey(db, c.req.param('id'), { graceHours: b.grace_hours, by: me.email });
  if ('error' in r) {
    if (r.error === 'not_found') throw ApiError.notFound('Key not found');
    if (r.error === 'too_many') throw ApiError.conflict('Too many active keys. Revoke some first.');
    throw ApiError.conflict('Only an active key can be rotated');
  }
  await audit(db, { action: 'key.rotated', actor_user_id: me.id, actor: me.email, target: c.req.param('id'), ip: clientIp(c), meta: { new_key: r.key.id, grace_hours: b.grace_hours } });
  return c.json({ key: r.key, secret: r.secret, old: r.old });
});

authRoutes.delete('/keys/:id', authMiddleware, requirePermission('users.manage'), async (c) => {
  const me = requirePerson(c);
  const db = getDb(c.var.db);
  const k = await revokeKey(db, c.req.param('id'));
  if (!k) throw ApiError.notFound('Key not found');
  await audit(db, { action: 'key.revoked', actor_user_id: me.id, actor: me.email, target: k.id, ip: clientIp(c), meta: { role: k.role, label: k.label } });
  return c.json({ key: k });
});

// ---------------------------------------------------------------------------
// Setup status + sealing provider keys
// ---------------------------------------------------------------------------
const SECRET_ROWS = ['stripe', 'fedapay', 'email'] as const;

authRoutes.get('/setup-status', authMiddleware, requirePermission('settings.manage'), async (c) => {
  const db = getDb(c.var.db);
  const rows = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM config WHERE key IN ('stripe','fedapay','email')`
  );
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  let emailProvider: string | null = null;
  const emailRaw = byKey.get('email');
  if (emailRaw) { try { emailProvider = (await parseConfig<{ provider?: string }>('email', emailRaw)).provider ?? null; } catch { /* unreadable */ } }
  const keys = await listKeys(db);
  const live = keys.filter((k) => k.status === 'active' || k.status === 'expiring');
  const [{ n: owners }] = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role IN ('owner','agency') AND status = 'active'`);
  const origins = (c.env.ADMIN_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return c.json({
    owner_exists: owners > 0,
    email: { configured: byKey.has('email'), provider: emailProvider },
    stripe: { configured: byKey.has('stripe') || !!c.env.STRIPE_SECRET_KEY },
    fedapay: { configured: byKey.has('fedapay') },
    environment: {
      setup_token: !!c.env.SETUP_TOKEN,
      password_pepper: !!c.env.PASSWORD_PEPPER,
      admin_origins: origins.length > 0,
      admin_url: !!c.env.ADMIN_URL || origins.length > 0,
      cookie_ready: origins.some((o) => o.startsWith('https://')),
    },
    encryption: {
      enabled: configEncryptionEnabled(),
      plain_rows: SECRET_ROWS.filter((n) => byKey.has(n) && !isSealed(byKey.get(n)!)),
    },
    keys: {
      admin: live.filter((k) => k.role === 'admin').length,
      public: live.filter((k) => k.role === 'public').length,
      legacy: live.filter((k) => !k.created_by).length,
    },
  });
});

authRoutes.post('/secrets/seal', authMiddleware, requirePermission('users.manage'), async (c) => {
  const me = requirePerson(c);
  if (!configEncryptionEnabled()) throw ApiError.conflict('CONFIG_ENCRYPTION_KEY is not set. Set it with `wrangler secret put CONFIG_ENCRYPTION_KEY` first.');
  const db = getDb(c.var.db);
  const sealed: string[] = [];
  for (const name of SECRET_ROWS) {
    const [row] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = ?`, [name]);
    if (!row || isSealed(row.value)) continue;
    await db.run(`UPDATE config SET value = ? WHERE key = ?`, [await sealConfig(name, row.value), name]);
    sealed.push(name);
  }
  await audit(db, { action: 'secrets.sealed', actor_user_id: me.id, actor: me.email, ip: clientIp(c), meta: { rows: sealed } });
  return c.json({ sealed });
});

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// Used by tests and the admin to know the limits without importing internals.
export const AUTH_LIMITS = { codeMaxAttempts: CODE_MAX_ATTEMPTS, linkTtlMinutes: LOGIN_TOKEN_TTL_MIN, superRoles: ['owner', 'agency'] as const };
void isSuperRole;
