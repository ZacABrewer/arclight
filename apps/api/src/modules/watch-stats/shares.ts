import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, lte } from 'drizzle-orm';
import type { WrappedShare } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { API_PREFIX } from '../auth/hook.js';
import { wrappedShares, type WrappedShareRow } from './schema.js';

// Share links to a Year in review. A link is a random token; it answers until it expires or the
// owner revokes it. The public routes (routes.ts) render the page and image from live stats, so
// the link shows the year as it is when opened.

const DAY_MS = 24 * 60 * 60_000;

export function sharePath(token: string): string {
  return `${API_PREFIX}/share/wrapped/${token}`;
}

export class WrappedShares {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
    /** Public URL of this Arclight (Settings > Requests > Application URL), '' when unset. */
    private readonly applicationUrl: () => string,
  ) {}

  view(row: WrappedShareRow): WrappedShare {
    const path = sharePath(row.token);
    const base = this.applicationUrl().trim().replace(/\/+$/, '');
    return {
      id: row.id,
      userId: row.userId,
      year: row.year,
      path,
      url: base ? `${base}${path}` : null,
      imagePath: `${path}/image.svg`,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  create(userId: number, year: number, days: number): WrappedShare {
    const now = this.now();
    const row = this.db
      .insert(wrappedShares)
      .values({
        token: randomBytes(18).toString('base64url'),
        userId,
        year,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
      })
      .returning()
      .get();
    return this.view(row);
  }

  /** The user's links that still work, newest first. */
  list(userId: number): WrappedShare[] {
    return this.db
      .select()
      .from(wrappedShares)
      .where(and(eq(wrappedShares.userId, userId), gt(wrappedShares.expiresAt, this.now().toISOString())))
      .orderBy(desc(wrappedShares.id))
      .all()
      .map((r) => this.view(r));
  }

  get(id: number): WrappedShareRow | undefined {
    return this.db.select().from(wrappedShares).where(eq(wrappedShares.id, id)).get();
  }

  revoke(id: number): void {
    this.db.delete(wrappedShares).where(eq(wrappedShares.id, id)).run();
  }

  /** The live link for a token; undefined when unknown or expired. */
  resolve(token: string): WrappedShareRow | undefined {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return undefined;
    const row = this.db.select().from(wrappedShares).where(eq(wrappedShares.token, token)).get();
    if (!row || row.expiresAt <= this.now().toISOString()) return undefined;
    return row;
  }

  /** Deletes expired links; returns how many. */
  prune(): number {
    return this.db.delete(wrappedShares).where(lte(wrappedShares.expiresAt, this.now().toISOString())).run().changes;
  }
}
