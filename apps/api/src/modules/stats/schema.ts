import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Daily storage snapshots (StatsSnapshot job), one row per root folder per day. They feed the
// growth figures of GET /stats/storage. Root folders are referenced by path (no foreign key) so
// history survives a root folder being removed and re-added.

export const statsSnapshots = sqliteTable(
  'stats_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** YYYY-MM-DD (UTC). */
    date: text('date').notNull(),
    rootFolderPath: text('root_folder_path').notNull(),
    totalBytes: integer('total_bytes'),
    freeBytes: integer('free_bytes'),
    usedBytes: integer('used_bytes').notNull(),
    fileCount: integer('file_count').notNull(),
    takenAt: text('taken_at').notNull(),
  },
  (t) => [uniqueIndex('stats_snapshots_date_root_idx').on(t.date, t.rootFolderPath)],
);

export type StatsSnapshotRow = typeof statsSnapshots.$inferSelect;
