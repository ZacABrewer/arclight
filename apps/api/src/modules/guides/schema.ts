import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { GuidesDiff, GuidesFetchStats } from '@arclight/shared';

// Guides module tables.

/**
 * HTTP cache for guide files and directory listings: the body plus the validators needed to
 * skip a download (`etag` for If-None-Match, `sha` = the git blob sha a GitHub listing
 * reports, so an unchanged file is not requested at all).
 */
export const guidesCache = sqliteTable('guides_cache', {
  url: text('url').primaryKey(),
  etag: text('etag'),
  sha: text('sha'),
  body: text('body').notNull(),
  fetchedAt: text('fetched_at').notNull(),
});

/** Sync bookkeeping; a single row (id = 1). */
export const guidesState = sqliteTable('guides_state', {
  id: integer('id').primaryKey(),
  lastSyncAt: text('last_sync_at'),
  lastSuccessAt: text('last_success_at'),
  lastError: text('last_error'),
  lastAppliedAt: text('last_applied_at'),
  /** Changes found by the last sync and not applied yet. */
  pendingDiff: text('pending_diff', { mode: 'json' }).$type<GuidesDiff>(),
  pendingSince: text('pending_since'),
  /** Revision last announced through a notification (so an unchanged diff is not re-sent). */
  notifiedRevision: text('notified_revision'),
  lastFetch: text('last_fetch', { mode: 'json' }).$type<GuidesFetchStats>(),
});
