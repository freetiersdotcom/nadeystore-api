import { b64urlDecode, b64urlEncode } from '../auth/crypto';

// =============================================================================
// Encryption of provider credentials stored in the `config` table
// (Stripe, FedaPay, email provider keys).
//
// With a CONFIG_ENCRYPTION_KEY secret set, those rows are stored as
//   enc:v1:<iv>:<ciphertext>      (AES-256-GCM, key derived with HKDF)
// and the row name is bound into the ciphertext, so a value cannot be moved
// to another row. Without the secret nothing changes (plain JSON, as before).
// Rows already stored in plain JSON keep working and are sealed the next time
// they are saved, or all at once from the admin.
//
// What it protects against: leaked database exports, backups and dumps.
// What it does not: someone who holds both the database and the secret.
// Losing the secret means re-entering the provider keys (nothing else is lost).
// =============================================================================

const PREFIX = 'enc:v1:';
const enc = new TextEncoder();
const dec = new TextDecoder();

let secret: string | null = null;
let cached: { secret: string; key: CryptoKey } | null = null;

/** Called once per request / scheduled run with env.CONFIG_ENCRYPTION_KEY. */
export function setConfigKey(value: string | undefined | null): void {
  secret = value && value.length > 0 ? value : null;
}

export function configEncryptionEnabled(): boolean {
  return secret !== null;
}

export function isSealed(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

async function getKey(): Promise<CryptoKey> {
  if (!secret) throw new Error('CONFIG_ENCRYPTION_KEY is not set');
  if (cached && cached.secret === secret) return cached.key;
  const base = await crypto.subtle.importKey('raw', enc.encode(secret) as BufferSource, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('merchant-config') as BufferSource, info: enc.encode('config-v1') as BufferSource },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  cached = { secret, key };
  return key;
}

/** Encrypt `json` for storage under row `name` (returned unchanged when no key is configured). */
export async function sealConfig(name: string, json: string): Promise<string> {
  if (!secret) return json;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(name) as BufferSource },
      await getKey(),
      enc.encode(json) as BufferSource
    )
  );
  return `${PREFIX}${b64urlEncode(iv)}:${b64urlEncode(ct)}`;
}

/** Plain JSON text for row `name`, decrypting when needed. Throws if it cannot be decrypted. */
export async function openConfig(name: string, stored: string): Promise<string> {
  if (!isSealed(stored)) return stored;
  if (!secret) throw new Error(`Config "${name}" is encrypted but CONFIG_ENCRYPTION_KEY is not set`);
  const [ivPart, ctPart] = stored.slice(PREFIX.length).split(':');
  if (!ivPart || !ctPart) throw new Error(`Config "${name}" is malformed`);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(ivPart) as BufferSource, additionalData: enc.encode(name) as BufferSource },
      await getKey(),
      b64urlDecode(ctPart) as BufferSource
    );
    return dec.decode(pt);
  } catch {
    throw new Error(`Config "${name}" could not be decrypted (wrong CONFIG_ENCRYPTION_KEY?)`);
  }
}

export async function parseConfig<T = any>(name: string, stored: string): Promise<T> {
  return JSON.parse(await openConfig(name, stored)) as T;
}
