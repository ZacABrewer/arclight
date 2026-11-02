import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  ImportListCleanupAction,
  ImportListFilters,
  ImportListImplementation,
  ImportListStreamingRule,
  ImportListMediaType,
  MinimumAvailability,
  MonitorOption,
  SeriesType,
} from '@arclight/shared';

// Import-lists module tables. Exclusions are not here: they share the library's
// `import_exclusions` table so a title deleted "with exclusion" is never re-added by a list.

export const importLists = sqliteTable('import_lists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  implementation: text('implementation').$type<ImportListImplementation>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  enableAutomaticAdd: integer('enable_automatic_add', { mode: 'boolean' }).notNull().default(true),
  searchOnAdd: integer('search_on_add', { mode: 'boolean' }).notNull().default(false),
  monitorOption: text('monitor_option').$type<MonitorOption>().notNull().default('all'),
  seriesType: text('series_type').$type<SeriesType>().notNull().default('standard'),
  seasonFolder: integer('season_folder', { mode: 'boolean' }).notNull().default(true),
  rootFolderPath: text('root_folder_path').notNull(),
  movieRootFolderPath: text('movie_root_folder_path'),
  qualityProfileId: integer('quality_profile_id').notNull(),
  tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
  minimumAvailability: text('minimum_availability').$type<MinimumAvailability>().notNull().default('released'),
  mediaType: text('media_type').$type<ImportListMediaType>().notNull(),
  /** Per-implementation settings (secrets in clear; masked by the service on read). */
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  /** Hours between syncs of this list; null = the global `importLists.syncIntervalHours`. */
  syncIntervalHours: integer('sync_interval_hours'),
  filters: text('filters', { mode: 'json' }).$type<ImportListFilters>().notNull().default({}),
  streaming: text('streaming', { mode: 'json' })
    .$type<ImportListStreamingRule>()
    .notNull()
    .default({ enabled: false, providerIds: [] }),
  cleanupAction: text('cleanup_action').$type<ImportListCleanupAction>().notNull().default('none'),
  lastSyncAt: text('last_sync_at'),
  lastSyncError: text('last_sync_error'),
  addedAt: text('added_at').notNull(),
});

/** Items each list returned on its last successful fetch (preview, "found in list", clean library). */
export const importListItems = sqliteTable(
  'import_list_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    importListId: integer('import_list_id')
      .notNull()
      .references(() => importLists.id, { onDelete: 'cascade' }),
    mediaType: text('media_type', { enum: ['series', 'movie'] }).notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    imdbId: text('imdb_id'),
    title: text('title').notNull(),
    year: integer('year'),
    fetchedAt: text('fetched_at').notNull(),
  },
  (t) => [
    uniqueIndex('import_list_items_list_media_tmdb_idx').on(t.importListId, t.mediaType, t.tmdbId),
    index('import_list_items_media_tmdb_idx').on(t.mediaType, t.tmdbId),
  ],
);

/** Titles a list added to the library, so per-list clean-up only touches what that list brought in. */
export const importListAdditions = sqliteTable(
  'import_list_additions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    importListId: integer('import_list_id')
      .notNull()
      .references(() => importLists.id, { onDelete: 'cascade' }),
    mediaType: text('media_type', { enum: ['series', 'movie'] }).notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    addedAt: text('added_at').notNull(),
  },
  (t) => [uniqueIndex('import_list_additions_list_media_tmdb_idx').on(t.importListId, t.mediaType, t.tmdbId)],
);

/**
 * Lookups that never change and are slow to repeat: Letterboxd slug -> TMDB id, IMDb id -> TMDB
 * id. `tmdbId` null records a miss so it is not retried until `fetchedAt` ages out.
 */
export const importListIdCache = sqliteTable(
  'import_list_id_cache',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    mediaType: text('media_type', { enum: ['series', 'movie'] }),
    tmdbId: integer('tmdb_id'),
    imdbId: text('imdb_id'),
    title: text('title'),
    year: integer('year'),
    fetchedAt: text('fetched_at').notNull(),
  },
  (t) => [uniqueIndex('import_list_id_cache_ns_key_idx').on(t.namespace, t.key)],
);
