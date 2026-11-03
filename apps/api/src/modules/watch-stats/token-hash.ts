import { createHash } from 'node:crypto';
import { eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { wrappedShares } from './schema.js';

// Year-in-review share tokens are sealed at rest (random IV), so lookups go by a sha256 of the
// token instead. Kept apart from shares.ts so the startup secrets backfill can use it without
// pulling in the routes' imports.

export function shareTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Fills `token_hash` for links created before 0.24 (or by an older version after a downgrade).
 * Runs at startup before secrets are sealed; reading through Drizzle opens sealed tokens.
 * Returns how many rows it filled.
 */
export function backfillShareTokenHashes(db: Db): number {
  const rows = db.select({ id: wrappedShares.id, token: wrappedShares.token }).from(wrappedShares).where(isNull(wrappedShares.tokenHash)).all();
  let filled = 0;
  for (const row of rows) {
    if (row.token === '') continue; // sealed with a lost key: the link cannot answer anyway
    db.update(wrappedShares).set({ tokenHash: shareTokenHash(row.token) }).where(eq(wrappedShares.id, row.id)).run();
    filled++;
  }
  return filled;
}
