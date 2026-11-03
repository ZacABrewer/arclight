import { sqliteTable, integer, text, real, blob, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { mediaFiles, series } from '../library/schema.js';

// Intro and credits detection (segments.ts): audio fingerprints per file, the season scans, the
// stored segments (fingerprint and manual) and the per-file manual overrides.

/** Fingerprint codes of a file's head (intro window) or tail (credits window). */
export const videoFingerprints = sqliteTable(
  'video_fingerprints',
  {
    mediaFileId: integer('media_file_id')
      .notNull()
      .references(() => mediaFiles.id, { onDelete: 'cascade' }),
    part: text('part', { enum: ['head', 'tail'] }).notNull(),
    /** fileStamp (size-mtime) of the file the codes were taken from. */
    fileStamp: text('file_stamp').notNull(),
    /** Milliseconds per code. */
    frameMs: real('frame_ms').notNull(),
    /** Where the window starts in the file. */
    startMs: integer('start_ms').notNull().default(0),
    /** How long the window is (null on rows from before 0.23.0: never reused). */
    lengthMs: integer('length_ms'),
    /** uint32 little-endian codes. */
    hashes: blob('hashes', { mode: 'buffer' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.mediaFileId, t.part] })],
);

/** One row per season that was scanned; `stamp` hashes the member files' stamps. */
export const videoSegmentScans = sqliteTable(
  'video_segment_scans',
  {
    seriesId: integer('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    seasonNumber: integer('season_number').notNull(),
    stamp: text('stamp'),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] }).notNull(),
    error: text('error'),
    scannedAt: text('scanned_at'),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.seasonNumber] })],
);

/** Detected (fingerprint) and manual segments. Chapter segments are read from the file, not stored. */
export const videoSegments = sqliteTable(
  'video_segments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaFileId: integer('media_file_id')
      .notNull()
      .references(() => mediaFiles.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['intro', 'credits', 'recap'] }).notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    source: text('source', { enum: ['fingerprint', 'manual'] }).notNull(),
    confidence: real('confidence'),
    fileStamp: text('file_stamp'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('video_segments_file_idx').on(t.mediaFileId)],
);

/** Present: the file's segments are exactly its manual rows (none = detection suppressed). */
export const videoSegmentOverrides = sqliteTable('video_segment_overrides', {
  mediaFileId: integer('media_file_id')
    .primaryKey()
    .references(() => mediaFiles.id, { onDelete: 'cascade' }),
  updatedAt: text('updated_at').notNull(),
});
