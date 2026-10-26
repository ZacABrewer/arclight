import { sqliteTable, integer, real, text, index } from 'drizzle-orm/sqlite-core';
import type {
  TranscodeAction,
  TranscodeJobStatus,
  TranscodeJobTrigger,
  TranscodeMediaType,
  TranscodeOptions,
  TranscodeScope,
  TranscodeWhen,
  TranscodeWindow,
} from '@arclight/shared';

// Transcode module tables. Jobs point at media files and rules by id without foreign keys
// (same rule as media-analysis/history): a job whose file is gone fails when the worker meets
// it, and deleting a rule cancels its queued jobs and nulls `rule_id` on the rest.

export const transcodeRules = sqliteTable('transcode_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  mediaType: text('media_type').$type<TranscodeMediaType>().notNull(),
  scope: text('scope', { mode: 'json' }).$type<TranscodeScope>().notNull(),
  when: text('conditions', { mode: 'json' }).$type<TranscodeWhen>().notNull(),
  action: text('action').$type<TranscodeAction>().notNull(),
  options: text('options', { mode: 'json' }).$type<TranscodeOptions>().notNull(),
  keepOriginal: integer('keep_original', { mode: 'boolean' }).notNull().default(false),
  runAfterImport: integer('run_after_import', { mode: 'boolean' }).notNull().default(false),
  /** Null: any time. */
  schedule: text('schedule', { mode: 'json' }).$type<TranscodeWindow>(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const transcodeJobs = sqliteTable(
  'transcode_jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaFileId: integer('media_file_id').notNull(),
    ruleId: integer('rule_id'),
    trigger: text('trigger').$type<TranscodeJobTrigger>().notNull(),
    status: text('status').$type<TranscodeJobStatus>().notNull(),
    /** 0-100. */
    progress: real('progress').notNull().default(0),
    /** Source path when queued (display; the worker reads the current path from media_files). */
    path: text('path').notNull(),
    /** argv joined for display; empty until started. */
    command: text('command').notNull().default(''),
    message: text('message'),
    queuedAt: text('queued_at').notNull(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    sizeBefore: integer('size_before'),
    sizeAfter: integer('size_after'),
  },
  (t) => [index('transcode_jobs_status_idx').on(t.status), index('transcode_jobs_file_idx').on(t.mediaFileId)],
);

export type TranscodeRuleRow = typeof transcodeRules.$inferSelect;
export type TranscodeJobRow = typeof transcodeJobs.$inferSelect;
