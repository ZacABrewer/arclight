import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  HealthFileSource,
  HealthFindingData,
  HealthFindingStatus,
  HealthFindingType,
  HealthMediaType,
  HealthScanMode,
  HealthSeverity,
} from '@arclight/shared';

// Library health scan. No foreign keys to the library (same rule as hygiene / media analysis):
// rows of files that left the library are pruned by the next whole-library scan.

/**
 * One row per library file the scan has checked: what the file looked like then (size and
 * modified time), so a resumed or repeated scan skips files that did not change.
 */
export const healthScanFiles = sqliteTable(
  'health_scan_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').$type<HealthFileSource>().notNull(),
    fileId: integer('file_id').notNull(),
    path: text('path').notNull(),
    /** null when the file was missing at the check. */
    sizeBytes: integer('size_bytes'),
    mtimeMs: integer('mtime_ms'),
    /** Deep satisfies quick; quick does not satisfy a deep scan. */
    mode: text('mode').$type<HealthScanMode>().notNull(),
    checkedAt: text('checked_at').notNull(),
  },
  (t) => [uniqueIndex('health_scan_files_file_idx').on(t.source, t.fileId)],
);

/**
 * Findings. `key` is unique per problem: `media:12:truncated`, `album:4:trackGaps`,
 * `book:9:bookParts`. A finding that is no longer found becomes `fixed`; an ignored one stays
 * ignored while the file keeps the signature (size:mtime) it had when it was ignored.
 */
export const healthFindings = sqliteTable(
  'health_findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    type: text('type').$type<HealthFindingType>().notNull(),
    severity: text('severity').$type<HealthSeverity>().notNull(),
    status: text('status').$type<HealthFindingStatus>().notNull(),
    source: text('source').$type<HealthFileSource>(),
    fileId: integer('file_id'),
    mediaType: text('media_type').$type<HealthMediaType>().notNull(),
    path: text('path').notNull(),
    title: text('title').notNull(),
    seriesId: integer('series_id'),
    movieId: integer('movie_id'),
    artistId: integer('artist_id'),
    albumId: integer('album_id'),
    authorId: integer('author_id'),
    bookId: integer('book_id'),
    episodeIds: text('episode_ids', { mode: 'json' }).$type<number[]>().notNull(),
    details: text('details').notNull(),
    data: text('data', { mode: 'json' }).$type<HealthFindingData>().notNull(),
    /** `size:mtime` of the file when the finding was ignored. */
    ignoredSignature: text('ignored_signature'),
    firstSeen: text('first_seen').notNull(),
    lastChecked: text('last_checked').notNull(),
    fixedAt: text('fixed_at'),
  },
  (t) => [
    uniqueIndex('health_findings_key_idx').on(t.key),
    index('health_findings_status_idx').on(t.status),
    index('health_findings_file_idx').on(t.source, t.fileId),
  ],
);

export type HealthScanFileRow = typeof healthScanFiles.$inferSelect;
export type HealthFindingRow = typeof healthFindings.$inferSelect;
