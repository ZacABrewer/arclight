import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// Test-only: a software WebAuthn authenticator (ES256, "none" attestation) so passkey
// registration and sign-in run through @simplewebauthn/server's real verification.

type Cbor = number | string | Buffer | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const s = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const b64 = (b: Buffer) => b.toString('base64url');

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  private counter = 0;

  constructor(private readonly userHandle?: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }

  get id(): string {
    return b64(this.credentialId);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
  }

  /** navigator.credentials.create() for these options. */
  register(options: { challenge: string; rp: { id?: string } }, origin: string): Record<string, unknown> {
    const rpId = options.rp.id ?? new URL(origin).hostname;
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(this.publicJwk.x, 'base64url')],
      [-3, Buffer.from(this.publicJwk.y, 'base64url')],
    ]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const count = Buffer.alloc(4);
    const authData = Buffer.concat([
      createHash('sha256').update(rpId).digest(),
      Buffer.from([0x01 | 0x04 | 0x40]),
      count,
      Buffer.alloc(16),
      idLen,
      this.credentialId,
      cbor(coseKey),
    ]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64(this.clientData('webauthn.create', options.challenge, origin)),
        attestationObject: b64(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() for these options. */
  assert(options: { challenge: string; rpId?: string }, origin: string, tweak: { counter?: number } = {}): Record<string, unknown> {
    const rpId = options.rpId ?? new URL(origin).hostname;
    this.counter = tweak.counter ?? this.counter + 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([0x01 | 0x04]), count]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, origin);
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authData),
        signature: b64(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      clientExtensionResults: {},
    };
  }
}
