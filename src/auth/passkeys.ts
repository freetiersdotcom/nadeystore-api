import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Database } from '../db';
import { uuid } from '../types';
import { isAllowedOrigin } from './http';
import { isStoreOrigin } from '../account/http';

// =============================================================================
// Passkeys (WebAuthn), shared by the admin and the storefront customers.
//
// A passkey is a key pair kept by the person's device (Face ID, fingerprint, Windows Hello,
// a phone, a security key). The server stores only the PUBLIC key, so there is nothing
// to steal from the database and nothing to phish: the browser signs a challenge that is
// bound to the site's address.
//
// - "realm" keeps the two populations apart: an admin passkey can only open an admin
//   session, a customer passkey only a customer session.
// - Challenges are random, single use, kept 5 minutes, and remember the origin they were
//   issued for. Registration and sign-in both require the device's user verification
//   (PIN / biometric), and passkeys are "discoverable" so no email is needed to sign in.
// - Email sign-in stays available: losing a device never locks anyone out.
// =============================================================================

export type Realm = 'admin' | 'customer';

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const MAX_PASSKEYS_PER_SUBJECT = 10;

type EnvLike = {
  ADMIN_ORIGINS?: string; ADMIN_URL?: string;
  STORE_ORIGINS?: string; STORE_URL?: string;
  PASSKEY_RP_ID?: string;
};

export type PublicPasskey = {
  id: string; name: string | null; created_at: string; last_used_at: string | null;
  device_type: string | null; backed_up: boolean; transports: string[];
};

const iso = (ms: number) => new Date(ms).toISOString();

export class PasskeyError extends Error {
  constructor(message: string, public status: 400 | 401 | 404 | 409 = 400) { super(message); }
}

/**
 * The relying party for a request: the origin must be one of the realm's own origins,
 * and the RP ID is PASSKEY_RP_ID (recommended: the registrable domain, e.g. santenatur.com,
 * so www / admin / api hosts share the same passkeys) or else the origin's own host.
 */
export function resolveRp(env: EnvLike, realm: Realm, origin: string | undefined | null): { origin: string; rpID: string } {
  const ok = realm === 'admin' ? isAllowedOrigin(env, origin) : isStoreOrigin(env, origin);
  if (!origin || !ok) throw new PasskeyError('Passkeys are not available from this origin.', 400);
  const host = new URL(origin).hostname;
  const configured = (env.PASSKEY_RP_ID ?? '').trim().toLowerCase();
  if (!configured) return { origin: new URL(origin).origin, rpID: host };
  if (host !== configured && !host.endsWith('.' + configured)) {
    throw new PasskeyError('PASSKEY_RP_ID does not match this site\'s domain.', 400);
  }
  return { origin: new URL(origin).origin, rpID: configured };
}

// base64url <-> bytes (the database keeps text)
export const b64u = {
  enc(bytes: Uint8Array): string {
    let s = ''; for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(text: string): Uint8Array<ArrayBuffer> {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    const out = new Uint8Array(new ArrayBuffer(s.length));
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

type CredRow = {
  id: string; realm: Realm; subject_id: string; public_key: string; counter: number; transports: string | null;
  device_type: string | null; backed_up: number; name: string | null; created_at: string; last_used_at: string | null;
};

const toPublic = (r: CredRow): PublicPasskey => ({
  id: r.id, name: r.name, created_at: r.created_at, last_used_at: r.last_used_at,
  device_type: r.device_type, backed_up: !!r.backed_up,
  transports: (() => { try { return JSON.parse(r.transports ?? '[]'); } catch { return []; } })(),
});

export async function listPasskeys(db: Database, realm: Realm, subjectId: string): Promise<PublicPasskey[]> {
  const rows = await db.query<CredRow>(
    `SELECT * FROM passkey_credentials WHERE realm = ? AND subject_id = ? ORDER BY created_at`, [realm, subjectId]);
  return rows.map(toPublic);
}

export async function deletePasskey(db: Database, realm: Realm, subjectId: string, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `DELETE FROM passkey_credentials WHERE id = ? AND realm = ? AND subject_id = ? RETURNING id`, [id, realm, subjectId]);
  return rows.length > 0;
}

export async function deleteAllPasskeys(db: Database, realm: Realm, subjectId: string): Promise<void> {
  await db.run(`DELETE FROM passkey_credentials WHERE realm = ? AND subject_id = ?`, [realm, subjectId]);
}

async function storeChallenge(
  db: Database, realm: Realm, purpose: 'register' | 'login', subjectId: string | null,
  challenge: string, rp: { origin: string; rpID: string }
): Promise<string> {
  const id = uuid();
  const now = Date.now();
  await db.run(
    `INSERT INTO webauthn_challenges (id, realm, purpose, subject_id, challenge, rp_id, origin, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, realm, purpose, subjectId, challenge, rp.rpID, rp.origin, iso(now + CHALLENGE_TTL_MS), iso(now)]
  );
  return id;
}

/** Single use: the row is deleted as it is read, so a response can never be replayed. */
async function takeChallenge(
  db: Database, id: string, realm: Realm, purpose: 'register' | 'login', subjectId: string | null, origin: string
) {
  const [row] = await db.query<{ challenge: string; rp_id: string; origin: string; subject_id: string | null; expires_at: string }>(
    `DELETE FROM webauthn_challenges WHERE id = ? AND realm = ? AND purpose = ? RETURNING challenge, rp_id, origin, subject_id, expires_at`,
    [id, realm, purpose]
  );
  if (!row || row.expires_at < iso(Date.now()) || row.origin !== origin || row.subject_id !== subjectId) {
    throw new PasskeyError('This request expired. Please try again.', 400);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Registration (signed in)
// ---------------------------------------------------------------------------
export async function beginRegistration(
  db: Database, env: EnvLike, realm: Realm, origin: string | undefined,
  subject: { id: string; email: string; name: string | null }, rpName: string
) {
  const rp = resolveRp(env, realm, origin);
  const existing = await db.query<CredRow>(`SELECT id, transports FROM passkey_credentials WHERE realm = ? AND subject_id = ?`, [realm, subject.id]);
  if (existing.length >= MAX_PASSKEYS_PER_SUBJECT) throw new PasskeyError(`You can keep up to ${MAX_PASSKEYS_PER_SUBJECT} passkeys. Remove one first.`, 409);
  const options = await generateRegistrationOptions({
    rpName, rpID: rp.rpID,
    userName: subject.email, userDisplayName: subject.name || subject.email,
    userID: new TextEncoder().encode(`${realm}:${subject.id}`),
    attestationType: 'none',
    excludeCredentials: existing.map((e) => ({ id: e.id, transports: safeTransports(e.transports) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    timeout: 120_000,
  });
  const challenge_id = await storeChallenge(db, realm, 'register', subject.id, options.challenge, rp);
  return { challenge_id, options };
}

export async function finishRegistration(
  db: Database, env: EnvLike, realm: Realm, origin: string | undefined, subjectId: string,
  challengeId: string, response: RegistrationResponseJSON, name: string | null
): Promise<PublicPasskey> {
  const rp = resolveRp(env, realm, origin);
  const ch = await takeChallenge(db, challengeId, realm, 'register', subjectId, rp.origin);
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response, expectedChallenge: ch.challenge, expectedOrigin: ch.origin, expectedRPID: ch.rp_id, requireUserVerification: true,
    });
  } catch {
    throw new PasskeyError('This passkey could not be verified.', 400);
  }
  if (!verified.verified || !verified.registrationInfo) throw new PasskeyError('This passkey could not be verified.', 400);
  const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo;

  const [dup] = await db.query<{ id: string }>(`SELECT id FROM passkey_credentials WHERE id = ?`, [credential.id]);
  if (dup) throw new PasskeyError('This passkey is already registered.', 409);
  const now = iso(Date.now());
  await db.run(
    `INSERT INTO passkey_credentials (id, realm, subject_id, public_key, counter, transports, device_type, backed_up, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [credential.id, realm, subjectId, b64u.enc(credential.publicKey), credential.counter,
      JSON.stringify(response.response.transports ?? []), credentialDeviceType, credentialBackedUp ? 1 : 0,
      (name ?? '').trim().slice(0, 60) || null, now]
  );
  const [row] = await db.query<CredRow>(`SELECT * FROM passkey_credentials WHERE id = ?`, [credential.id]);
  return toPublic(row);
}

// ---------------------------------------------------------------------------
// Sign in (no account needed up front: the passkey says who it belongs to)
// ---------------------------------------------------------------------------
export async function beginLogin(db: Database, env: EnvLike, realm: Realm, origin: string | undefined) {
  const rp = resolveRp(env, realm, origin);
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', timeout: 120_000 });
  const challenge_id = await storeChallenge(db, realm, 'login', null, options.challenge, rp);
  return { challenge_id, options };
}

/** Returns the subject the passkey belongs to, or null when anything does not check out. */
export async function finishLogin(
  db: Database, env: EnvLike, realm: Realm, origin: string | undefined,
  challengeId: string, response: AuthenticationResponseJSON
): Promise<{ subject_id: string; credential_id: string } | null> {
  const rp = resolveRp(env, realm, origin);
  let ch;
  try { ch = await takeChallenge(db, challengeId, realm, 'login', null, rp.origin); } catch { return null; }
  const [cred] = await db.query<CredRow>(`SELECT * FROM passkey_credentials WHERE id = ? AND realm = ?`, [response?.id ?? '', realm]);
  if (!cred) return null;
  try {
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: ch.challenge, expectedOrigin: ch.origin, expectedRPID: ch.rp_id,
      credential: { id: cred.id, publicKey: b64u.dec(cred.public_key), counter: cred.counter, transports: safeTransports(cred.transports) },
      requireUserVerification: true,
    });
    if (!v.verified) return null;
    await db.run(
      `UPDATE passkey_credentials SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?`,
      [v.authenticationInfo.newCounter, v.authenticationInfo.credentialBackedUp ? 1 : 0, iso(Date.now()), cred.id]
    );
    return { subject_id: cred.subject_id, credential_id: cred.id };
  } catch {
    return null;
  }
}

function safeTransports(t: string | null): any[] | undefined {
  try { const a = JSON.parse(t ?? '[]'); return Array.isArray(a) && a.length ? a : undefined; } catch { return undefined; }
}

export async function purgePasskeyData(db: Database): Promise<void> {
  await db.run(`DELETE FROM webauthn_challenges WHERE expires_at < ?`, [iso(Date.now() - 60_000)]);
}
