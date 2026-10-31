// A software passkey for tests: it behaves like a phone or laptop authenticator would
// (ES256 key pair, "none" attestation), so the server's real verification runs end to end.
import { b64u } from '../auth/passkeys';

const enc = new TextEncoder();
const sha256 = async (d: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', d as BufferSource));
const concat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

// Minimal CBOR: unsigned/negative ints, byte strings, text strings, maps.
function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
}
type Cbor = number | Uint8Array | string | Array<[Cbor, Cbor]>;
function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = enc.encode(v); return concat(head(3, b.length), b); }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  return concat(head(5, v.length), ...v.flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

/** WebCrypto signs ES256 as r||s; WebAuthn wants ASN.1 DER. */
function derFromRaw(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0; while (i < b.length - 1 && b[i] === 0) i++;
    let x = b.slice(i); if (x[0] & 0x80) x = concat(Uint8Array.of(0), x);
    return concat(Uint8Array.of(0x02, x.length), x);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

export type Opts = {
  origin?: string; rpId?: string; counter?: number; uv?: boolean; up?: boolean;
  type?: string; challenge?: string; tamper?: boolean; key?: CryptoKeyPair; backedUp?: boolean;
};

export class SoftPasskey {
  credId = crypto.getRandomValues(new Uint8Array(32));
  counter = 0;
  keys!: CryptoKeyPair;
  constructor(public origin: string, public rpId: string) {}
  static async create(origin: string, rpId: string) {
    const p = new SoftPasskey(origin, rpId);
    p.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    return p;
  }
  get id() { return b64u.enc(this.credId); }

  private flags(o: Opts, attested: boolean) {
    return (o.up === false ? 0 : 0x01) | (o.uv === false ? 0 : 0x04) | (attested ? 0x40 : 0) | (o.backedUp ? 0x18 : 0);
  }
  private counterBytes(n: number) { return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); }
  private async clientData(type: string, challenge: string, origin: string) {
    return enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** Answer navigator.credentials.create(options). */
  async create(options: { challenge: string }, o: Opts = {}) {
    const rpHash = await sha256(enc.encode(o.rpId ?? this.rpId));
    const jwk = await crypto.subtle.exportKey('jwk', (o.key ?? this.keys).publicKey);
    const cose = cbor([[1, 2], [3, -7], [-1, 1], [-2, b64u.dec(jwk.x!)], [-3, b64u.dec(jwk.y!)]]);
    const authData = concat(rpHash, Uint8Array.of(this.flags(o, true)), this.counterBytes(o.counter ?? 0), new Uint8Array(16),
      Uint8Array.of(this.credId.length >> 8, this.credId.length & 255), this.credId, cose);
    const attestationObject = cbor([['fmt', 'none'], ['attStmt', []], ['authData', authData]]);
    const clientDataJSON = await this.clientData(o.type ?? 'webauthn.create', o.challenge ?? options.challenge, o.origin ?? this.origin);
    return {
      id: this.id, rawId: this.id, type: 'public-key' as const,
      response: { clientDataJSON: b64u.enc(clientDataJSON), attestationObject: b64u.enc(attestationObject), transports: ['internal'] },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    };
  }

  /** Answer navigator.credentials.get(options). */
  async get(options: { challenge: string }, o: Opts = {}) {
    this.counter = o.counter ?? this.counter + 1;
    const rpHash = await sha256(enc.encode(o.rpId ?? this.rpId));
    const authData = concat(rpHash, Uint8Array.of(this.flags(o, false)), this.counterBytes(this.counter));
    const clientDataJSON = await this.clientData(o.type ?? 'webauthn.get', o.challenge ?? options.challenge, o.origin ?? this.origin);
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (o.key ?? this.keys).privateKey, signed as BufferSource));
    let sig = derFromRaw(raw);
    if (o.tamper) sig = sig.map((b, i) => (i === sig.length - 3 ? b ^ 1 : b));
    return {
      id: this.id, rawId: this.id, type: 'public-key' as const,
      response: { clientDataJSON: b64u.enc(clientDataJSON), authenticatorData: b64u.enc(authData), signature: b64u.enc(sig), userHandle: b64u.enc(enc.encode('x')) },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    };
  }
}
