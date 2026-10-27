/**
 * Message Stream Encryption / Protocol Encryption (MSE/PE), the obfuscation layer every
 * major client speaks. Outline of the exchange (A = initiator, B = receiver):
 *
 * 1. A→B  Ya, PadA
 * 2. B→A  Yb, PadB
 * 3. A→B  HASH('req1', S), HASH('req2', SKEY) xor HASH('req3', S),
 *         ENCRYPT(VC, crypto_provide, len(PadC), PadC, len(IA)), ENCRYPT(IA)
 * 4. B→A  ENCRYPT(VC, crypto_select, len(PadD), PadD), ENCRYPT2(payload)
 * 5. A→B  ENCRYPT2(payload)
 *
 * Y = 768-bit Diffie-Hellman public keys (generator 2, 160-bit private exponents), S = the
 * shared secret, SKEY = the info-hash, VC = 8 zero bytes, pads are 0-512 random bytes.
 * ENCRYPT is RC4 keyed with SHA1('keyA'|'keyB', S, SKEY) with the first 1024 bytes
 * discarded; crypto_select picks RC4 (0x02) or plaintext (0x01) for the payload.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Duplex } from 'node:stream';
import { TorrentEngineError } from '../errors.js';
import { RC4 } from './rc4.js';

/**
 * The 768-bit prime the MSE specification defines. It shares its leading digits with the first
 * Oakley group but is a different number (it ends ...A36210000000000090563); using the Oakley
 * prime gave every real client a different shared secret, so every encrypted handshake failed.
 */
export const MSE_PRIME = BigInt(
  '0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A63A36210000000000090563',
);
export const MSE_GENERATOR = 2n;
export const MSE_KEY_BYTES = 96;
const MAX_PAD = 512;
const VC = Buffer.alloc(8);
export const CRYPTO_PLAINTEXT = 0x01;
export const CRYPTO_RC4 = 0x02;

export type EncryptionMode = 'disabled' | 'preferred' | 'required';
export type CryptoMethod = 'plaintext' | 'rc4';

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function toBigInt(b: Buffer): bigint {
  return BigInt(`0x${b.toString('hex') || '0'}`);
}

function toFixedBuffer(n: bigint, bytes: number): Buffer {
  return Buffer.from(n.toString(16).padStart(bytes * 2, '0'), 'hex');
}

export interface DhKeyPair {
  privateKey: bigint;
  /** 96-byte big-endian public key. */
  publicKey: Buffer;
}

/** Generates a key pair with a 160-bit private exponent (or uses `privateKey` when given). */
export function dhKeyPair(privateKey?: bigint): DhKeyPair {
  const x = privateKey ?? (toBigInt(randomBytes(20)) | 1n);
  return { privateKey: x, publicKey: toFixedBuffer(modPow(MSE_GENERATOR, x, MSE_PRIME), MSE_KEY_BYTES) };
}

/** Computes the 96-byte shared secret. Rejects degenerate public keys. */
export function dhSecret(privateKey: bigint, remotePublic: Buffer): Buffer {
  if (remotePublic.length !== MSE_KEY_BYTES) throw new TorrentEngineError('peer', 'mse: bad public key length');
  const y = toBigInt(remotePublic);
  if (y <= 1n || y >= MSE_PRIME - 1n) throw new TorrentEngineError('peer', 'mse: invalid public key');
  return toFixedBuffer(modPow(y, privateKey, MSE_PRIME), MSE_KEY_BYTES);
}

function sha1(...parts: (string | Buffer)[]): Buffer {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest();
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) ^ (b[i] as number);
  return out;
}

/** HASH('req2', SKEY): what a receiver matches against its torrents' info-hashes. */
export function mseReq2(infoHash: Buffer): Buffer {
  return sha1('req2', infoHash);
}

function randomPad(max = MAX_PAD): Buffer {
  return randomBytes(randomInt(0, max + 1));
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

// ---- incremental reader over a socket during the handshake -----------------------------------

/** Buffers socket data during the handshake and lets the handshake await exact byte counts. */
class HandshakeReader {
  private buf: Buffer;
  private waiter: (() => void) | null = null;
  private failure: Error | null = null;
  private readonly onData = (d: Buffer): void => {
    this.buf = this.buf.length === 0 ? d : Buffer.concat([this.buf, d]);
    this.waiter?.();
  };
  private readonly onEnd = (): void => this.fail(new TorrentEngineError('peer', 'mse: connection closed during handshake'));
  private readonly onError = (err: Error): void => this.fail(new TorrentEngineError('peer', `mse: ${err.message}`, { cause: err }));

  constructor(
    private readonly sock: Duplex,
    initial: Buffer = Buffer.alloc(0),
  ) {
    this.buf = initial;
    sock.on('data', this.onData);
    sock.on('end', this.onEnd);
    sock.on('close', this.onEnd);
    sock.on('error', this.onError);
    sock.resume();
  }

  fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    this.waiter?.();
  }

  private until(ready: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        let ok = false;
        try {
          if (!this.failure) ok = ready();
        } catch (err) {
          this.failure = err instanceof Error ? err : new Error(String(err));
        }
        if (this.failure) {
          this.waiter = null;
          reject(this.failure);
        } else if (ok) {
          this.waiter = null;
          resolve();
        }
      };
      this.waiter = check;
      check();
    });
  }

  async read(n: number): Promise<Buffer> {
    await this.until(() => this.buf.length >= n);
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Discards bytes until `pattern` (consumed too). It must start within `maxSkip` bytes. */
  async sync(pattern: Buffer, maxSkip: number): Promise<void> {
    let found = -1;
    await this.until(() => {
      found = this.buf.indexOf(pattern);
      if (found >= 0 && found <= maxSkip) return true;
      if (this.buf.length >= maxSkip + pattern.length) throw new TorrentEngineError('peer', 'mse: synchronisation pattern not found');
      return false;
    });
    this.buf = this.buf.subarray(found + pattern.length);
  }

  /** Stops listening and returns unread bytes. The socket is left paused. */
  detach(): Buffer {
    this.sock.off('data', this.onData);
    this.sock.off('end', this.onEnd);
    this.sock.off('close', this.onEnd);
    this.sock.off('error', this.onError);
    this.sock.pause();
    return this.buf;
  }
}

// ---- encrypted stream wrapper ------------------------------------------------------------------

/**
 * Wraps a transport after the MSE handshake: decrypts incoming and encrypts outgoing bytes
 * with RC4 (or passes them through when plaintext was selected) and replays bytes that
 * arrived together with the handshake.
 */
export class CipherStream extends Duplex {
  constructor(
    readonly inner: Duplex,
    private readonly enc: RC4 | null,
    private readonly dec: RC4 | null,
    initial: Buffer,
  ) {
    super({ allowHalfOpen: false });
    if (initial.length > 0) this.push(initial);
    inner.on('data', (d: Buffer) => {
      if (!this.push(this.dec ? this.dec.update(d) : d)) inner.pause();
    });
    inner.on('end', () => this.push(null));
    inner.on('error', (err) => this.destroy(err));
    inner.on('close', () => this.destroy());
    inner.pause();
  }

  get remoteAddress(): string | undefined {
    return (this.inner as { remoteAddress?: string }).remoteAddress;
  }

  setNoDelay(noDelay = true): this {
    (this.inner as { setNoDelay?: (v: boolean) => unknown }).setNoDelay?.(noDelay);
    return this;
  }

  override _read(): void {
    this.inner.resume();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.inner.destroyed) {
      cb(new TorrentEngineError('peer', 'connection closed'));
      return;
    }
    this.inner.write(this.enc ? this.enc.update(chunk) : chunk, cb);
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.inner.end();
    cb();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.inner.destroy();
    cb(err);
  }
}

// ---- handshake ---------------------------------------------------------------------------------

export interface MseResult {
  stream: Duplex;
  method: CryptoMethod;
}

export interface MseInitiateOptions {
  infoHash: Buffer;
  /** Offer plaintext as well as RC4 (encryption `preferred`). */
  allowPlaintext: boolean;
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, reader: HandshakeReader): Promise<T> {
  const timer = setTimeout(() => reader.fail(new TorrentEngineError('timeout', 'mse: handshake timed out')), ms);
  timer.unref();
  return p.finally(() => clearTimeout(timer));
}

function keys(secret: Buffer, infoHash: Buffer): { a: Buffer; b: Buffer } {
  return { a: sha1('keyA', secret, infoHash), b: sha1('keyB', secret, infoHash) };
}

/**
 * Runs the initiator side over a freshly connected transport. Resolves with the wrapped
 * stream; rejects (leaving the socket for the caller to destroy) when the peer does not
 * speak MSE or refuses our crypto offer.
 */
export function mseInitiate(sock: Duplex, opts: MseInitiateOptions): Promise<MseResult> {
  const reader = new HandshakeReader(sock);
  const run = async (): Promise<MseResult> => {
    const { privateKey, publicKey } = dhKeyPair();
    sock.write(Buffer.concat([publicKey, randomPad()]));
    const yb = await reader.read(MSE_KEY_BYTES);
    const secret = dhSecret(privateKey, yb);
    const k = keys(secret, opts.infoHash);
    const enc = new RC4(k.a, 1024);
    const dec = new RC4(k.b, 1024);
    const provide = CRYPTO_RC4 | (opts.allowPlaintext ? CRYPTO_PLAINTEXT : 0);
    const padC = randomPad(64);
    const plain = Buffer.concat([VC, u32(provide), u16(padC.length), padC, u16(0)]);
    sock.write(Buffer.concat([sha1('req1', secret), xor(sha1('req2', opts.infoHash), sha1('req3', secret)), enc.update(plain)]));
    // B's reply starts with ENCRYPT(VC) somewhere after PadB.
    const vcPattern = new RC4(k.b, 1024).update(VC);
    await reader.sync(vcPattern, MAX_PAD);
    dec.skip(VC.length);
    const head = dec.update(await reader.read(6));
    const select = head.readUInt32BE(0);
    const padD = head.readUInt16BE(4);
    if (padD > MAX_PAD) throw new TorrentEngineError('peer', 'mse: PadD too long');
    if (padD > 0) dec.update(await reader.read(padD));
    let method: CryptoMethod;
    if (select === CRYPTO_RC4) method = 'rc4';
    else if (select === CRYPTO_PLAINTEXT && opts.allowPlaintext) method = 'plaintext';
    else throw new TorrentEngineError('peer', `mse: peer selected unsupported crypto ${select}`);
    const rest = reader.detach();
    const stream =
      method === 'rc4' ? new CipherStream(sock, enc, dec, rest.length ? dec.update(rest) : rest) : new CipherStream(sock, null, null, rest);
    return { stream, method };
  };
  return withTimeout(run(), opts.timeoutMs ?? 10_000, reader).catch((err: unknown) => {
    reader.detach();
    throw err;
  });
}

export interface MseRespondOptions {
  /** Maps HASH('req2', infoHash) to one of our torrents' info-hashes (see `mseReq2`). */
  findInfoHash: (req2: Buffer) => Buffer | null;
  /** Accept plaintext payloads (encryption `preferred`). */
  allowPlaintext: boolean;
  timeoutMs?: number;
}

export interface MseRespondResult extends MseResult {
  infoHash: Buffer;
}

/** Runs the receiver side. `initial` holds bytes already read while sniffing the protocol. */
export function mseRespond(sock: Duplex, initial: Buffer, opts: MseRespondOptions): Promise<MseRespondResult> {
  const reader = new HandshakeReader(sock, initial);
  const run = async (): Promise<MseRespondResult> => {
    const ya = await reader.read(MSE_KEY_BYTES);
    const { privateKey, publicKey } = dhKeyPair();
    const secret = dhSecret(privateKey, ya);
    sock.write(Buffer.concat([publicKey, randomPad()]));
    await reader.sync(sha1('req1', secret), MAX_PAD);
    const req2 = xor(await reader.read(20), sha1('req3', secret));
    const infoHash = opts.findInfoHash(req2);
    if (!infoHash) throw new TorrentEngineError('peer', 'mse: unknown info-hash');
    const k = keys(secret, infoHash);
    const dec = new RC4(k.a, 1024);
    const enc = new RC4(k.b, 1024);
    const head = dec.update(await reader.read(14));
    if (!head.subarray(0, 8).equals(VC)) throw new TorrentEngineError('peer', 'mse: verification constant mismatch');
    const provide = head.readUInt32BE(8);
    const padC = head.readUInt16BE(12);
    if (padC > MAX_PAD) throw new TorrentEngineError('peer', 'mse: PadC too long');
    if (padC > 0) dec.update(await reader.read(padC));
    const iaLen = dec.update(await reader.read(2)).readUInt16BE(0);
    const ia = iaLen > 0 ? dec.update(await reader.read(iaLen)) : Buffer.alloc(0);
    let select: number;
    if (provide & CRYPTO_RC4) select = CRYPTO_RC4;
    else if (provide & CRYPTO_PLAINTEXT && opts.allowPlaintext) select = CRYPTO_PLAINTEXT;
    else throw new TorrentEngineError('peer', `mse: no acceptable crypto method in ${provide}`);
    const padD = randomPad(64);
    sock.write(enc.update(Buffer.concat([VC, u32(select), u16(padD.length), padD])));
    const rest = reader.detach();
    if (select === CRYPTO_RC4) {
      const initialPlain = Buffer.concat([ia, rest.length ? dec.update(rest) : rest]);
      return { stream: new CipherStream(sock, enc, dec, initialPlain), method: 'rc4', infoHash };
    }
    return { stream: new CipherStream(sock, null, null, Buffer.concat([ia, rest])), method: 'plaintext', infoHash };
  };
  return withTimeout(run(), opts.timeoutMs ?? 10_000, reader).catch((err: unknown) => {
    reader.detach();
    throw err;
  });
}
