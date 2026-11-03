import { sqliteTable, integer, text, index, primaryKey } from 'drizzle-orm/sqlite-core';

// Tag sync tables. Media servers live in settings (no foreign keys): rows of a deleted server
// are pruned by the service.

/**
 * Every tag Arclight wrote to a media-server item (`label` is the exact text, prefix included).
 * Arclight only removes a tag that has a row here. `preexisting`: the item already had the tag
 * when Arclight wanted to add it (a user set it on the server), so it is never removed.
 */
export const mediaServerTagSyncs = sqliteTable(
  'media_server_tag_syncs',
  {
    serverId: text('server_id').notNull(),
    entityType: text('entity_type', { enum: ['movie', 'series'] }).notNull(),
    entityId: integer('entity_id').notNull(),
    remoteItemId: text('remote_item_id').notNull(),
    label: text('label').notNull(),
    preexisting: integer('preexisting', { mode: 'boolean' }).notNull().default(false),
    /** Unix milliseconds. */
    addedAt: integer('added_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.remoteItemId, t.label] }), index('media_server_tag_syncs_entity_idx').on(t.serverId, t.entityType, t.entityId)],
);

/**
 * Items whose `Tags` lock (Jellyfin/Emby LockedFields) Arclight added: the field was not locked
 * when Arclight's write locked it. Turning sync off with Remove takes the lock off these items
 * only; a lock that was there before (set by a user) is never touched.
 */
export const mediaServerTagLocks = sqliteTable(
  'media_server_tag_locks',
  {
    serverId: text('server_id').notNull(),
    remoteItemId: text('remote_item_id').notNull(),
    /** Unix milliseconds. */
    addedAt: integer('added_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.remoteItemId] })],
);

/** The last run per server (the status line). */
export const mediaServerTagSyncState = sqliteTable('media_server_tag_sync_state', {
  serverId: text('server_id').primaryKey(),
  lastRunAt: text('last_run_at'),
  lastChanged: integer('last_changed').notNull().default(0),
  lastUnmatched: integer('last_unmatched').notNull().default(0),
  lastError: text('last_error'),
});

export type MediaServerTagSyncRow = typeof mediaServerTagSyncs.$inferSelect;
