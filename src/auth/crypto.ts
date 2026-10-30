// ============================================================
// AUTH CRYPTO PRIMITIVES
// ============================================================
// Thin helpers over WebCrypto. Nothing here invents cryptography:
// random bytes, SHA-256, HMAC-SHA-256 and a constant-time compare.

const enc = new TextEncoder();

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function b64urlEncode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** URL-safe random token with `bytes` bytes of entropy (default 256 bits). */
export function randomToken(bytes = 32): string {
  return b64urlEncode(randomBytes(bytes));
}

/** Uniform random numeric code (rejection sampling, no modulo bias). */
export function randomCode(digits = 6): string {
  const max = 10 ** digits;
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % max).padStart(digits, '0');
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256(key: Uint8Array | string, message: string): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? enc.encode(key) : key;
  // WebCrypto rejects zero-length HMAC keys, so an empty key becomes one zero byte.
  const k = await crypto.subtle.importKey(
    'raw',
    (keyBytes.length ? keyBytes : new Uint8Array(1)) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

/** Constant-time equality for two byte arrays or two strings of any length. */
export function timingSafeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const x = typeof a === 'string' ? enc.encode(a) : a;
  const y = typeof b === 'string' ? enc.encode(b) : b;
  // Always walk the longer length so a length mismatch does not return early.
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
