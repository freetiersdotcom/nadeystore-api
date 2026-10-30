import { b64urlDecode, b64urlEncode, hmacSha256, randomBytes, timingSafeEqual } from './crypto';

// ============================================================
// PASSWORD HASHING
// ============================================================
//
// Every stored hash carries its own algorithm and parameters:
//
//   $pbkdf2-sha256$i=100000,pep=1$<salt>$<hash>
//   $scrypt$n=32768,r=8,p=3,pep=1$<salt>$<hash>
//
// so the policy can change at any time: verification reads the parameters from
// the record, and a successful login re-hashes under the current policy
// (see needsRehash). `pep=1` means the password was first run through
// HMAC-SHA-256 keyed with PASSWORD_PEPPER, a secret that lives in the Worker
// environment and never in the database, so a stolen database alone is not
// enough to start guessing.
//
// PBKDF2: native WebCrypto, fast, but workerd caps the iteration count at
// 100,000 (below the OWASP figure of 600,000 for PBKDF2-HMAC-SHA256). That cap
// applies to every plan. scrypt (pure JS, @noble/hashes) has no such cap and
// is what OWASP lists as the stronger option, but it needs far more CPU than
// the free plan's 10 ms per request allows, so it is meant for the paid plan.

export type KdfName = 'pbkdf2' | 'scrypt';

export type ScryptParams = { n: number; r: number; p: number };

export type PasswordPolicy = {
  kdf: KdfName;
  /** PBKDF2 iterations (ignored for scrypt). Capped at 100,000 by the runtime. */
  iterations: number;
  scrypt: ScryptParams;
};

export const PBKDF2_MAX_ITERATIONS = 100_000;
export const PBKDF2_MIN_ITERATIONS = 10_000;

export const DEFAULT_POLICY: PasswordPolicy = {
  kdf: 'pbkdf2',
  iterations: 100_000,
  // OWASP-listed scrypt configuration: N=2^15 (32 MiB), r=8, p=3.
  scrypt: { n: 32768, r: 8, p: 3 },
};

export const PASSWORD_MIN_LENGTH = 10;
/** Bounds the work done before hashing so a huge body cannot burn CPU. */
export const PASSWORD_MAX_BYTES = 256;

const enc = new TextEncoder();

export function checkPasswordShape(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password is required';
  if ([...password].length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (enc.encode(password).length > PASSWORD_MAX_BYTES) return `Password is too long (max ${PASSWORD_MAX_BYTES} bytes)`;
  return null;
}

async function material(password: string, pepper: string | undefined): Promise<Uint8Array> {
  // NFKC so the same visible password always yields the same bytes.
  const normalized = password.normalize('NFKC');
  return pepper ? hmacSha256(pepper, normalized) : enc.encode(normalized);
}

async function pbkdf2(pw: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', pw as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function scryptDerive(pw: Uint8Array, salt: Uint8Array, p: ScryptParams): Promise<Uint8Array> {
  const { scryptAsync } = await import('@noble/hashes/scrypt.js');
  return scryptAsync(pw, salt, { N: p.n, r: p.r, p: p.p, dkLen: 32, maxmem: 256 * 1024 * 1024 });
}

export async function hashPassword(
  password: string,
  policy: PasswordPolicy = DEFAULT_POLICY,
  pepper?: string
): Promise<string> {
  const salt = randomBytes(16);
  const pw = await material(password, pepper);
  const pep = pepper ? 1 : 0;
  if (policy.kdf === 'scrypt') {
    const { n, r, p } = policy.scrypt;
    const out = await scryptDerive(pw, salt, { n, r, p });
    return `$scrypt$n=${n},r=${r},p=${p},pep=${pep}$${b64urlEncode(salt)}$${b64urlEncode(out)}`;
  }
  const iterations = Math.min(Math.max(policy.iterations, PBKDF2_MIN_ITERATIONS), PBKDF2_MAX_ITERATIONS);
  const out = await pbkdf2(pw, salt, iterations);
  return `$pbkdf2-sha256$i=${iterations},pep=${pep}$${b64urlEncode(salt)}$${b64urlEncode(out)}`;
}

type Parsed =
  | { kdf: 'pbkdf2'; iterations: number; pep: boolean; salt: Uint8Array; hash: Uint8Array }
  | { kdf: 'scrypt'; n: number; r: number; p: number; pep: boolean; salt: Uint8Array; hash: Uint8Array };

function parseParams(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kv of s.split(',')) {
    const [k, v] = kv.split('=');
    const num = Number(v);
    if (!k || !Number.isFinite(num)) throw new Error('bad params');
    out[k] = num;
  }
  return out;
}

export function parseHash(stored: string): Parsed | null {
  try {
    const parts = stored.split('$');
    // ['', alg, params, salt, hash]
    if (parts.length !== 5 || parts[0] !== '') return null;
    const [, alg, params, salt, hash] = parts;
    const prm = parseParams(params);
    if (alg === 'pbkdf2-sha256') {
      if (!prm.i || prm.i > PBKDF2_MAX_ITERATIONS) return null;
      return { kdf: 'pbkdf2', iterations: prm.i, pep: prm.pep === 1, salt: b64urlDecode(salt), hash: b64urlDecode(hash) };
    }
    if (alg === 'scrypt') {
      if (!prm.n || !prm.r || !prm.p) return null;
      return { kdf: 'scrypt', n: prm.n, r: prm.r, p: prm.p, pep: prm.pep === 1, salt: b64urlDecode(salt), hash: b64urlDecode(hash) };
    }
    return null;
  } catch {
    return null;
  }
}

/** True when `password` matches `stored`. Never throws on a malformed record. */
export async function verifyPassword(password: string, stored: string, pepper?: string): Promise<boolean> {
  const rec = parseHash(stored);
  if (!rec) return false;
  // A hash made with a pepper cannot be verified without it, and vice versa.
  if (rec.pep && !pepper) return false;
  const pw = await material(password, rec.pep ? pepper : undefined);
  const out =
    rec.kdf === 'pbkdf2'
      ? await pbkdf2(pw, rec.salt, rec.iterations)
      : await scryptDerive(pw, rec.salt, { n: rec.n, r: rec.r, p: rec.p });
  return timingSafeEqual(out, rec.hash);
}

/** True when the stored hash is weaker than (or different from) the current policy. */
export function needsRehash(stored: string, policy: PasswordPolicy, pepper?: string): boolean {
  const rec = parseHash(stored);
  if (!rec) return true;
  if (!!pepper !== rec.pep) return true;
  if (rec.kdf !== policy.kdf) return true;
  if (rec.kdf === 'pbkdf2') return rec.iterations !== Math.min(policy.iterations, PBKDF2_MAX_ITERATIONS);
  return rec.n !== policy.scrypt.n || rec.r !== policy.scrypt.r || rec.p !== policy.scrypt.p;
}
