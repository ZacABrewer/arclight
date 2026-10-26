import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { CrossSeedState } from '@arclight/shared';

// Cross-seed module tables. Ids of other modules' rows are plain integers (no FK): a cross-seed
// outlives the indexer or library file it came from, and the client keeps seeding it.

export const crossSeeds = sqliteTable(
  'cross_seeds',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** media_files.id the payload is (hard-linked from). */
    mediaFileId: integer('media_file_id'),
    /** indexers.id the .torrent came from. */
    indexerId: integer('indexer_id'),
    /** Lowercase hex v1 info-hash. */
    infoHash: text('info_hash').notNull(),
    title: text('title').notNull(),
    size: integer('size').notNull(),
    state: text('state').$type<CrossSeedState>().notNull(),
    message: text('message'),
    downloadClientId: integer('download_client_id'),
    savePath: text('save_path'),
    addedAt: text('added_at').notNull(),
  },
  (t) => [uniqueIndex('cross_seeds_info_hash_idx').on(t.infoHash), index('cross_seeds_media_file_idx').on(t.mediaFileId)],
);

/** When each media file was last searched (the scheduled search skips recent ones). */
export const crossSeedSearches = sqliteTable('cross_seed_searches', {
  mediaFileId: integer('media_file_id').primaryKey(),
  searchedAt: text('searched_at').notNull(),
  candidates: integer('candidates').notNull().default(0),
  added: integer('added').notNull().default(0),
});

export type CrossSeedRow = typeof crossSeeds.$inferSelect;
