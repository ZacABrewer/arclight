import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ReleaseResource } from '@arclight/shared';

// Tables owned by the releases module.

/** Releases held back by a delay profile (or an unavailable client) until they are eligible. */
export const pendingReleases = sqliteTable(
  'pending_releases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guid: text('guid').notNull(),
    indexerId: integer('indexer_id').notNull(),
    title: text('title').notNull(),
    mediaType: text('media_type', { enum: ['series', 'movie'] }).notNull(),
    seriesId: integer('series_id'),
    episodeIds: text('episode_ids', { mode: 'json' }).$type<number[]>(),
    movieId: integer('movie_id'),
    reason: text('reason', { enum: ['delay', 'fallback', 'downloadClientUnavailable'] }).notNull(),
    /** Snapshot of the release as the indexer reported it. */
    release: text('release', { mode: 'json' }).$type<ReleaseResource>().notNull(),
    addedAt: text('added_at').notNull(),
    eligibleAt: text('eligible_at').notNull(),
  },
  (t) => [
    uniqueIndex('pending_releases_guid_indexer_idx').on(t.guid, t.indexerId),
    index('pending_releases_series_idx').on(t.seriesId),
    index('pending_releases_movie_idx').on(t.movieId),
  ],
);

/** Per-item backoff for the scheduled missing / cutoff-unmet searches. */
export const releaseSearchState = sqliteTable(
  'release_search_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaType: text('media_type', { enum: ['episode', 'movie'] }).notNull(),
    itemId: integer('item_id').notNull(),
    lastSearchedAt: text('last_searched_at').notNull(),
    /** Consecutive automatic searches without a grab. */
    searchCount: integer('search_count').notNull().default(0),
  },
  (t) => [uniqueIndex('release_search_state_item_idx').on(t.mediaType, t.itemId)],
);
