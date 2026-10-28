import { sqliteTable, integer, text, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { DownloadItemPhase } from '@arclight/download-clients';
import type {
  DownloadClientImplementation,
  DownloadEventType,
  AnyMediaType,
  QueueItemLive,
  QueueItemStateCode,
  QueueSeverity,
  QueueItemClientStatus,
  QueueStatusMessage,
  ReleaseProtocol,
  TrackedDownloadState,
  TrackedDownloadStatus,
} from '@arclight/shared';

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
  /** Base64 of the .nzb document (usenet). */
  nzbBase64?: string;
  category?: string;
  isRecent: boolean;
  seedConfig?: { ratioLimit?: number; seedTimeLimitMinutes?: number };
  protocol: ReleaseProtocol;
  tags: number[];
  reason?: string;
  /** Set when the disk-space guard held the grab back; the HeldGrabs job retries it. */
  hold?: 'diskSpace';
  /** Client the grab was meant for (null/absent: picked again when it is sent). */
  clientId?: number;
  /** Release size, for the disk-space guard. */
  sizeBytes?: number;
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
    mediaType: text('media_type').$type<AnyMediaType>(),
    seriesId: integer('series_id'),
    episodeIds: text('episode_ids', { mode: 'json' }).$type<number[]>(),
    movieId: integer('movie_id'),
    /** Opaque release snapshot the pipeline stores at grab time (for blocklist/history). */
    grabbedRelease: text('grabbed_release', { mode: 'json' }).$type<unknown>(),
    /** Present while state is `pending`: everything needed to retry the grab. */
    pendingGrab: text('pending_grab', { mode: 'json' }).$type<PendingGrabPayload>(),
    /** Client-reported phase (metadata, checking, ...) as of the last poll. */
    phase: text('phase').$type<DownloadItemPhase>(),
    /** Rates and peer counts as of the last poll. */
    live: text('live', { mode: 'json' }).$type<QueueItemLive>(),
    /** Downloaded bytes as of the last poll; stall detection compares against it. */
    downloadedBytes: integer('downloaded_bytes'),
    /** Last time `downloadedBytes` grew (or the stall clock was reset by a pause). */
    progressAt: text('progress_at'),
    /** Set while stalled: when data stopped arriving. */
    stalledSince: text('stalled_since'),
    /** State code derived at the last poll; transitions between codes become timeline events. */
    stateCode: text('state_code').$type<QueueItemStateCode>(),
    /** Bytes missing on the save volume for this and its neighbours to finish (0 / null: fits). */
    diskShortfall: integer('disk_shortfall'),
    /** Stall recovery: when fresh peers were last asked for during the current stall. */
    reannouncedAt: text('reannounced_at'),
    /** Set while the disk-space guard holds this download paused (it resumes it later). */
    diskPausedAt: text('disk_paused_at'),
    // Audio targets (docs/design/music-audiobooks.md section 4.2); null on video rows.
    artistId: integer('artist_id'),
    albumIds: text('album_ids', { mode: 'json' }).$type<number[]>(),
    authorId: integer('author_id'),
    bookIds: text('book_ids', { mode: 'json' }).$type<number[]>(),
  },
  (t) => [
    uniqueIndex('tracked_downloads_client_download_idx').on(t.clientId, t.downloadId),
    index('tracked_downloads_state_idx').on(t.state),
  ],
);

/**
 * Timeline of a tracked download. Rows outlive the tracked download (no foreign key): the
 * timeline of a removed or imported download stays readable until the daily cleanup.
 */
export const downloadEvents = sqliteTable(
  'download_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trackedDownloadId: integer('tracked_download_id').notNull(),
    downloadId: text('download_id').notNull(),
    title: text('title').notNull(),
    type: text('type').$type<DownloadEventType>().notNull(),
    severity: text('severity').$type<QueueSeverity>().notNull(),
    message: text('message'),
    data: text('data', { mode: 'json' }).$type<Record<string, string | number | boolean>>(),
    time: text('time').notNull(),
  },
  (t) => [index('download_events_tracked_idx').on(t.trackedDownloadId, t.time), index('download_events_time_idx').on(t.time)],
);

export type DownloadClientRow = typeof downloadClients.$inferSelect;
export type RemotePathMappingRow = typeof remotePathMappings.$inferSelect;
export type TrackedDownloadRow = typeof trackedDownloads.$inferSelect;
export type DownloadEventRow = typeof downloadEvents.$inferSelect;
