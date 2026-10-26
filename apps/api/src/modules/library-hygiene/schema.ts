import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import type { DuplicateReason, HygieneFindingType, HygieneParsedGuess, HygieneSuggestion } from '@arclight/shared';

// Library hygiene findings from the last OrphanScan. The table is replaced wholesale on every
// scan; rows are also removed one by one when the user maps or deletes them. No foreign keys
// (findings are a snapshot; a stale mediaFileId is checked at action time).

export const libraryHygieneFindings = sqliteTable(
  'library_hygiene_findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').$type<HygieneFindingType>().notNull(),
    path: text('path').notNull(),
    rootFolderPath: text('root_folder_path').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    mediaFileId: integer('media_file_id'),
    seriesId: integer('series_id'),
    movieId: integer('movie_id'),
    duplicateReason: text('duplicate_reason').$type<DuplicateReason>(),
    duplicateOf: text('duplicate_of', { mode: 'json' }).$type<string[]>().notNull(),
    parsed: text('parsed', { mode: 'json' }).$type<HygieneParsedGuess>(),
    suggestions: text('suggestions', { mode: 'json' }).$type<HygieneSuggestion[]>().notNull(),
    foundAt: text('found_at').notNull(),
  },
  (t) => [index('library_hygiene_findings_type_idx').on(t.type)],
);

export type HygieneFindingRow = typeof libraryHygieneFindings.$inferSelect;
