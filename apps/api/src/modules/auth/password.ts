import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Password hashing with scrypt from node:crypto. The stored form carries its own cost
// parameters so they can be raised later without invalidating existing hashes:
//   scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
export const DEFAULT_COST = { N: 16384, r: 8, p: 1 } as const;

function derive(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must cover 128 * N * r bytes; give headroom for raised costs.
    scrypt(password.normalize('NFKC'), salt, keylen, { ...opts, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string, cost: { N: number; r: number; p: number } = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, KEY_LENGTH, cost);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Constant-time check of `password` against a stored hash. Malformed hashes never verify. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const expected = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await derive(password, salt, expected.length, { N, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when the hash was made with weaker parameters than the current default. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) < DEFAULT_COST.N || Number(parts[2]) < DEFAULT_COST.r;
}

/**
 * A hash of a random password, verified against when the username does not exist so that a
 * login for an unknown user costs the same as one with a wrong password.
 */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}
