import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  PodcastEnclosure,
  PodcastEpisodeStatus,
  PodcastPerson,
  PodcastStatus,
  PodcastSubscriptionSettings,
  PodcastSuggestionStatus,
  PodcastTranscript,
} from '@arclight/shared';
import { users } from '../auth/schema.js';

// Podcast tables (docs/using/podcasts.md): subscriptions, their episodes, and podcast
// suggestions from the request portal. Podcasts share nothing with music or audiobooks: no
// root_folders rows (the root lives in the `podcasts` settings section), no audio_files rows,
// no quality profiles.

export const podcasts = sqliteTable(
  'podcasts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    sortTitle: text('sort_title').notNull(),
    author: text('author'),
    description: text('description').notNull().default(''),
    /** The feed URL as given or as moved to (may embed credentials; never logged unmasked). */
    feedUrl: text('feed_url').notNull(),
    link: text('link'),
    imageUrl: text('image_url'),
    language: text('language'),
    categories: text('categories', { mode: 'json' }).$type<string[]>().notNull(),
    explicit: integer('explicit', { mode: 'boolean' }).notNull().default(false),
    feedType: text('feed_type', { enum: ['episodic', 'serial'] }).notNull().default('episodic'),
    podcastGuid: text('podcast_guid'),
    itunesId: integer('itunes_id'),
    podcastIndexId: integer('podcast_index_id'),
    funding: text('funding', { mode: 'json' }).$type<{ url: string; title: string }[]>().notNull(),
    path: text('path').notNull(),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    status: text('status').$type<PodcastStatus>().notNull().default('active'),
    lastError: text('last_error'),
    settings: text('settings', { mode: 'json' }).$type<PodcastSubscriptionSettings>().notNull(),
    tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
    /** Conditional GET validators from the last 200 answer. */
    etag: text('etag'),
    lastModified: text('last_modified'),
    ttlMinutes: integer('ttl_minutes'),
    added: text('added').notNull(),
    lastRefreshed: text('last_refreshed'),
    nextRefreshAt: text('next_refresh_at'),
  },
  (t) => [
    uniqueIndex('podcasts_feed_url_idx').on(t.feedUrl),
    index('podcasts_next_refresh_idx').on(t.nextRefreshAt),
    index('podcasts_guid_idx').on(t.podcastGuid),
  ],
);

export const podcastEpisodes = sqliteTable(
  'podcast_episodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    podcastId: integer('podcast_id')
      .notNull()
      .references(() => podcasts.id, { onDelete: 'cascade' }),
    /** `<guid>`, else the enclosure URL, else title + date. */
    guid: text('guid').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    publishedAt: text('published_at'),
    durationSeconds: integer('duration_seconds'),
    season: integer('season'),
    episodeNumber: integer('episode_number'),
    episodeType: text('episode_type', { enum: ['full', 'trailer', 'bonus'] }).notNull().default('full'),
    explicit: integer('explicit', { mode: 'boolean' }).notNull().default(false),
    imageUrl: text('image_url'),
    link: text('link'),
    enclosure: text('enclosure', { mode: 'json' }).$type<PodcastEnclosure | null>(),
    alternateEnclosures: text('alternate_enclosures', { mode: 'json' }).$type<PodcastEnclosure[]>().notNull(),
    chaptersUrl: text('chapters_url'),
    transcripts: text('transcripts', { mode: 'json' }).$type<PodcastTranscript[]>().notNull(),
    persons: text('persons', { mode: 'json' }).$type<PodcastPerson[]>().notNull(),
    status: text('status').$type<PodcastEpisodeStatus>().notNull().default('available'),
    path: text('path'),
    sizeBytes: integer('size_bytes'),
    downloadedAt: text('downloaded_at'),
    hasChapters: integer('has_chapters', { mode: 'boolean' }).notNull().default(false),
    transcriptFiles: text('transcript_files', { mode: 'json' }).$type<string[]>().notNull(),
    played: integer('played', { mode: 'boolean' }).notNull().default(false),
    playedAt: text('played_at'),
    playedSource: text('played_source', { enum: ['manual', 'mediaServer'] }),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    added: text('added').notNull(),
  },
  (t) => [
    uniqueIndex('podcast_episodes_guid_idx').on(t.podcastId, t.guid),
    index('podcast_episodes_status_idx').on(t.status),
    index('podcast_episodes_published_idx').on(t.publishedAt),
  ],
);

export const podcastSuggestions = sqliteTable(
  'podcast_suggestions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feedUrl: text('feed_url').notNull(),
    title: text('title').notNull(),
    author: text('author'),
    imageUrl: text('image_url'),
    itunesId: integer('itunes_id'),
    podcastIndexId: integer('podcast_index_id'),
    note: text('note'),
    status: text('status').$type<PodcastSuggestionStatus>().notNull().default('pending'),
    podcastId: integer('podcast_id').references(() => podcasts.id, { onDelete: 'set null' }),
    declineReason: text('decline_reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('podcast_suggestions_user_idx').on(t.userId), index('podcast_suggestions_status_idx').on(t.status)],
);

export type PodcastRow = typeof podcasts.$inferSelect;
export type PodcastEpisodeRowDb = typeof podcastEpisodes.$inferSelect;
export type PodcastSuggestionRow = typeof podcastSuggestions.$inferSelect;
