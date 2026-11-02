import { createHash } from 'node:crypto';

/** sha256 hex of a token or key; only these hashes are stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
