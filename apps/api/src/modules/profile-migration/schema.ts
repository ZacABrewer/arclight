import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  MediaType,
  ProfileFileStatus,
  ProfileFileStatusReason,
  ProfileMigrationQueueState,
  ProfileMismatchAction,
} from '@arclight/shared';

// Profile-migration module tables. Rows point at library files and items by id without
// foreign keys (same rule as history/media-analysis): every re-evaluation rewrites the rows of
// the items it looked at, so rows of deleted files and items disappear with the next pass.

/** Per quality profile: the "when files don't meet this profile" rule and the automatic-mode switches. */
export const profileMigrationRules = sqliteTable('profile_migration_rules', {
  qualityProfileId: integer('quality_profile_id').primaryKey(),
  mismatchAction: text('mismatch_action').$type<ProfileMismatchAction>().notNull().default('none'),
  autoEnabled: integer('auto_enabled', { mode: 'boolean' }).notNull().default(false),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
});

/** How each library file fits the profile governing it (its item's, or its version slot's). */
export const profileFileFits = sqliteTable(
  'profile_file_fits',
  {
    mediaFileId: integer('media_file_id').primaryKey(),
    mediaType: text('media_type').$type<MediaType>().notNull(),
    seriesId: integer('series_id'),
    movieId: integer('movie_id'),
    /** Version slot the file fills; '' on unversioned items. */
    slot: text('slot').notNull().default(''),
    qualityProfileId: integer('quality_profile_id').notNull(),
    status: text('status').$type<ProfileFileStatus>().notNull(),
    reasons: text('reasons', { mode: 'json' }).$type<ProfileFileStatusReason[]>().notNull(),
    qualityName: text('quality_name').notNull(),
    formatScore: integer('format_score').notNull(),
    evaluatedAt: text('evaluated_at').notNull(),
  },
  (t) => [
    index('profile_file_fits_profile_status_idx').on(t.qualityProfileId, t.status),
    index('profile_file_fits_series_idx').on(t.seriesId),
    index('profile_file_fits_movie_idx').on(t.movieId),
  ],
);

/**
 * Last seen profile of every item and version slot ({'': itemProfile, '4K': slotProfile}), so a
 * change made anywhere (editor, bulk editor, migration, API) is detected and recorded once.
 */
export const profileItemSnapshots = sqliteTable(
  'profile_item_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaType: text('media_type').$type<MediaType>().notNull(),
    itemId: integer('item_id').notNull(),
    profiles: text('profiles', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  },
  (t) => [uniqueIndex('profile_item_snapshots_item_idx').on(t.mediaType, t.itemId)],
);

/**
 * The migration work list: one row per movie (slot) or episode (slot) whose file does not meet
 * a profile that has a replacement rule. `done` rows are kept (progress) and pruned after 30 days.
 */
export const profileMigrationQueue = sqliteTable(
  'profile_migration_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 'm:<movieId>:<slot>' or 'e:<episodeId>:<slot>'. */
    unitKey: text('unit_key').notNull(),
    mediaType: text('media_type').$type<MediaType>().notNull(),
    seriesId: integer('series_id'),
    seasonNumber: integer('season_number'),
    episodeId: integer('episode_id'),
    movieId: integer('movie_id'),
    slot: text('slot').notNull().default(''),
    qualityProfileId: integer('quality_profile_id').notNull(),
    /** The file being replaced (as last seen) and what it was. */
    mediaFileId: integer('media_file_id').notNull(),
    fileStatus: text('file_status').$type<ProfileFileStatus>().notNull(),
    oldQualityName: text('old_quality_name').notNull(),
    oldPath: text('old_path').notNull(),
    state: text('state').$type<ProfileMigrationQueueState>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** Higher first: open requests for the item. */
    requests: integer('requests').notNull().default(0),
    /** When the item was added to the library (older first). */
    itemAdded: text('item_added').notNull(),
    lastSearchedAt: text('last_searched_at'),
    nextSearchAt: text('next_search_at'),
    grabbedAt: text('grabbed_at'),
    finishedAt: text('finished_at'),
    message: text('message'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('profile_migration_queue_unit_idx').on(t.unitKey),
    index('profile_migration_queue_profile_state_idx').on(t.qualityProfileId, t.state),
    index('profile_migration_queue_series_idx').on(t.seriesId),
    index('profile_migration_queue_movie_idx').on(t.movieId),
  ],
);

/** One row per search the migration started (rolling daily limit); pruned after two days. */
export const profileMigrationSearches = sqliteTable(
  'profile_migration_searches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull(),
    qualityProfileId: integer('quality_profile_id').notNull(),
    automatic: integer('automatic', { mode: 'boolean' }).notNull(),
  },
  (t) => [index('profile_migration_searches_at_idx').on(t.at)],
);

export type ProfileFileFitRow = typeof profileFileFits.$inferSelect;
export type ProfileMigrationQueueRow = typeof profileMigrationQueue.$inferSelect;
