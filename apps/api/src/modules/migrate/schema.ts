import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { MigrateApp, MigrateStagingArea } from '@arclight/shared';

// Migrate module tables.
//
// `migrate_imported` remembers which upstream row became which Arclight row, so a re-run
// skips what an earlier run already imported (and later areas can resolve references such
// as a series' quality profile). `instance` identifies the source installation (app + db
// path hash), `area` is a MigrateArea or an internal sub-key (`episodes`, `mediaFiles`).
//
// `migrate_staging` holds mapped data for modules that do not exist yet (subtitles,
// requests, unsupported download clients...). Consumers select their `area` where
// `consumed_at` is null and set it once imported. Payload shapes: @arclight/shared migrate.ts.

export const migrateImported = sqliteTable(
  'migrate_imported',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    instance: text('instance').notNull(),
    sourceApp: text('source_app').$type<MigrateApp>().notNull(),
    area: text('area').notNull(),
    sourceId: text('source_id').notNull(),
    targetId: integer('target_id'),
    importedAt: text('imported_at').notNull(),
  },
  (t) => [uniqueIndex('migrate_imported_key_idx').on(t.instance, t.area, t.sourceId), index('migrate_imported_area_idx').on(t.area)],
);

export const migrateStaging = sqliteTable(
  'migrate_staging',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    area: text('area').$type<MigrateStagingArea>().notNull(),
    sourceApp: text('source_app').$type<MigrateApp>().notNull(),
    sourceId: text('source_id').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    stagedAt: text('staged_at').notNull(),
    consumedAt: text('consumed_at'),
  },
  (t) => [uniqueIndex('migrate_staging_key_idx').on(t.area, t.sourceApp, t.sourceId), index('migrate_staging_area_idx').on(t.area, t.consumedAt)],
);

export type MigrateImportedRow = typeof migrateImported.$inferSelect;
export type MigrateStagingDbRow = typeof migrateStaging.$inferSelect;
