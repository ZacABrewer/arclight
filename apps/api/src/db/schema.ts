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
