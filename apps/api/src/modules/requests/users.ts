import { asc, eq, inArray } from 'drizzle-orm';
import { MediaServerLink, UserApprovalPolicy, UserRequestSettings, type RequestUser } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { RequestsError } from './errors.js';
import { effectivePermissions } from './permissions.js';

// Read access to the auth module's users table plus the request-related part of a user's
// `settings` JSON (quota overrides, personal notification agents, Plex token, watchlist sync).

export type UserRow = typeof users.$inferSelect;

export function userRow(db: Db, id: number): UserRow {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  if (!row) throw RequestsError.notFound('user', id);
  return row;
}

export function findUserRow(db: Db, id: number): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function allUserRows(db: Db): UserRow[] {
  return db.select().from(users).orderBy(asc(users.id)).all();
}

export function userPermissions(row: UserRow): number {
  return effectivePermissions(row);
}

/** The oldest admin; API-key callers act through it when they create something. */
export function ownerUser(db: Db): UserRow {
  const row = db.select().from(users).where(eq(users.role, 'admin')).orderBy(asc(users.id)).limit(1).get();
  if (!row) throw new RequestsError('VALIDATION', 'no admin account exists to own this; pass userId');
  return row;
}

export function toRequestUser(row: UserRow | undefined, fallbackId: number): RequestUser {
  if (!row) return { id: fallbackId, username: `deleted user ${fallbackId}` };
  return {
    id: row.id,
    username: row.username,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.avatar ? { avatar: row.avatar } : {}),
  };
}

/** Batch lookup for list responses. */
export function requestUsers(db: Db, ids: Iterable<number | null>): Map<number, RequestUser> {
  const wanted = [...new Set([...ids].filter((id): id is number => id !== null))];
  const out = new Map<number, RequestUser>();
  if (wanted.length === 0) return out;
  const rows = db.select().from(users).where(inArray(users.id, wanted)).all();
  for (const id of wanted) out.set(id, toRequestUser(rows.find((r) => r.id === id), id));
  return out;
}

/** The request-related part of `users.settings`, defaults applied. */
export function requestSettingsOf(row: Pick<UserRow, 'settings'>): UserRequestSettings {
  const raw = (row.settings ?? {}) as Record<string, unknown>;
  const parsed = UserRequestSettings.safeParse({
    notifications: raw['notifications'],
    plexToken: raw['plexToken'],
    watchlistSyncMovies: raw['watchlistSyncMovies'],
    watchlistSyncSeries: raw['watchlistSyncSeries'],
    autoRequestFromWatchlist: raw['autoRequestFromWatchlist'],
    mediaServerLink: raw['mediaServerLink'],
  });
  if (parsed.success) return parsed.data;
  // A malformed link must not hide the user's other settings.
  const retry = UserRequestSettings.safeParse({ ...raw, mediaServerLink: undefined });
  return retry.success ? retry.data : UserRequestSettings.parse({});
}

/** The user's media-server link, if any. */
export function mediaServerLinkOf(row: Pick<UserRow, 'settings'>): MediaServerLink | undefined {
  const parsed = MediaServerLink.safeParse(((row.settings ?? {}) as Record<string, unknown>)['mediaServerLink']);
  return parsed.success ? parsed.data : undefined;
}

/** Merges `patch` into the user's settings JSON (other keys untouched). */
export function patchUserSettings(db: Db, id: number, patch: Record<string, unknown>, now: string): UserRow {
  const row = userRow(db, id);
  const settings = { ...(row.settings ?? {}), ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (settings as Record<string, unknown>)[key];
  }
  return db.update(users).set({ settings, updatedAt: now }).where(eq(users.id, id)).returning().get()!;
}

export function setUserPermissions(db: Db, id: number, permissions: number, now: string): UserRow {
  const row = userRow(db, id);
  const next = effectivePermissions({ role: row.role, permissions });
  return db.update(users).set({ permissions: next, updatedAt: now }).where(eq(users.id, id)).returning().get()!;
}

/** The user's approval-policy override (users.settings.approvalPolicy), defaults applied. */
export function approvalPolicyOf(row: Pick<UserRow, 'settings'>): UserApprovalPolicy {
  const parsed = UserApprovalPolicy.safeParse(((row.settings ?? {}) as Record<string, unknown>)['approvalPolicy'] ?? {});
  return parsed.success ? parsed.data : UserApprovalPolicy.parse({});
}
