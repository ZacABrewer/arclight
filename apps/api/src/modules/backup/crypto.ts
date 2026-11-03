import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PRIVATE_FILE_MODE } from '../../file-modes.js';

// Optional backup encryption: the whole zip is encrypted with AES-256-GCM under a key derived
// from the backup passphrase with scrypt (random salt per file).
//
// File layout (format version 1), all integers unsigned:
//    0  8   magic "ARCLENC\0"
//    8  1   format version (1)
//    9  1   KDF id (1 = scrypt)
//   10  1   log2(N)
//   11  1   r
//   12  1   p
//   13  3   reserved (0)
//   16  16  salt
//   32  12  IV
//   44  16  passphrase check (bytes 32..47 of the scrypt output; tells a wrong passphrase apart
//           from a damaged file without decrypting gigabytes first)
//   60  ..  ciphertext
//  end  16  GCM tag
// The 60-byte header is the GCM additional data, so every header field is authenticated.

export const ENC_MAGIC = Buffer.from('ARCLENC\0', 'latin1');
const FORMAT_VERSION = 1;
const KDF_SCRYPT = 1;
const HEADER_LEN = 60;
const TAG_LEN = 16;
const SALT_LEN = 16;
const IV_LEN = 12;
const CHECK_LEN = 16;

export interface ScryptParams {
  log2N: number;
  r: number;
  p: number;
}

/** 2^17 x 8 = 128 MiB of memory per derivation, about half a second on a NAS CPU. */
export const DEFAULT_SCRYPT: ScryptParams = { log2N: 17, r: 8, p: 1 };
/** Bounds for parameters read from a file, so a crafted header cannot ask for gigabytes. */
const MAX_LOG2N = 20;
const MAX_R = 16;
const MAX_P = 4;
const MAX_MEM = 1024 * 1024 * 1024;

export type BackupCryptoErrorCode = 'BAD_PASSPHRASE' | 'DAMAGED' | 'UNSUPPORTED';

export class BackupCryptoError extends Error {
  constructor(
    readonly code: BackupCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BackupCryptoError';
  }
}

function scrypt(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.log2N;
  const opts: ScryptOptions = { N, r: params.r, p: params.p, maxmem: 128 * N * params.r * params.p + 32 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    scryptCb(passphrase.normalize('NFC'), salt, 64, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** True when the file starts with the encrypted-backup magic. */
export async function isEncryptedBackup(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(ENC_MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return bytesRead === buf.length && buf.equals(ENC_MAGIC);
  } finally {
    await fh.close();
  }
}

/** Encrypts `src` into `dest` (created with mode 0600). */
export async function encryptFile(src: string, dest: string, passphrase: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<void> {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const derived = await scrypt(passphrase, salt, params);
  const header = Buffer.alloc(HEADER_LEN);
  ENC_MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 8);
  header.writeUInt8(KDF_SCRYPT, 9);
  header.writeUInt8(params.log2N, 10);
  header.writeUInt8(params.r, 11);
  header.writeUInt8(params.p, 12);
  salt.copy(header, 16);
  iv.copy(header, 32);
  derived.copy(header, 44, 32, 32 + CHECK_LEN);

  const cipher = createCipheriv('aes-256-gcm', derived.subarray(0, 32), iv, { authTagLength: TAG_LEN });
  cipher.setAAD(header);
  const out = createWriteStream(dest, { mode: PRIVATE_FILE_MODE });
  out.write(header);
  await pipeline(
    createReadStream(src),
    cipher,
    new Transform({
      transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
        cb(null, chunk);
      },
      flush(cb: TransformCallback) {
        this.push(cipher.getAuthTag());
        cb();
      },
    }),
    out,
  );
}

/**
 * Decrypts `src` into `dest` (mode 0600). Throws BAD_PASSPHRASE for a wrong passphrase and
 * DAMAGED when the tag does not verify; `dest` must then be discarded (the caller's staging
 * folder), since GCM only proves integrity at the end.
 */
export async function decryptFile(src: string, dest: string, passphrase: string): Promise<void> {
  const { size } = await stat(src);
  if (size < HEADER_LEN + TAG_LEN) throw new BackupCryptoError('DAMAGED', 'encrypted backup is truncated');
  const fh = await open(src, 'r');
  const header = Buffer.alloc(HEADER_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    await fh.read(header, 0, HEADER_LEN, 0);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    await fh.close();
  }
  if (!header.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) throw new BackupCryptoError('UNSUPPORTED', 'not an encrypted Arclight backup');
  const version = header.readUInt8(8);
  if (version !== FORMAT_VERSION) throw new BackupCryptoError('UNSUPPORTED', `encrypted backup format ${version} is not supported; update Arclight`);
  if (header.readUInt8(9) !== KDF_SCRYPT) throw new BackupCryptoError('UNSUPPORTED', 'unknown key derivation in encrypted backup');
  const params: ScryptParams = { log2N: header.readUInt8(10), r: header.readUInt8(11), p: header.readUInt8(12) };
  if (
    params.log2N < 10 ||
    params.log2N > MAX_LOG2N ||
    params.r < 1 ||
    params.r > MAX_R ||
    params.p < 1 ||
    params.p > MAX_P ||
    128 * 2 ** params.log2N * params.r * params.p > MAX_MEM
  ) {
    throw new BackupCryptoError('UNSUPPORTED', 'encrypted backup asks for unsupported key derivation parameters');
  }
  const salt = header.subarray(16, 32);
  const iv = header.subarray(32, 44);
  const check = header.subarray(44, 60);
  const derived = await scrypt(passphrase, salt, params);
  if (!timingSafeEqual(derived.subarray(32, 32 + CHECK_LEN), check)) throw new BackupCryptoError('BAD_PASSPHRASE', 'wrong backup passphrase');

  const decipher = createDecipheriv('aes-256-gcm', derived.subarray(0, 32), iv, { authTagLength: TAG_LEN });
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }), decipher, createWriteStream(dest, { mode: PRIVATE_FILE_MODE }));
  } catch (err) {
    if (err instanceof Error && /auth|unable to authenticate/i.test(err.message)) {
      throw new BackupCryptoError('DAMAGED', 'encrypted backup is damaged (authentication failed)');
    }
    throw err;
  }
}
