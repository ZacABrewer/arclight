import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';

// Phase 0 tables only. Each module adds its own tables in later phases; they all live in
// this one file so drizzle-kit sees the whole schema.

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    }).notNull(),
    trigger: text('trigger', { enum: ['scheduled', 'manual', 'system'] }).notNull(),
    message: text('message'),
    queuedAt: text('queued_at').notNull(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
  },
  (t) => [index('jobs_status_idx').on(t.status), index('jobs_name_idx').on(t.name)],
);

export const scheduledJobs = sqliteTable('scheduled_jobs', {
  name: text('name').primaryKey(),
  interval: text('interval').notNull(),
  lastRun: text('last_run'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
});

// Module tables. Each module owns its file; this aggregate is what cross-module code imports.
export * from '../modules/profiles/schema.js';
export * from '../modules/library/schema.js';
export * from '../modules/music/schema.js';
export * from '../modules/audiobooks/schema.js';
export * from '../modules/metadata/schema.js';
export * from '../modules/indexers/schema.js';
export * from '../modules/download-clients/schema.js';
export * from '../modules/history/schema.js';
export * from '../modules/blocklist/schema.js';
export * from '../modules/releases/schema.js';
export * from '../modules/imports/schema.js';
export * from '../modules/notifications/schema.js';
export * from '../modules/summary/schema.js';
export * from '../modules/auth/schema.js';
export * from '../modules/import-lists/schema.js';
export * from '../modules/migrate/schema.js';
export * from '../modules/subtitles/schema.js';
export * from '../modules/requests/schema.js';
export * from '../modules/guides/schema.js';
export * from '../modules/retention/schema.js';
export * from '../modules/media-analysis/schema.js';
export * from '../modules/library-hygiene/schema.js';
export * from '../modules/health-scan/schema.js';
export * from '../modules/stats/schema.js';
export * from '../modules/push/schema.js';
export * from '../modules/audit/schema.js';
export * from '../modules/scene-mapping/schema.js';
export * from '../modules/tracker-stats/schema.js';
export * from '../modules/cross-seed/schema.js';
export * from '../modules/transcode/schema.js';
export * from '../modules/transfer-metrics/schema.js';
export * from '../modules/profile-migration/schema.js';
export * from '../modules/additional-languages/schema.js';
export * from '../modules/tag-rules/schema.js';
