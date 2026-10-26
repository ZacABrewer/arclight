import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { MediaAnalysisStatus } from '@arclight/shared';

// Media analysis queue: one row per media file that was ever queued for ffprobe. No foreign
// key to media_files (same rule as history/subtitles): rows of deleted files are pruned when
// the AnalyzeMedia job meets them.

export const mediaAnalysisJobs = sqliteTable(
  'media_analysis_jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaFileId: integer('media_file_id').notNull(),
    status: text('status').$type<MediaAnalysisStatus>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    queuedAt: text('queued_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [uniqueIndex('media_analysis_jobs_file_idx').on(t.mediaFileId), index('media_analysis_jobs_status_idx').on(t.status)],
);

export type MediaAnalysisJobRow = typeof mediaAnalysisJobs.$inferSelect;
