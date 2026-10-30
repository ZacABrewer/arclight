import { z } from 'zod';
import { CustomFormatSpec, LanguageCode, QualityProfileItem, ReleaseProtocol } from './profiles.js';
import { IndexerImplementation, IndexerProxyType, IndexerSettings } from './indexers.js';
import { DownloadClientImplementation } from './download-clients.js';
import { NotificationImplementation } from './notifications.js';
import { ListSearchParam } from './list-search.js';
import { ImportListImplementation, ImportListMediaType } from './import-lists.js';
import { MinimumAvailability, MonitorOption, SeriesType } from './library.js';
import { LanguageProfileItem } from './subtitles.js';

// Operations contract: config as code (export/import/validate, managed keys), metrics and the
// audit log. See docs/OPERATIONS.md.

// ---------------------------------------------------------------------------------------
// settings sections owned by the operations modules
// ---------------------------------------------------------------------------------------

/** `metrics` settings section. */
export const MetricsSettings = z.object({
  /** Serve GET /metrics without credentials (for Prometheus scrapers without an API key). */
  allowAnonymous: z.boolean().default(false),
});
export type MetricsSettings = z.infer<typeof MetricsSettings>;

/** `audit` settings section. */
export const AuditSettings = z.object({
  enabled: z.boolean().default(true),
  /** Events older than this are deleted by the daily AuditCleanup job; 0 keeps them forever. */
  retentionDays: z.number().int().min(0).max(3650).default(90),
});
export type AuditSettings = z.infer<typeof AuditSettings>;

// ---------------------------------------------------------------------------------------
// config document (version 1)
// ---------------------------------------------------------------------------------------

/** Tags are referenced by label everywhere in the document. */
const TagLabels = z.array(z.string().min(1)).default([]);

export const ConfigQualityProfile = z.object({
  upgradeAllowed: z.boolean().default(true),
  cutoff: z.number().int().min(0),
  items: z.array(QualityProfileItem).min(1),
  minFormatScore: z.number().int().default(0),
  cutoffFormatScore: z.number().int().default(0),
  minUpgradeFormatScore: z.number().int().min(1).default(1),
  /** Custom formats by name. */
  formatItems: z.array(z.object({ format: z.string().min(1), score: z.number().int() })).default([]),
  languages: z.array(LanguageCode).default([]),
});
export type ConfigQualityProfile = z.infer<typeof ConfigQualityProfile>;

export const ConfigCustomFormat = z.object({
  includeWhenRenaming: z.boolean().default(false),
  specifications: z.array(CustomFormatSpec).default([]),
});
export type ConfigCustomFormat = z.infer<typeof ConfigCustomFormat>;

export const ConfigDelayProfile = z.object({
  order: z.number().int(),
  tags: TagLabels,
  preferredProtocol: ReleaseProtocol.default('usenet'),
  usenetDelayMinutes: z.number().int().min(0).default(0),
  torrentDelayMinutes: z.number().int().min(0).default(0),
  bypassIfHighestQuality: z.boolean().default(false),
  bypassIfAboveCustomFormatScore: z.boolean().default(false),
  minimumCustomFormatScore: z.number().int().default(0),
});
export type ConfigDelayProfile = z.infer<typeof ConfigDelayProfile>;

export const ConfigReleaseProfile = z.object({
  enabled: z.boolean().default(true),
  required: z.array(z.string()).default([]),
  ignored: z.array(z.string()).default([]),
  /** Indexer by name; null applies to every indexer. */
  indexer: z.string().nullable().default(null),
  tags: TagLabels,
});
export type ConfigReleaseProfile = z.infer<typeof ConfigReleaseProfile>;

export const ConfigIndexerProxy = z.object({
  type: IndexerProxyType,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().nullable().default(null),
  password: z.string().nullable().default(null),
  requestTimeout: z.number().int().min(0).nullable().default(null),
  tags: TagLabels,
});
export type ConfigIndexerProxy = z.infer<typeof ConfigIndexerProxy>;

export const ConfigIndexer = z.object({
  implementation: IndexerImplementation,
  enableRss: z.boolean().default(true),
  enableAutomaticSearch: z.boolean().default(true),
  enableInteractiveSearch: z.boolean().default(true),
  priority: z.number().int().default(25),
  /** Download client by name. */
  downloadClient: z.string().nullable().default(null),
  /** Indexer proxy by name. */
  proxy: z.string().nullable().default(null),
  tags: TagLabels,
  settings: IndexerSettings,
});
export type ConfigIndexer = z.infer<typeof ConfigIndexer>;

export const ConfigDownloadClient = z.object({
  implementation: DownloadClientImplementation,
  enable: z.boolean().default(true),
  protocol: ReleaseProtocol,
  priority: z.number().int().default(1),
  removeCompletedDownloads: z.boolean().default(true),
  removeFailedDownloads: z.boolean().default(true),
  tags: TagLabels,
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type ConfigDownloadClient = z.infer<typeof ConfigDownloadClient>;

export const ConfigRemotePathMapping = z.object({
  host: z.string().min(1),
  remotePath: z.string().min(1),
  localPath: z.string().min(1),
});
export type ConfigRemotePathMapping = z.infer<typeof ConfigRemotePathMapping>;

export const ConfigRootFolder = z.object({ mediaType: z.enum(['series', 'movie', 'music', 'audiobook']) });
export type ConfigRootFolder = z.infer<typeof ConfigRootFolder>;

const flag = z.boolean().default(false);
export const ConfigNotification = z.object({
  implementation: NotificationImplementation,
  enabled: z.boolean().default(true),
  onGrab: flag,
  onDownload: flag,
  onUpgrade: flag,
  onRename: flag,
  onSeriesAdd: flag,
  onMovieAdd: flag,
  onSeriesDelete: flag,
  onMovieDelete: flag,
  onFileDelete: flag,
  onHealthIssue: flag,
  onHealthRestored: flag,
  onApplicationUpdate: flag,
  onManualInteractionRequired: flag,
  onRequestCreated: flag,
  onRequestApproved: flag,
  onRequestDeclined: flag,
  onRequestAvailable: flag,
  onIssueCreated: flag,
  onIssueUpdated: flag,
  includeHealthWarnings: flag,
  tags: TagLabels,
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type ConfigNotification = z.infer<typeof ConfigNotification>;

export const ConfigImportList = z.object({
  implementation: ImportListImplementation,
  enabled: z.boolean().default(true),
  enableAutomaticAdd: z.boolean().default(true),
  searchOnAdd: z.boolean().default(false),
  monitorOption: MonitorOption.default('all'),
  seriesType: SeriesType.default('standard'),
  seasonFolder: z.boolean().default(true),
  rootFolderPath: z.string().min(1),
  movieRootFolderPath: z.string().nullable().default(null),
  /** Quality profile by name. */
  qualityProfile: z.string().min(1),
  tags: TagLabels,
  minimumAvailability: MinimumAvailability.default('released'),
  mediaType: ImportListMediaType,
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type ConfigImportList = z.infer<typeof ConfigImportList>;

export const ConfigLanguageProfile = z.object({
  languages: z.array(LanguageProfileItem).min(1),
  cutoff: z.string().nullable().default(null),
  mustContain: z.array(z.string()).default([]),
  mustNotContain: z.array(z.string()).default([]),
  originalFormat: z.boolean().default(false),
});
export type ConfigLanguageProfile = z.infer<typeof ConfigLanguageProfile>;

/** Resource collections in a config document, keyed by stable name. */
export const ConfigResourceKind = z.enum([
  'tags',
  'customFormats',
  'qualityProfiles',
  'delayProfiles',
  'releaseProfiles',
  'downloadClients',
  'indexerProxies',
  'indexers',
  'remotePathMappings',
  'rootFolders',
  'notifications',
  'importLists',
  'languageProfiles',
]);
export type ConfigResourceKind = z.infer<typeof ConfigResourceKind>;

/**
 * The whole document. Every collection is optional: a document only manages what it lists, and
 * `prune` only ever deletes inside collections that are present. Entries are validated per kind
 * by the importer (so one bad entry reports a precise path instead of failing the whole parse).
 */
export const ConfigDocument = z
  .object({
    version: z.literal(1).default(1),
    /** Delete resources missing from the present collections (import/managed file). */
    prune: z.boolean().optional(),
    settings: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    tags: z.array(z.string().min(1)).optional(),
    customFormats: z.record(z.string(), z.unknown()).optional(),
    qualityProfiles: z.record(z.string(), z.unknown()).optional(),
    delayProfiles: z.record(z.string(), z.unknown()).optional(),
    releaseProfiles: z.record(z.string(), z.unknown()).optional(),
    downloadClients: z.record(z.string(), z.unknown()).optional(),
    indexerProxies: z.record(z.string(), z.unknown()).optional(),
    indexers: z.record(z.string(), z.unknown()).optional(),
    remotePathMappings: z.record(z.string(), z.unknown()).optional(),
    rootFolders: z.record(z.string(), z.unknown()).optional(),
    notifications: z.record(z.string(), z.unknown()).optional(),
    importLists: z.record(z.string(), z.unknown()).optional(),
    languageProfiles: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ConfigDocument = z.infer<typeof ConfigDocument>;

export const ConfigExportQuery = z.object({
  format: z.enum(['yaml', 'json']).default('yaml'),
  /** Requires an admin and the header `X-Confirm: export-secrets`. */
  includeSecrets: z.preprocess((v) => v === true || v === 'true' || v === '1', z.boolean()).default(false),
});
export type ConfigExportQuery = z.infer<typeof ConfigExportQuery>;

/** POST /config/import and /config/validate. Give `document` (parsed) or `content` (YAML or JSON text). */
export const ConfigImportRequest = z.object({
  document: z.record(z.string(), z.unknown()).optional(),
  content: z.string().optional(),
  dryRun: z.boolean().default(false),
  /** Overrides the document's own `prune`. */
  prune: z.boolean().optional(),
});
export type ConfigImportRequest = z.infer<typeof ConfigImportRequest>;

export const ConfigIssue = z.object({ path: z.string(), message: z.string() });
export type ConfigIssue = z.infer<typeof ConfigIssue>;

export const ConfigFieldChange = z.object({ path: z.string(), before: z.unknown(), after: z.unknown() });
export type ConfigFieldChange = z.infer<typeof ConfigFieldChange>;

export const ConfigChange = z.object({
  /** `settings` or a resource kind. */
  kind: z.string(),
  /** Section name or resource key. */
  key: z.string(),
  op: z.enum(['create', 'update', 'delete']),
  /** For updates: changed fields; secrets are masked. */
  fields: z.array(ConfigFieldChange).optional(),
});
export type ConfigChange = z.infer<typeof ConfigChange>;

export const ConfigImportResult = z.object({
  dryRun: z.boolean(),
  /** True when the changes were written. */
  applied: z.boolean(),
  changes: z.array(ConfigChange),
  summary: z.object({
    create: z.number().int(),
    update: z.number().int(),
    delete: z.number().int(),
    unchanged: z.number().int(),
  }),
  errors: z.array(ConfigIssue),
  warnings: z.array(ConfigIssue),
});
export type ConfigImportResult = z.infer<typeof ConfigImportResult>;

export const ConfigValidateResult = z.object({
  valid: z.boolean(),
  errors: z.array(ConfigIssue),
  warnings: z.array(ConfigIssue),
});
export type ConfigValidateResult = z.infer<typeof ConfigValidateResult>;

/** GET /config/managed-keys: what the config file / env overrides own (the UI locks these). */
export const ConfigManagedKeys = z.object({
  /** Path of the applied ARCLIGHT_CONFIG_FILE, or null. */
  file: z.string().nullable(),
  appliedAt: z.string().nullable(),
  /** Settings keys per section (top-level keys; env overrides may add dotted nested keys). */
  settings: z.record(z.string(), z.array(z.string())),
  /** Resource keys per kind. */
  resources: z.record(z.string(), z.array(z.string())),
  /** ARCLIGHT_SETTING__* variables that were applied. */
  env: z.array(z.string()),
  errors: z.array(ConfigIssue),
});
export type ConfigManagedKeys = z.infer<typeof ConfigManagedKeys>;

// ---------------------------------------------------------------------------------------
// audit log
// ---------------------------------------------------------------------------------------

export const AuditEvent = z.object({
  id: z.number().int(),
  time: z.string(),
  userId: z.number().int().nullable(),
  username: z.string().nullable(),
  ip: z.string().nullable(),
  /** Dotted action name, e.g. `settings.update`, `series.delete`, `login.failed`. */
  action: z.string(),
  target: z.string().nullable(),
  method: z.string().nullable(),
  route: z.string().nullable(),
  statusCode: z.number().int().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(50),
  /** Username (case-insensitive) or numeric user id. */
  user: z.string().optional(),
  /** Exact action, or a prefix: `settings` matches `settings.update`. */
  action: z.string().optional(),
  /** ISO-8601, inclusive. */
  from: z.string().optional(),
  /** ISO-8601, exclusive. */
  to: z.string().optional(),
  /** Text search (list-search.ts) over user, action, target and details: every word must match. */
  q: ListSearchParam,
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(AuditEvent),
});
export type AuditPage = z.infer<typeof AuditPage>;
