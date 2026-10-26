import { sqliteTable, integer, text, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  DownloadClientImplementation,
  MediaType,
  QueueItemClientStatus,
  QueueStatusMessage,
  ReleaseProtocol,
  TrackedDownloadState,
  TrackedDownloadStatus,
} from '@media-tron/shared';

// Download-clients module tables. Implementation settings are a JSON column: they are read
// and written whole and their shape depends on `implementation`.

export const downloadClients = sqliteTable('download_clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  implementation: text('implementation').$type<DownloadClientImplementation>().notNull(),
  enable: integer('enable', { mode: 'boolean' }).notNull().default(true),
  protocol: text('protocol').$type<ReleaseProtocol>().notNull(),
  priority: integer('priority').notNull().default(1),
  removeCompletedDownloads: integer('remove_completed_downloads', { mode: 'boolean' }).notNull().default(true),
  removeFailedDownloads: integer('remove_failed_downloads', { mode: 'boolean' }).notNull().default(true),
  tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
  /** Implementation settings including secrets, unmasked. */
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const remotePathMappings = sqliteTable(
  'remote_path_mappings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    host: text('host').notNull(),
    remotePath: text('remote_path').notNull(),
    localPath: text('local_path').notNull(),
  },
  (t) => [uniqueIndex('remote_path_mappings_host_remote_idx').on(t.host, t.remotePath)],
);

/** What the pipeline hands to `grab` so a pending grab can be retried later. */
export interface PendingGrabPayload {
  title: string;
  magnet?: string;
  /** Base64 of the .torrent file. */
  torrentFileBase64?: string;
  category?: string;
  isRecent: boolean;
  seedConfig?: { ratioLimit?: number; seedTimeLimitMinutes?: number };
  protocol: ReleaseProtocol;
  tags: number[];
  reason?: string;
}

export const trackedDownloads = sqliteTable(
  'tracked_downloads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    downloadId: text('download_id').notNull(),
    /** Null only for `pending` rows that have not been sent to a client yet. */
    clientId: integer('client_id').references(() => downloadClients.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    state: text('state').$type<TrackedDownloadState>().notNull(),
    trackedStatus: text('tracked_status').$type<TrackedDownloadStatus>().notNull().default('ok'),
    clientStatus: text('client_status').$type<QueueItemClientStatus>().notNull().default('unknown'),
    statusMessages: text('status_messages', { mode: 'json' }).$type<QueueStatusMessage[]>().notNull(),
    protocol: text('protocol').$type<ReleaseProtocol>().notNull(),
    category: text('category'),
    size: integer('size').notNull().default(0),
    sizeLeft: integer('size_left').notNull().default(0),
    progress: real('progress').notNull().default(0),
    etaMs: integer('eta_ms'),
    /** As the download client reports it; remote path mappings are applied on read. */
    outputPath: text('output_path'),
    canMoveFiles: integer('can_move_files', { mode: 'boolean' }).notNull().default(false),
    canBeRemoved: integer('can_be_removed', { mode: 'boolean' }).notNull().default(false),
    isReadOnly: integer('is_read_only', { mode: 'boolean' }).notNull().default(true),
    addedAt: text('added_at').notNull(),
    lastSeenAt: text('last_seen_at'),
    updatedAt: text('updated_at').notNull(),
    mediaType: text('media_type').$type<MediaType>(),
    seriesId: integer('series_id'),
    episodeIds: text('episode_ids', { mode: 'json' }).$type<number[]>(),
    movieId: integer('movie_id'),
    /** Opaque release snapshot the pipeline stores at grab time (for blocklist/history). */
    grabbedRelease: text('grabbed_release', { mode: 'json' }).$type<unknown>(),
    /** Present while state is `pending`: everything needed to retry the grab. */
    pendingGrab: text('pending_grab', { mode: 'json' }).$type<PendingGrabPayload>(),
  },
  (t) => [
    uniqueIndex('tracked_downloads_client_download_idx').on(t.clientId, t.downloadId),
    index('tracked_downloads_state_idx').on(t.state),
  ],
);

export type DownloadClientRow = typeof downloadClients.$inferSelect;
export type RemotePathMappingRow = typeof remotePathMappings.$inferSelect;
export type TrackedDownloadRow = typeof trackedDownloads.$inferSelect;
