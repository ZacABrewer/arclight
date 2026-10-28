import { sqliteTable, text, index, primaryKey } from 'drizzle-orm/sqlite-core';

// Persistent metadata response cache (docs/design/music-audiobooks.md section 5.3). Sits behind
// the in-memory TTL cache so a restart does not cost a cold MusicBrainz crawl at 1 req/s.
// `provider` is e.g. `musicbrainz`, `coverart`, `audnexus`; `key` is the provider's request key
// (path + query). Rows are pruned by MetadataCacheCleanup 30 days after `expires_at`.

export const metadataCache = sqliteTable(
  'metadata_cache',
  {
    provider: text('provider').notNull(),
    key: text('key').notNull(),
    body: text('body', { mode: 'json' }).$type<unknown>().notNull(),
    etag: text('etag'),
    fetchedAt: text('fetched_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.key] }), index('metadata_cache_expires_idx').on(t.expiresAt)],
);

export type MetadataCacheRow = typeof metadataCache.$inferSelect;
