import { z } from 'zod';
import { MediaType } from './library.js';
import { ReleaseProtocol } from './profiles.js';

// Download client settings, remote path mappings and the queue contract.

// ---------------------------------------------------------------------------------------
// Download clients
// ---------------------------------------------------------------------------------------

/** Implementations Media-Tron can drive. Extend the enum and the settings union together. */
export const DownloadClientImplementation = z.enum(['qbittorrent']);
export type DownloadClientImplementation = z.infer<typeof DownloadClientImplementation>;

/**
 * Write-only secrets are never returned. Reads carry this mask instead; sending the mask
 * back on update keeps the stored value.
 */
export const PASSWORD_MASK = '********';

export const QBittorrentPriority = z.enum(['last', 'first']);
export const QBittorrentInitialState = z.enum(['start', 'pause', 'forceStart']);
export const QBittorrentContentLayout = z.enum(['default', 'original', 'subfolder', 'noSubfolder']);

export const QBittorrentClientSettings = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).default(8080),
  useSsl: z.boolean().default(false),
  urlBase: z.string().trim().optional(),
  username: z.string().default(''),
  password: z.string().default(''),
  category: z.string().trim().default('media-tron'),
  postImportCategory: z.string().trim().optional(),
  recentPriority: QBittorrentPriority.default('last'),
  olderPriority: QBittorrentPriority.default('last'),
  initialState: QBittorrentInitialState.default('start'),
  sequentialOrder: z.boolean().default(false),
  firstAndLast: z.boolean().default(false),
  contentLayout: QBittorrentContentLayout.default('default'),
});
export type QBittorrentClientSettings = z.infer<typeof QBittorrentClientSettings>;

const downloadClientCommon = {
  name: z.string().trim().min(1).max(100),
  enable: z.boolean().default(true),
  /** Derived from the implementation when omitted. */
  protocol: ReleaseProtocol.optional(),
  /** 1 is the highest priority. */
  priority: z.number().int().min(1).max(50).default(1),
  removeCompletedDownloads: z.boolean().default(true),
  removeFailedDownloads: z.boolean().default(true),
  tags: z.array(z.number().int()).default([]),
};

/** Create/update body. One variant per implementation, discriminated on `implementation`. */
export const DownloadClientInput = z.discriminatedUnion('implementation', [
  z.object({
    ...downloadClientCommon,
    implementation: z.literal('qbittorrent'),
    settings: QBittorrentClientSettings,
  }),
]);
export type DownloadClientInput = z.infer<typeof DownloadClientInput>;
export const DownloadClientCreate = DownloadClientInput;
export type DownloadClientCreate = DownloadClientInput;
export const DownloadClientUpdate = DownloadClientInput;
export type DownloadClientUpdate = DownloadClientInput;

export const DownloadClientResource = z.discriminatedUnion('implementation', [
  z.object({
    id: z.number().int(),
    ...downloadClientCommon,
    protocol: ReleaseProtocol,
    implementation: z.literal('qbittorrent'),
    settings: QBittorrentClientSettings,
  }),
]);
export type DownloadClientResource = z.infer<typeof DownloadClientResource>;

/** Body of POST /downloadclient/test: a candidate config, optionally of an existing row. */
export const DownloadClientTestRequest = z.discriminatedUnion('implementation', [
  z.object({
    id: z.number().int().optional(),
    ...downloadClientCommon,
    implementation: z.literal('qbittorrent'),
    settings: QBittorrentClientSettings,
  }),
]);
export type DownloadClientTestRequest = z.infer<typeof DownloadClientTestRequest>;

export const DownloadClientTestResult = z.object({
  ok: z.boolean(),
  version: z.string().optional(),
  apiVersion: z.string().optional(),
  warnings: z.array(z.string()),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type DownloadClientTestResult = z.infer<typeof DownloadClientTestResult>;

export const DownloadClientTestAllResult = z.array(
  DownloadClientTestResult.extend({ id: z.number().int(), name: z.string() }),
);
export type DownloadClientTestAllResult = z.infer<typeof DownloadClientTestAllResult>;

/** A field definition the UI renders for an implementation's settings form. */
export const DownloadClientField = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['text', 'number', 'password', 'checkbox', 'select']),
  helpText: z.string(),
  required: z.boolean(),
  advanced: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type DownloadClientField = z.infer<typeof DownloadClientField>;

export const DownloadClientImplementationSchema = z.object({
  implementation: DownloadClientImplementation,
  implementationName: z.string(),
  protocol: ReleaseProtocol,
  description: z.string(),
  infoLink: z.string().optional(),
  /** Fields of the common part (name, priority, ...) followed by implementation settings. */
  fields: z.array(DownloadClientField),
  /** A ready-to-edit template with every default filled in. */
  template: DownloadClientInput,
});
export type DownloadClientImplementationSchema = z.infer<typeof DownloadClientImplementationSchema>;

export const DownloadClientsErrorResponse = z.object({
  error: z.string(),
  code: z.string(),
});
export type DownloadClientsErrorResponse = z.infer<typeof DownloadClientsErrorResponse>;

// ---------------------------------------------------------------------------------------
// Remote path mappings
// ---------------------------------------------------------------------------------------

export const RemotePathMapping = z.object({
  id: z.number().int(),
  /** The download client's configured host this mapping applies to. */
  host: z.string(),
  /** Path prefix as the download client sees it (directory form). */
  remotePath: z.string(),
  /** The same directory as Media-Tron sees it (directory form). */
  localPath: z.string(),
});
export type RemotePathMapping = z.infer<typeof RemotePathMapping>;

export const RemotePathMappingInput = z.object({
  host: z.string().trim().min(1),
  remotePath: z.string().min(1),
  localPath: z.string().trim().min(1),
});
export type RemotePathMappingInput = z.infer<typeof RemotePathMappingInput>;

// ---------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------

export const TrackedDownloadState = z.enum([
  'pending',
  'downloading',
  'importPending',
  'importing',
  'imported',
  'failedPending',
  'failed',
  'ignored',
]);
export type TrackedDownloadState = z.infer<typeof TrackedDownloadState>;

/** States that are never shown in the queue and never re-processed. */
export const TERMINAL_TRACKED_STATES: readonly TrackedDownloadState[] = ['imported', 'failed', 'ignored'];

/** Status reported by the download client; `unknown` when it no longer reports the item. */
export const QueueItemClientStatus = z.enum([
  'queued',
  'downloading',
  'paused',
  'completed',
  'seeding',
  'failed',
  'warning',
  'unknown',
]);
export type QueueItemClientStatus = z.infer<typeof QueueItemClientStatus>;

export const TrackedDownloadStatus = z.enum(['ok', 'warning', 'error']);
export type TrackedDownloadStatus = z.infer<typeof TrackedDownloadStatus>;

export const QueueStatusMessage = z.object({
  title: z.string(),
  messages: z.array(z.string()),
});
export type QueueStatusMessage = z.infer<typeof QueueStatusMessage>;

export const QueueItem = z.object({
  id: z.number().int(),
  /** Client-side id (info-hash for torrents). `pending:*` while not yet sent to a client. */
  downloadId: z.string(),
  downloadClientId: z.number().int().nullable(),
  downloadClientName: z.string().nullable(),
  title: z.string(),
  status: QueueItemClientStatus,
  trackedStatus: TrackedDownloadStatus,
  statusMessages: z.array(QueueStatusMessage),
  protocol: ReleaseProtocol,
  sizeBytes: z.number().int(),
  sizeLeftBytes: z.number().int(),
  /** 0..1 */
  progress: z.number(),
  /** Milliseconds remaining as of the last poll. */
  eta: z.number().int().optional(),
  /** Local path of the content, remote path mappings applied. */
  outputPath: z.string().optional(),
  added: z.string(),
  trackedState: TrackedDownloadState,
  mediaType: MediaType.optional(),
  seriesId: z.number().int().optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
});
export type QueueItem = z.infer<typeof QueueItem>;

export const QueueSortKey = z.enum([
  'added',
  'title',
  'progress',
  'sizeBytes',
  'sizeLeftBytes',
  'status',
  'trackedState',
  'eta',
  'downloadClientName',
  'protocol',
]);
export type QueueSortKey = z.infer<typeof QueueSortKey>;

const queryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const QueueQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(20),
  sortKey: QueueSortKey.default('added'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  /** Include downloads that are not linked to a series or movie (not grabbed by Media-Tron). */
  includeUnknownMediaItems: queryBool.default(false),
  downloadClientId: z.coerce.number().int().optional(),
  protocol: ReleaseProtocol.optional(),
  trackedState: TrackedDownloadState.optional(),
  status: QueueItemClientStatus.optional(),
  mediaType: MediaType.optional(),
  seriesId: z.coerce.number().int().optional(),
  movieId: z.coerce.number().int().optional(),
});
export type QueueQuery = z.infer<typeof QueueQuery>;
export type QueueQueryInput = z.input<typeof QueueQuery>;

export const QueuePage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  sortKey: QueueSortKey,
  sortDirection: z.enum(['asc', 'desc']),
  totalRecords: z.number().int(),
  records: z.array(QueueItem),
});
export type QueuePage = z.infer<typeof QueuePage>;

export const QueueStatus = z.object({
  /** Queue items linked to a series or movie. */
  totalCount: z.number().int(),
  /** Number of items (known or unknown) whose tracked status is error. */
  errors: z.number().int(),
  /** Number of items (known or unknown) whose tracked status is warning. */
  warnings: z.number().int(),
  /** Queue items not linked to any series or movie. */
  unknownCount: z.number().int(),
});
export type QueueStatus = z.infer<typeof QueueStatus>;

export const QueueRemoveOptions = z.object({
  removeFromClient: queryBool.default(true),
  blocklist: queryBool.default(false),
  skipRedownload: queryBool.default(false),
});
export type QueueRemoveOptions = z.infer<typeof QueueRemoveOptions>;

export const QueueBulkRemoveRequest = QueueRemoveOptions.extend({
  ids: z.array(z.number().int()).min(1),
});
export type QueueBulkRemoveRequest = z.infer<typeof QueueBulkRemoveRequest>;

export const QueueRemoveResult = z.object({
  removed: z.array(z.number().int()),
  failed: z.array(z.object({ id: z.number().int(), error: z.string() })),
});
export type QueueRemoveResult = z.infer<typeof QueueRemoveResult>;
