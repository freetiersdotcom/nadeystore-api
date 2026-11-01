import { Hono } from 'hono';
import { z } from '@hono/zod-openapi';
import { getDb, type Database } from '../db';
import { ApiError, isValidEmail, type HonoEnv } from '../types';
import { sha256Hex } from '../auth/crypto';
import { clientIp } from '../auth/http';
import { audit, throttle } from '../auth/service';
import { normCustomerEmail, publicCustomer, type CustomerSession } from '../account/service';
import { clearCustomerCookie } from '../account/http';
import { customerAuth } from './account';
import {
  CODE_TTL_MIN, applyEmailChange, buildExport, consumeCode, eraseCustomer, emailTaken, erasureMode, issueCode, openOrderCount,
} from '../account/privacy';
import { sendPrivacyEmail } from '../account/privacy-email';

// =============================================================================
// /v1/account/privacy: a customer's control over their own data (signed in as a customer)
//
//   POST /email/request   { new_email }        sends a code to the NEW address
//   POST /email/confirm   { code }             moves the account to it
//   GET  /export                                everything held about me, as JSON
//   POST /delete/request                        sends a code to my current address
//   POST /delete/confirm  { code }             erases the account
//
// Changing the address or erasing the account needs a code from the mailbox, on top of the
// session, so a stolen session alone cannot take the account over or wipe it.
// =============================================================================

type AcctEnv = { Bindings: HonoEnv['Bindings']; Variables: HonoEnv['Variables'] & { acct: CustomerSession } };
export const privacyRoutes = new Hono<AcctEnv>();

privacyRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

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
const storeName = (c: any) => (c.env.STORE_NAME as string | undefined) ?? 'Your Store';
const lang = (l: string | null | undefined): 'fr' | 'en' => (l === 'en' ? 'en' : 'fr');
function background(c: any, job: Promise<unknown>) {
  try { c.executionCtx.waitUntil(job); } catch { /* tests: the promise just runs */ }
}

const CodeBody = z.object({ code: z.string().trim().max(12) });
const EmailBody = z.object({ new_email: z.string().trim().max(254).refine(isValidEmail, 'Invalid email address') });

// ---------------------------------------------------------------------------
// Change the email
// ---------------------------------------------------------------------------
privacyRoutes.post('/email/request', customerAuth, async (c) => {
  const b = parse(EmailBody, await readJson(c));
  const a = c.get('acct');
  const db = getDb(c.var.db);
  await limit(c, db, `acct-email-req:${a.customer.id}`, 5, 3600);
  await limit(c, db, `acct-email-req-ip:${clientIp(c)}`, 20, 3600);
  const target = normCustomerEmail(b.new_email);
  if (target === a.customer.email.toLowerCase()) throw ApiError.invalidRequest('That is already your email address.');
  const locale = lang(a.customer.locale);
  const reply = { ok: true as const, expires_in: CODE_TTL_MIN * 60 };

  if (await emailTaken(db, target, a.customer.id)) {
    // Same answer as success: nothing reveals that the address already has an account.
    // The owner of that address is told, at most 3 times a day, so this cannot be used to spam them.
    const r = await throttle(db, `acct-taken:${(await sha256Hex(target)).slice(0, 32)}`, 3, 86_400);
    if (r.allowed) background(c, sendPrivacyEmail(db, { kind: 'address-taken', to: target }, storeName(c), locale, CODE_TTL_MIN));
    return c.json(reply);
  }
  const { code } = await issueCode(db, a.customer.id, 'email_change', c.env.PASSWORD_PEPPER, target);
  background(c, sendPrivacyEmail(db, { kind: 'change-code', to: target, code }, storeName(c), locale, CODE_TTL_MIN));
  return c.json(reply);
});

privacyRoutes.post('/email/confirm', customerAuth, async (c) => {
  const b = parse(CodeBody, await readJson(c));
  const a = c.get('acct');
  const db = getDb(c.var.db);
  await limit(c, db, `acct-email-conf:${a.customer.id}`, 10, 900);
  const proven = await consumeCode(db, a.customer.id, 'email_change', b.code, c.env.PASSWORD_PEPPER);
  if (!proven?.new_email) throw ApiError.invalidRequest('This code is wrong or has expired. Request a new one.');
  const r = await applyEmailChange(db, a.customer.id, proven.new_email, a.session_id);
  if (!r.ok) throw ApiError.conflict('This email address cannot be used.');
  await audit(db, { action: 'account.email_changed', target: a.customer.id, ip: clientIp(c) });
  background(c, sendPrivacyEmail(db, { kind: 'email-changed', to: r.old_email, newEmail: r.customer.email }, storeName(c), lang(r.customer.locale), CODE_TTL_MIN));
  return c.json({ ok: true, customer: publicCustomer(r.customer) });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
privacyRoutes.get('/export', customerAuth, async (c) => {
  const a = c.get('acct');
  const db = getDb(c.var.db);
  await limit(c, db, `acct-export:${a.customer.id}`, 5, 86_400);
  const data = await buildExport(db, a.customer);
  c.header('Content-Disposition', 'attachment; filename="my-data.json"');
  return c.json(data);
});

// ---------------------------------------------------------------------------
// Erase
// ---------------------------------------------------------------------------
privacyRoutes.post('/delete/request', customerAuth, async (c) => {
  const a = c.get('acct');
  const db = getDb(c.var.db);
  await limit(c, db, `acct-del-req:${a.customer.id}`, 5, 3600);
  await limit(c, db, `acct-del-req-ip:${clientIp(c)}`, 20, 3600);
  const open = await openOrderCount(db, a.customer, erasureMode(c.env.ERASURE_ORDER_PII));
  if (open > 0) throw new ApiError('open_orders', 409, 'You have orders that are not finished yet. Please contact us once they are delivered.');
  const { code } = await issueCode(db, a.customer.id, 'delete', c.env.PASSWORD_PEPPER);
  background(c, sendPrivacyEmail(db, { kind: 'delete-code', to: a.customer.email, code }, storeName(c), lang(a.customer.locale), CODE_TTL_MIN));
  return c.json({ ok: true, expires_in: CODE_TTL_MIN * 60 });
});

privacyRoutes.post('/delete/confirm', customerAuth, async (c) => {
  const b = parse(CodeBody, await readJson(c));
  const a = c.get('acct');
  const db = getDb(c.var.db);
  await limit(c, db, `acct-del-conf:${a.customer.id}`, 10, 900);
  const mode = erasureMode(c.env.ERASURE_ORDER_PII);
  // Checked again here (an order may have been placed since), and before the code is spent.
  if ((await openOrderCount(db, a.customer, mode)) > 0) {
    throw new ApiError('open_orders', 409, 'You have orders that are not finished yet. Please contact us once they are delivered.');
  }
  const proven = await consumeCode(db, a.customer.id, 'delete', b.code, c.env.PASSWORD_PEPPER);
  if (!proven) throw ApiError.invalidRequest('This code is wrong or has expired. Request a new one.');
  const email = a.customer.email;
  const locale = lang(a.customer.locale);
  await eraseCustomer(db, a.customer, mode);
  await audit(db, { action: 'account.erased', target: a.customer.id, ip: clientIp(c), meta: { mode } });
  background(c, sendPrivacyEmail(db, { kind: 'erased', to: email }, storeName(c), locale, CODE_TTL_MIN));
  clearCustomerCookie(c);
  return c.json({ ok: true });
});
