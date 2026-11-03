import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { ContentRestrictions, PlayQueue, ProfileSettingsPatch } from '@arclight/shared';
import { users } from '../auth/schema.js';

// Household profiles ("Who's watching?"). Every account has exactly one owner profile (created
// by the backfill or lazily by `ownerProfileOf`); the player's per-viewer rows (progress, plays,
// queue, bookmarks, playlists, My List) carry the profile they belong to.

export const householdProfiles = sqliteTable(
  'household_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    initial: text('initial').notNull(),
    isOwner: integer('is_owner', { mode: 'boolean' }).notNull().default(false),
    /** `scrypt$…` hash of the 4-digit PIN (auth/password.ts); null: no PIN. Never returned. */
    pinHash: text('pin_hash'),
    /** The profile's own limit, combined with the account's (the stricter wins). Always null on the owner. */
    contentRestrictions: text('content_restrictions', { mode: 'json' }).$type<ContentRestrictions | null>(),
    /** Stored as a patch over the ProfileSettings defaults, so new settings get their default. */
    settings: text('settings', { mode: 'json' }).$type<ProfileSettingsPatch>().notNull().default({}),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('household_profiles_user_idx').on(t.userId),
    uniqueIndex('household_profiles_owner_idx').on(t.userId).where(sql`${t.isOwner} = 1`),
  ],
);

/** My List: titles already in the library a profile saved for later (separate from the request watchlist). */
export const profileMyList = sqliteTable(
  'profile_my_list',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    profileId: integer('profile_id')
      .notNull()
      .references(() => householdProfiles.id, { onDelete: 'cascade' }),
    /** `movie:<id>` or `series:<id>` (MyListKey). */
    itemKey: text('item_key').notNull(),
    addedAt: text('added_at').notNull(),
  },
  (t) => [uniqueIndex('profile_my_list_item_idx').on(t.profileId, t.itemKey)],
);

/** One play queue per profile (replaces `playback_queue`, which stays read-only for the backfill). */
export const profilePlaybackQueue = sqliteTable('profile_playback_queue', {
  profileId: integer('profile_id')
    .primaryKey()
    .references(() => householdProfiles.id, { onDelete: 'cascade' }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  queue: text('queue', { mode: 'json' }).$type<Omit<PlayQueue, 'updatedAt' | 'deviceId'>>().notNull(),
  deviceId: text('device_id'),
  updatedAt: text('updated_at').notNull(),
});

export type HouseholdProfileRow = typeof householdProfiles.$inferSelect;
