import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { QualityModel, ReleaseRejection, ReleaseResource } from '@arclight/shared';

// Tables owned by the releases module.

/** Releases held back by a delay profile (or an unavailable client) until they are eligible. */
export const pendingReleases = sqliteTable(
  'pending_releases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guid: text('guid').notNull(),
    indexerId: integer('indexer_id').notNull(),
    title: text('title').notNull(),
    // 'music' / 'audiobook' are TS-only additions (Drizzle enums are not enforced on SQLite).
    mediaType: text('media_type', { enum: ['series', 'movie', 'music', 'audiobook'] }).notNull(),
    seriesId: integer('series_id'),
    episodeIds: text('episode_ids', { mode: 'json' }).$type<number[]>(),
    movieId: integer('movie_id'),
    reason: text('reason', { enum: ['delay', 'fallback', 'downloadClientUnavailable'] }).notNull(),
    /** Snapshot of the release as the indexer reported it. */
    release: text('release', { mode: 'json' }).$type<ReleaseResource>().notNull(),
    addedAt: text('added_at').notNull(),
    eligibleAt: text('eligible_at').notNull(),
    // Audio targets (docs/design/music-audiobooks.md section 4.2); null on video rows.
    artistId: integer('artist_id'),
    albumIds: text('album_ids', { mode: 'json' }).$type<number[]>(),
    authorId: integer('author_id'),
    bookIds: text('book_ids', { mode: 'json' }).$type<number[]>(),
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
    mediaType: text('media_type', { enum: ['episode', 'movie', 'album', 'book'] }).notNull(),
    itemId: integer('item_id').notNull(),
    lastSearchedAt: text('last_searched_at').notNull(),
    /** Consecutive automatic searches without a grab. */
    searchCount: integer('search_count').notNull().default(0),
  },
  (t) => [uniqueIndex('release_search_state_item_idx').on(t.mediaType, t.itemId)],
);

/**
 * The last search of every episode / movie (automatic, manual or interactive) and what came of
 * it, one row per item, overwritten by each search. Unlike `release_search_state` it is not
 * cleared by a grab, so the Wanted and details pages can show "last searched 3 h ago · grabbed".
 */
export const releaseSearchResults = sqliteTable(
  'release_search_results',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaType: text('media_type', { enum: ['episode', 'movie', 'album', 'book'] }).notNull(),
    itemId: integer('item_id').notNull(),
    searchedAt: text('searched_at').notNull(),
    source: text('source', { enum: ['automatic', 'manual', 'interactive'] }).notNull(),
    outcome: text('outcome', { enum: ['grabbed', 'pending', 'found', 'rejected', 'noResults', 'error'] }).notNull(),
    releases: integer('releases').notNull().default(0),
    approved: integer('approved').notNull().default(0),
    /** Release title (grabbed / pending), top rejection reason (rejected) or error message. */
    detail: text('detail'),
  },
  (t) => [uniqueIndex('release_search_results_item_idx').on(t.mediaType, t.itemId)],
);

/**
 * Decision log: one row per release per evaluation batch (RSS sync, search, interactive search,
 * push, pending re-check), so the UI can answer "why was this (not) grabbed". Rows without a
 * library item are not kept. Pruned to the last 20 batches per item (`item_key`: `s<seriesId>`
 * or `m<movieId>`) on write and by age (DecisionLogCleanup, `releases.decisionLogDays`).
 */
export const releaseDecisions = sqliteTable(
  'release_decisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    batchId: text('batch_id').notNull(),
    time: text('time').notNull(),
    source: text('source', { enum: ['rss', 'search', 'interactive', 'push', 'pending'] }).notNull(),
    mediaType: text('media_type', { enum: ['series', 'movie', 'music', 'audiobook'] }),
    itemKey: text('item_key').notNull(),
    seriesId: integer('series_id'),
    episodeIds: text('episode_ids', { mode: 'json' }).$type<number[]>().notNull(),
    movieId: integer('movie_id'),
    guid: text('guid').notNull(),
    indexerId: integer('indexer_id').notNull(),
    title: text('title').notNull(),
    quality: text('quality', { mode: 'json' }).$type<QualityModel>().notNull(),
    formats: text('formats', { mode: 'json' }).$type<Array<{ id: number; name: string }>>().notNull(),
    score: integer('score').notNull(),
    approved: integer('approved', { mode: 'boolean' }).notNull(),
    rejections: text('rejections', { mode: 'json' }).$type<ReleaseRejection[]>().notNull(),
    chosen: integer('chosen', { mode: 'boolean' }).notNull().default(false),
    rank: integer('rank'),
    // Audio targets (docs/design/music-audiobooks.md section 4.2); null on video rows.
    artistId: integer('artist_id'),
    albumIds: text('album_ids', { mode: 'json' }).$type<number[]>(),
    authorId: integer('author_id'),
    bookIds: text('book_ids', { mode: 'json' }).$type<number[]>(),
  },
  (t) => [
    index('release_decisions_batch_idx').on(t.batchId),
    index('release_decisions_item_idx').on(t.itemKey, t.time),
    index('release_decisions_series_idx').on(t.seriesId),
    index('release_decisions_movie_idx').on(t.movieId),
    index('release_decisions_time_idx').on(t.time),
  ],
);
