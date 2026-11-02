import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { SmartCollectionCriteria, SmartCollectionMediaType, SmartCollectionSort } from '@arclight/shared';

// Collections module tables: the smart collection rules and, per collection and media server,
// the server-side collection Arclight keeps in sync (Leaving Soon uses the key `leavingSoon`,
// smart collections `smart:<id>`).

export const smartCollections = sqliteTable('smart_collections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  mediaType: text('media_type').$type<SmartCollectionMediaType>().notNull(),
  criteria: text('criteria', { mode: 'json' }).$type<SmartCollectionCriteria>().notNull(),
  sort: text('sort').$type<SmartCollectionSort>().notNull(),
  limit: integer('limit'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const collectionSyncs = sqliteTable(
  'collection_syncs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    collectionKey: text('collection_key').notNull(),
    serverId: text('server_id').notNull(),
    /** BoxSet id on the server; null until created. */
    remoteId: text('remote_id'),
    /** Name the collection was created with (a rename re-creates it under the new name). */
    name: text('name').notNull(),
    itemCount: integer('item_count').notNull().default(0),
    missing: integer('missing').notNull().default(0),
    lastSyncAt: text('last_sync_at'),
    lastError: text('last_error'),
  },
  (t) => [uniqueIndex('collection_syncs_key_server_idx').on(t.collectionKey, t.serverId)],
);

export type SmartCollectionRow = typeof smartCollections.$inferSelect;
export type CollectionSyncRow = typeof collectionSyncs.$inferSelect;
