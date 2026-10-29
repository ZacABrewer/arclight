import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AudibleRegion, AudioRequestKind, DiscoverSliderType, IssueStatus, IssueType, MediaStatus, MediaType, RequestStatus, WatchlistSource } from '@arclight/shared';

// Requests module tables. User ids are plain integers, not foreign keys: modules do not
// reference each other's tables, so rows of deleted users are removed by the service
// (`purgeOrphans`, run by RequestsStatusSync) instead of an ON DELETE CASCADE.

const bool = (name: string) => integer(name, { mode: 'boolean' }).notNull().default(false);

export const mediaRequests = sqliteTable(
  'media_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').$type<MediaType>().notNull(),
    status: text('status').$type<RequestStatus>().notNull(),
    is4k: bool('is_4k'),
    tmdbId: integer('tmdb_id').notNull(),
    tvdbId: integer('tvdb_id'),
    title: text('title').notNull(),
    year: integer('year'),
    poster: text('poster'),
    backdrop: text('backdrop'),
    requestedById: integer('requested_by_id').notNull(),
    modifiedById: integer('modified_by_id'),
    rootFolderPath: text('root_folder_path'),
    qualityProfileId: integer('quality_profile_id'),
    tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
    ignoreQuota: bool('ignore_quota'),
    isAutoRequest: bool('is_auto_request'),
    declineReason: text('decline_reason'),
    failureReason: text('failure_reason'),
    libraryId: integer('library_id'),
    /** Best approved release size found by the approval-policy estimate (bytes), when known. */
    estimatedSizeBytes: integer('estimated_size_bytes'),
    /** 'window': pending because an approval window holds it (RequestsPolicySweep re-checks). */
    policyHold: text('policy_hold').$type<'window'>(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('media_requests_media_idx').on(t.type, t.tmdbId),
    index('media_requests_user_idx').on(t.requestedById),
    index('media_requests_status_idx').on(t.status),
  ],
);

export const seasonRequests = sqliteTable(
  'season_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    requestId: integer('request_id')
      .notNull()
      .references(() => mediaRequests.id, { onDelete: 'cascade' }),
    seasonNumber: integer('season_number').notNull(),
    status: text('status').$type<RequestStatus>().notNull(),
  },
  (t) => [uniqueIndex('season_requests_request_season_idx').on(t.requestId, t.seasonNumber)],
);

export interface SeasonStatusEntry {
  seasonNumber: number;
  status: MediaStatus;
  status4k: MediaStatus;
}

/** Last computed availability per title (cache for the sync job's change detection). */
export const requestMediaStatus = sqliteTable(
  'request_media_status',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaType: text('media_type').$type<MediaType>().notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    status: text('status').$type<MediaStatus>().notNull(),
    status4k: text('status_4k').$type<MediaStatus>().notNull(),
    seasons: text('seasons', { mode: 'json' }).$type<SeasonStatusEntry[]>().notNull(),
    libraryId: integer('library_id'),
    /** Media server the normal track was found on (useMediaServerAvailability), else null. */
    availableOn: text('available_on'),
    lastSyncedAt: text('last_synced_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('request_media_status_media_idx').on(t.mediaType, t.tmdbId)],
);

export const issues = sqliteTable(
  'issues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').$type<IssueType>().notNull(),
    status: text('status').$type<IssueStatus>().notNull(),
    mediaType: text('media_type').$type<MediaType>().notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    poster: text('poster'),
    problemSeason: integer('problem_season').notNull().default(0),
    problemEpisode: integer('problem_episode').notNull().default(0),
    createdById: integer('created_by_id').notNull(),
    modifiedById: integer('modified_by_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('issues_media_idx').on(t.mediaType, t.tmdbId), index('issues_created_by_idx').on(t.createdById)],
);

export const issueComments = sqliteTable(
  'issue_comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    issueId: integer('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    userId: integer('user_id').notNull(),
    message: text('message').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('issue_comments_issue_idx').on(t.issueId)],
);

export const overrideRules = sqliteTable('override_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  mediaType: text('media_type').$type<MediaType>().notNull(),
  /** null: both tracks. */
  is4k: integer('is_4k', { mode: 'boolean' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  users: text('users', { mode: 'json' }).$type<number[]>().notNull(),
  genres: text('genres', { mode: 'json' }).$type<number[]>().notNull(),
  languages: text('languages', { mode: 'json' }).$type<string[]>().notNull(),
  keywords: text('keywords', { mode: 'json' }).$type<number[]>().notNull(),
  qualityProfileId: integer('quality_profile_id'),
  rootFolderPath: text('root_folder_path'),
  tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
  autoApprove: bool('auto_approve'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const discoverSliders = sqliteTable('discover_sliders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').$type<DiscoverSliderType>().notNull(),
  sortOrder: integer('sort_order').notNull(),
  isBuiltIn: bool('is_built_in'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  title: text('title'),
  data: text('data'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const watchlistItems = sqliteTable(
  'watchlist_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    mediaType: text('media_type').$type<MediaType>().notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    poster: text('poster'),
    source: text('source').$type<WatchlistSource>().notNull(),
    /** Plex ratingKey / Jellyfin item id for synced items. */
    externalId: text('external_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('watchlist_items_user_media_idx').on(t.userId, t.mediaType, t.tmdbId)],
);

/**
 * Music and audiobook requests, keyed on MusicBrainz ids (album = release group, artist) or
 * Audible ASINs (book, author) instead of TMDB ids. `library_id` is the artist/album/book/author
 * row once the approval added it.
 */
export const audioRequests = sqliteTable(
  'audio_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').$type<AudioRequestKind>().notNull(),
    status: text('status').$type<RequestStatus>().notNull(),
    foreignId: text('foreign_id').notNull(),
    /** Album: the artist MBID. Book: the primary author ASIN, when known. */
    parentForeignId: text('parent_foreign_id'),
    /** Audible marketplace (books, authors). */
    region: text('region').$type<AudibleRegion>(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    year: integer('year'),
    coverUrl: text('cover_url'),
    requestedById: integer('requested_by_id').notNull(),
    modifiedById: integer('modified_by_id'),
    declineReason: text('decline_reason'),
    failureReason: text('failure_reason'),
    libraryId: integer('library_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('audio_requests_item_idx').on(t.kind, t.foreignId),
    index('audio_requests_user_idx').on(t.requestedById),
    index('audio_requests_status_idx').on(t.status),
  ],
);
