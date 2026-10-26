import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import type { IndexerCapabilitiesResource, IndexerImplementation, IndexerSettings } from '@media-tron/shared';

// Indexers module tables. Settings and caps are JSON: always read and written whole.

export const indexers = sqliteTable('indexers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  implementation: text('implementation').$type<IndexerImplementation>().notNull(),
  enableRss: integer('enable_rss', { mode: 'boolean' }).notNull().default(true),
  enableAutomaticSearch: integer('enable_automatic_search', { mode: 'boolean' }).notNull().default(true),
  enableInteractiveSearch: integer('enable_interactive_search', { mode: 'boolean' }).notNull().default(true),
  priority: integer('priority').notNull().default(25),
  downloadClientId: integer('download_client_id'),
  tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
  settings: text('settings', { mode: 'json' }).$type<IndexerSettings>().notNull(),
  addedAt: text('added_at').notNull(),
});

/** One row per indexer that has failed at least once; escalating backoff lives here. */
export const indexerStatus = sqliteTable('indexer_status', {
  indexerId: integer('indexer_id')
    .primaryKey()
    .references(() => indexers.id, { onDelete: 'cascade' }),
  failureCount: integer('failure_count').notNull().default(0),
  initialFailure: text('initial_failure'),
  lastFailure: text('last_failure'),
  disabledTill: text('disabled_till'),
  mostRecentFailure: text('most_recent_failure'),
});

export const indexerCapsCache = sqliteTable('indexer_caps_cache', {
  indexerId: integer('indexer_id')
    .primaryKey()
    .references(() => indexers.id, { onDelete: 'cascade' }),
  caps: text('caps', { mode: 'json' }).$type<IndexerCapabilitiesResource>().notNull(),
  fetchedAt: text('fetched_at').notNull(),
});

/** RSS sync markers: newest publish date seen and the guids seen recently. */
export const indexerRssState = sqliteTable('indexer_rss_state', {
  indexerId: integer('indexer_id')
    .primaryKey()
    .references(() => indexers.id, { onDelete: 'cascade' }),
  lastGuid: text('last_guid'),
  lastPublishDate: text('last_publish_date'),
  recentGuids: text('recent_guids', { mode: 'json' }).$type<string[]>().notNull(),
  lastSyncAt: text('last_sync_at').notNull(),
});
