import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { TrackerAccountSettings } from '@arclight/shared';

// Tracker-stats module tables: per-indexer private-tracker settings and the statistics the
// TrackerStatsSync job gathers (built-in engine totals + scraped account page).

export const trackerAccounts = sqliteTable('tracker_accounts', {
  /** indexers.id (no FK: rows of deleted indexers are ignored and pruned by the sync). */
  indexerId: integer('indexer_id').primaryKey(),
  settings: text('settings', { mode: 'json' }).$type<TrackerAccountSettings>().notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const trackerStats = sqliteTable('tracker_stats', {
  /** indexers.id (no FK: rows of deleted indexers are ignored and pruned by the sync). */
  indexerId: integer('indexer_id').primaryKey(),
  hosts: text('hosts', { mode: 'json' }).$type<string[]>().notNull(),
  torrents: integer('torrents').notNull().default(0),
  seeding: integer('seeding').notNull().default(0),
  uploaded: integer('uploaded').notNull().default(0),
  downloaded: integer('downloaded').notNull().default(0),
  seedingTimeMs: integer('seeding_time_ms').notNull().default(0),
  hnrPending: integer('hnr_pending').notNull().default(0),
  engineUpdatedAt: text('engine_updated_at'),
  accountRatio: real('account_ratio'),
  accountUploaded: integer('account_uploaded'),
  accountDownloaded: integer('account_downloaded'),
  accountBuffer: integer('account_buffer'),
  accountHnrCount: integer('account_hnr_count'),
  accountSeedBonus: real('account_seed_bonus'),
  accountUpdatedAt: text('account_updated_at'),
  accountError: text('account_error'),
});

export type TrackerAccountRow = typeof trackerAccounts.$inferSelect;
export type TrackerStatsRow = typeof trackerStats.$inferSelect;
