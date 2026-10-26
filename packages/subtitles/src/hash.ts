import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

// File hashes used by providers (spec providers 1.6). Computed once per file by the host.

export const OPENSUBTITLES_CHUNK = 65536;
const MASK64 = (1n << 64n) - 1n;

/**
 * OpenSubtitles-style hash from the file size and its first and last 64 KiB: size plus the
 * sum of all little-endian 64-bit words of both chunks, truncated to 64 bits, as 16 hex chars.
 */
export function openSubtitlesHash(size: number, head: Uint8Array, tail: Uint8Array): string {
  let sum = BigInt(size) & MASK64;
  for (const chunk of [head, tail]) {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const words = Math.floor(chunk.byteLength / 8);
    for (let i = 0; i < words; i++) sum = (sum + view.getBigUint64(i * 8, true)) & MASK64;
  }
  return sum.toString(16).padStart(16, '0');
}

/** Hash an in-memory file (tests, small inputs). Undefined below 128 KiB. */
export function openSubtitlesHashOfBuffer(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < OPENSUBTITLES_CHUNK * 2) return undefined;
  return openSubtitlesHash(bytes.byteLength, bytes.subarray(0, OPENSUBTITLES_CHUNK), bytes.subarray(bytes.byteLength - OPENSUBTITLES_CHUNK));
}

/** Hash a file on disk; undefined for files under 128 KiB (spec: hash not meaningful). */
export async function computeOpenSubtitlesHash(path: string): Promise<string | undefined> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size < OPENSUBTITLES_CHUNK * 2) return undefined;
    const head = new Uint8Array(OPENSUBTITLES_CHUNK);
    const tail = new Uint8Array(OPENSUBTITLES_CHUNK);
    await fh.read(head, 0, OPENSUBTITLES_CHUNK, 0);
    await fh.read(tail, 0, OPENSUBTITLES_CHUNK, size - OPENSUBTITLES_CHUNK);
    return openSubtitlesHash(size, head, tail);
  } finally {
    await fh.close();
  }
}

export const NAPIPROJEKT_BYTES = 10 * 1024 * 1024;

/** MD5 of the first 10 MiB; only for files larger than 10 MiB. */
export async function computeNapiprojektHash(path: string): Promise<string | undefined> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size <= NAPIPROJEKT_BYTES) return undefined;
    const buf = new Uint8Array(NAPIPROJEKT_BYTES);
    await fh.read(buf, 0, NAPIPROJEKT_BYTES, 0);
    return createHash('md5').update(buf).digest('hex');
  } finally {
    await fh.close();
  }
}

/** Spec R5.9: hashes are only computed for files larger than 10 MiB. */
export const HASH_MIN_FILE_SIZE = 10485760;

/** Compute every supported hash for a file (lazy callers cache the result per path). */
export async function computeFileHashes(path: string, size?: number): Promise<{ opensubtitles?: string; napiprojekt?: string }> {
  if (size !== undefined && size <= HASH_MIN_FILE_SIZE) return {};
  const [osh, napi] = await Promise.all([computeOpenSubtitlesHash(path), computeNapiprojektHash(path)]);
  return { ...(osh ? { opensubtitles: osh } : {}), ...(napi ? { napiprojekt: napi } : {}) };
}
