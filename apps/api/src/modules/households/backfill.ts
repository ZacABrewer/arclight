import { and, eq, inArray, isNull, gt, asc } from 'drizzle-orm';
import { HOUSEHOLD_PROFILE_COLORS } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { users } from '../auth/schema.js';
import { playbackBookmarks, playbackPlays, playbackProgress, playbackQueue, userPlaylists } from '../playback/schema.js';
import { householdProfiles, profilePlaybackQueue, type HouseholdProfileRow } from './schema.js';

// Owner profiles and the profile_id backfill (spec §2.2). Everything here is idempotent: the
// module runs it at startup, and `ownerProfileOf` heals a single account lazily (accounts created
// by a path that did not call it, rows written before the module started).

const BATCH = 500;
const NAME_MAX = 24;

/** The owner profile's name: the display name, else the username, cut to 24 characters. */
export function ownerProfileName(user: { username: string; displayName: string | null }): string {
  const base = (user.displayName?.trim() || user.username.trim() || 'Owner').slice(0, NAME_MAX).trim();
  return base === '' ? 'Owner' : base;
}

/** First letter of a name, upper-cased (a whole code point, so emoji and accents survive). */
export function defaultInitial(name: string): string {
  const first = Array.from(name.trim())[0] ?? '?';
  return first.toLocaleUpperCase();
}

export function ownerProfileColor(userId: number): string {
  return HOUSEHOLD_PROFILE_COLORS[(((userId - 1) % HOUSEHOLD_PROFILE_COLORS.length) + HOUSEHOLD_PROFILE_COLORS.length) % HOUSEHOLD_PROFILE_COLORS.length]!;
}

function findOwner(db: Db, userId: number): HouseholdProfileRow | undefined {
  return db
    .select()
    .from(householdProfiles)
    .where(and(eq(householdProfiles.userId, userId), eq(householdProfiles.isOwner, true)))
    .get();
}

function insertOwner(db: Db, user: { id: number; username: string; displayName: string | null }, now: string): void {
  const name = ownerProfileName(user);
  db.insert(householdProfiles)
    .values({
      userId: user.id,
      name,
      color: ownerProfileColor(user.id),
      initial: defaultInitial(name),
      isOwner: true,
      pinHash: null,
      contentRestrictions: null,
      settings: {},
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    })
    // The partial unique index (one owner per account) makes a concurrent second insert a no-op.
    .onConflictDoNothing()
    .run();
}

/**
 * The account's owner profile, created when missing (then that account's rows without a
 * profile are moved onto it). null only when the user does not exist.
 */
export function ownerProfileOf(db: Db, userId: number, now: () => Date = () => new Date()): HouseholdProfileRow | null {
  const found = findOwner(db, userId);
  if (found) return found;
  const user = db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(eq(users.id, userId)).get();
  if (!user) return null;
  insertOwner(db, user, now().toISOString());
  const owner = findOwner(db, userId);
  if (!owner) return null;
  backfillUser(db, userId, owner.id);
  return owner;
}

/** Inserts an owner profile for every account that has none. Returns how many were created. */
export function ensureOwnerProfiles(db: Db, now: () => Date = () => new Date()): number {
  let created = 0;
  let after = 0;
  for (;;) {
    const batch = db
      .select({ id: users.id, username: users.username, displayName: users.displayName, owner: householdProfiles.id })
      .from(users)
      .leftJoin(householdProfiles, and(eq(householdProfiles.userId, users.id), eq(householdProfiles.isOwner, true)))
      .where(gt(users.id, after))
      .orderBy(asc(users.id))
      .limit(BATCH)
      .all();
    if (batch.length === 0) break;
    const at = now().toISOString();
    for (const u of batch) {
      if (u.owner !== null) continue;
      insertOwner(db, u, at);
      created++;
    }
    after = batch[batch.length - 1]!.id;
  }
  return created;
}

type ProfileTable = typeof playbackProgress | typeof playbackPlays | typeof playbackBookmarks | typeof userPlaylists;
const PROFILE_TABLES: readonly ProfileTable[] = [playbackProgress, playbackPlays, playbackBookmarks, userPlaylists];

function ownerIdsFor(db: Db, userIds: readonly number[], cache: Map<number, number | null>): void {
  const missing = userIds.filter((id) => !cache.has(id));
  if (missing.length === 0) return;
  const rows = db
    .select({ id: householdProfiles.id, userId: householdProfiles.userId })
    .from(householdProfiles)
    .where(and(inArray(householdProfiles.userId, missing), eq(householdProfiles.isOwner, true)))
    .all();
  for (const r of rows) cache.set(r.userId, r.id);
  for (const id of missing) if (!cache.has(id)) cache.set(id, ownerProfileOf(db, id)?.id ?? null);
}

/** Sets profile_id to the owner profile on rows that have none, in batches. Returns rows changed. */
function backfillTable(db: Db, table: ProfileTable, owners: Map<number, number | null>): number {
  let changed = 0;
  let after = 0;
  for (;;) {
    const batch = db
      .select({ id: table.id, userId: table.userId })
      .from(table)
      .where(and(isNull(table.profileId), gt(table.id, after)))
      .orderBy(asc(table.id))
      .limit(BATCH)
      .all();
    if (batch.length === 0) break;
    ownerIdsFor(db, [...new Set(batch.map((r) => r.userId))], owners);
    const byOwner = new Map<number, number[]>();
    for (const r of batch) {
      const owner = owners.get(r.userId);
      if (owner === null || owner === undefined) continue;
      const ids = byOwner.get(owner) ?? [];
      ids.push(r.id);
      byOwner.set(owner, ids);
    }
    for (const [owner, ids] of byOwner) {
      changed += db.update(table).set({ profileId: owner }).where(and(inArray(table.id, ids), isNull(table.profileId))).run().changes;
    }
    after = batch[batch.length - 1]!.id;
  }
  return changed;
}

/** Copies `playback_queue` rows into `profile_playback_queue` (the owner's); existing rows are kept. */
function copyQueues(db: Db, owners: Map<number, number | null>, onlyUser?: number): number {
  let copied = 0;
  let after = 0;
  for (;;) {
    const where = onlyUser === undefined ? gt(playbackQueue.userId, after) : and(eq(playbackQueue.userId, onlyUser), gt(playbackQueue.userId, after));
    const batch = db.select().from(playbackQueue).where(where).orderBy(asc(playbackQueue.userId)).limit(BATCH).all();
    if (batch.length === 0) break;
    ownerIdsFor(db, batch.map((r) => r.userId), owners);
    for (const r of batch) {
      const owner = owners.get(r.userId);
      if (owner === null || owner === undefined) continue;
      copied += db
        .insert(profilePlaybackQueue)
        .values({ profileId: owner, userId: r.userId, queue: r.queue, deviceId: r.deviceId, updatedAt: r.updatedAt })
        .onConflictDoNothing()
        .run().changes;
    }
    after = batch[batch.length - 1]!.userId;
  }
  return copied;
}

export interface BackfillResult {
  profiles: number;
  rows: number;
  queues: number;
}

/** For every per-profile table: profile_id = the account's owner profile where it is null. */
export function backfillProfileIds(db: Db): Omit<BackfillResult, 'profiles'> {
  const owners = new Map<number, number | null>();
  let rows = 0;
  for (const table of PROFILE_TABLES) rows += backfillTable(db, table, owners);
  return { rows, queues: copyQueues(db, owners) };
}

/** The whole backfill: owner profiles, then profile ids. Safe to run any number of times. */
export function runHouseholdBackfill(db: Db, now: () => Date = () => new Date()): BackfillResult {
  const profiles = ensureOwnerProfiles(db, now);
  return { profiles, ...backfillProfileIds(db) };
}

/** One account's rows onto its owner profile (lazy path of ownerProfileOf). */
function backfillUser(db: Db, userId: number, ownerId: number): void {
  for (const table of PROFILE_TABLES) {
    db.update(table).set({ profileId: ownerId }).where(and(eq(table.userId, userId), isNull(table.profileId))).run();
  }
  copyQueues(db, new Map([[userId, ownerId]]), userId);
}
