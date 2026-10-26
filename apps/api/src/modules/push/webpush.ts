import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';

// Web Push with node:crypto only:
// - RFC 8291 message encryption (ECDH P-256 + HKDF-SHA-256 + AES-128-GCM) in the RFC 8188
//   `aes128gcm` content coding, one record;
// - RFC 8292 VAPID: an ES256 JWT for the push service's origin, sent as
//   `Authorization: vapid t=<jwt>, k=<public key>`.

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/=+$/, ''), 'base64url');
}

export interface VapidKeys {
  /** Uncompressed P-256 point (65 bytes), base64url. */
  publicKey: string;
  /** Private scalar (32 bytes), base64url. */
  privateKey: string;
}

function pad32(buf: Buffer): Buffer {
  if (buf.length >= 32) return buf;
  return Buffer.concat([Buffer.alloc(32 - buf.length), buf]);
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(pad32(ecdh.getPrivateKey())) };
}

/** Size of the one record we send; plaintext + delimiter + 16-byte tag must fit. */
export const RECORD_SIZE = 4096;
/** Largest payload that fits one record (4096 - 16 tag - 1 delimiter). */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 17;

export class WebPushError extends Error {
  constructor(
    readonly code: 'PAYLOAD_TOO_LARGE' | 'BAD_SUBSCRIPTION',
    message: string,
  ) {
    super(message);
    this.name = 'WebPushError';
  }
}

export interface PushTarget {
  endpoint: string;
  /** Client public key (p256dh), base64url. */
  p256dh: string;
  /** Client auth secret, base64url. */
  auth: string;
}

export interface EncryptOptions {
  /** Test seam: fixed ephemeral private key (32 bytes). */
  asPrivateKey?: Buffer;
  /** Test seam: fixed 16-byte salt. */
  salt?: Buffer;
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/** RFC 8291 section 3-4: the `aes128gcm` body for `plaintext` to one subscription. */
export function encryptPayload(plaintext: Uint8Array, target: Pick<PushTarget, 'p256dh' | 'auth'>, opts: EncryptOptions = {}): Buffer {
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new WebPushError('PAYLOAD_TOO_LARGE', `push payload is ${plaintext.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  const uaPublic = fromB64url(target.p256dh);
  const authSecret = fromB64url(target.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new WebPushError('BAD_SUBSCRIPTION', 'p256dh is not an uncompressed P-256 point');
  if (authSecret.length < 16) throw new WebPushError('BAD_SUBSCRIPTION', 'auth secret is shorter than 16 bytes');

  const ecdh = createECDH('prime256v1');
  if (opts.asPrivateKey) ecdh.setPrivateKey(opts.asPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  let ecdhSecret: Buffer;
  try {
    ecdhSecret = ecdh.computeSecret(uaPublic);
  } catch {
    throw new WebPushError('BAD_SUBSCRIPTION', 'p256dh is not a valid P-256 public key');
  }

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = opts.salt ?? randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);

  // One (last) record: plaintext || 0x02, no extra padding.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** RFC 8292: the ES256 JWT for `audience` (the push service origin). */
export function vapidJwt(keys: VapidKeys, audience: string, subject: string, expiresAt: number): string {
  const pub = fromB64url(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), d: keys.privateKey },
    format: 'jwk',
  });
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: expiresAt, sub: subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64url(signature)}`;
}

export interface SendOptions {
  vapid: VapidKeys;
  /** `mailto:` or `https:` contact for the push service operator. */
  subject: string;
  fetchImpl?: typeof fetch;
  /** Seconds the push service keeps an undelivered message. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  now?: () => Date;
  encrypt?: EncryptOptions;
  timeoutMs?: number;
}

export interface SendResult {
  status: number;
  ok: boolean;
  /** 404/410: the subscription is gone and should be deleted. */
  gone: boolean;
  message?: string;
}

/** Encrypt `payload` and POST it to the subscription's push service. */
export async function sendWebPush(target: PushTarget, payload: string, opts: SendOptions): Promise<SendResult> {
  const body = encryptPayload(Buffer.from(payload, 'utf8'), target, opts.encrypt);
  const url = new URL(target.endpoint);
  const now = opts.now?.() ?? new Date();
  const jwt = vapidJwt(opts.vapid, url.origin, opts.subject, Math.floor(now.getTime() / 1000) + 12 * 3600);
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(target.endpoint, {
      method: 'POST',
      headers: {
        authorization: `vapid t=${jwt}, k=${opts.vapid.publicKey}`,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(opts.ttl ?? 86_400),
        urgency: opts.urgency ?? 'normal',
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    return { status: 0, ok: false, gone: false, message: err instanceof Error ? err.message : String(err) };
  }
  const ok = res.status >= 200 && res.status < 300;
  const gone = res.status === 404 || res.status === 410;
  const text = ok ? '' : await res.text().catch(() => '');
  return { status: res.status, ok, gone, ...(text ? { message: text.slice(0, 300) } : {}) };
}
