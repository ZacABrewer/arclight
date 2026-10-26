import { z } from 'zod';

// Adoption importer contract: read an existing Sonarr / Radarr / Prowlarr / Bazarr / Seerr
// installation (its SQLite database plus config file) and populate Arclight from it.
// `POST /migrate/plan` analyses without writing; `POST /migrate/apply` runs the import as a
// background job whose progress is served by `GET /migrate/status`.

export const MigrateApp = z.enum(['sonarr', 'radarr', 'prowlarr', 'bazarr', 'seerr']);
export type MigrateApp = z.infer<typeof MigrateApp>;

/** Rewrites a path prefix seen by the old app (`from`) to the one Arclight sees (`to`). */
export const MigratePathMapping = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type MigratePathMapping = z.infer<typeof MigratePathMapping>;

export const MigrateSource = z.object({
  app: MigrateApp,
  /** The app's SQLite database (sonarr.db, radarr.db, prowlarr.db, bazarr.db, db.sqlite3). */
  dbPath: z.string().trim().min(1),
  /** config.xml (arr apps), config.yaml / config.ini (Bazarr) or settings.json (Seerr). */
  configPath: z.string().trim().min(1).optional(),
  pathMappings: z.array(MigratePathMapping).default([]),
});
export type MigrateSource = z.infer<typeof MigrateSource>;
export type MigrateSourceInput = z.input<typeof MigrateSource>;

/**
 * Importable areas. Not every app has every area; a plan lists only the ones its source has.
 * Subtitle, request, user and a few infrastructure areas are staged (see MigrateStagingArea)
 * for modules that import them when they land.
 */
export const MigrateArea = z.enum([
  'tags',
  'rootFolders',
  'customFormats',
  'qualityProfiles',
  'delayProfiles',
  'releaseProfiles',
  'indexers',
  'indexerProxies',
  'applications',
  'downloadClients',
  'remotePathMappings',
  'notifications',
  'importLists',
  'naming',
  'mediaManagement',
  'series',
  'movies',
  'collections',
  'history',
  'blocklist',
  'subtitleProfiles',
  'subtitleProviders',
  'subtitleHistory',
  'users',
  'requests',
  'issues',
  'requestSettings',
]);
export type MigrateArea = z.infer<typeof MigrateArea>;

export const MigrateConflictPolicy = z.enum(['skip', 'overwrite']);
export type MigrateConflictPolicy = z.infer<typeof MigrateConflictPolicy>;

/** What happens to an area on apply: written to Arclight, staged for a later module, or only reported. */
export const MigrateAreaMode = z.enum(['import', 'stage', 'report']);
export type MigrateAreaMode = z.infer<typeof MigrateAreaMode>;

export const MigrationWarning = z.object({
  area: MigrateArea,
  message: z.string(),
  sourceId: z.string().optional(),
});
export type MigrationWarning = z.infer<typeof MigrationWarning>;

export const MigrationConflict = z.object({
  area: MigrateArea,
  sourceId: z.string(),
  name: z.string(),
  existingId: z.number().int().nullable(),
  reason: z.string(),
});
export type MigrationConflict = z.infer<typeof MigrationConflict>;

export const MigrationUnsupported = z.object({
  area: MigrateArea,
  sourceId: z.string(),
  name: z.string(),
  reason: z.string(),
});
export type MigrationUnsupported = z.infer<typeof MigrationUnsupported>;

export const MigrationAreaPlan = z.object({
  area: MigrateArea,
  label: z.string(),
  mode: MigrateAreaMode,
  /** Rows found in the source. */
  total: z.number().int().min(0),
  /** Rows that would be created (no conflict, supported, not imported before). */
  create: z.number().int().min(0),
  /** Rows matching existing Arclight data (skipped or overwritten per policy). */
  conflicts: z.number().int().min(0),
  /** Rows already imported by an earlier run (always skipped). */
  alreadyImported: z.number().int().min(0),
  unsupported: z.number().int().min(0),
  /** Sub-entities carried along, e.g. `{ episodes: 120, files: 80 }`. */
  details: z.record(z.string(), z.number().int()),
});
export type MigrationAreaPlan = z.infer<typeof MigrationAreaPlan>;

export const MigrationPlan = z.object({
  source: MigrateSource,
  app: MigrateApp,
  /** Upstream schema version (VersionInfo / alembic) when readable. */
  schemaVersion: z.string().nullable(),
  areas: z.array(MigrationAreaPlan),
  warnings: z.array(MigrationWarning),
  conflicts: z.array(MigrationConflict),
  unsupported: z.array(MigrationUnsupported),
  createdAt: z.string(),
});
export type MigrationPlan = z.infer<typeof MigrationPlan>;

export const MigratePlanRequest = MigrateSource;
export type MigratePlanRequest = z.input<typeof MigratePlanRequest>;

export const MigrateApplyOptions = z.object({
  /** Areas to import; empty means every area in the plan. */
  areas: z.array(MigrateArea).default([]),
  conflictPolicy: MigrateConflictPolicy.default('skip'),
  /** Run every area inside a transaction that is rolled back; reports what would happen. */
  dryRun: z.boolean().default(false),
});
export type MigrateApplyOptions = z.infer<typeof MigrateApplyOptions>;
export type MigrateApplyOptionsInput = z.input<typeof MigrateApplyOptions>;

export const MigrateApplyRequest = MigrateApplyOptions.extend({ source: MigrateSource });
export type MigrateApplyRequest = z.input<typeof MigrateApplyRequest>;

export const MigrationAreaResult = z.object({
  area: MigrateArea,
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  skipped: z.number().int().min(0),
  staged: z.number().int().min(0),
  failed: z.number().int().min(0),
});
export type MigrationAreaResult = z.infer<typeof MigrationAreaResult>;

export const MigrationLogEntry = z.object({
  time: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  area: MigrateArea.nullable(),
  message: z.string(),
});
export type MigrationLogEntry = z.infer<typeof MigrationLogEntry>;

export const MigrationResult = z.object({
  app: MigrateApp,
  dryRun: z.boolean(),
  areas: z.array(MigrationAreaResult),
  warnings: z.array(MigrationWarning),
  startedAt: z.string(),
  endedAt: z.string(),
});
export type MigrationResult = z.infer<typeof MigrationResult>;

export const MigrateRunState = z.enum(['idle', 'running', 'completed', 'failed']);
export type MigrateRunState = z.infer<typeof MigrateRunState>;

export const MigrateProgress = z.object({
  area: MigrateArea,
  done: z.number().int(),
  total: z.number().int(),
  areaIndex: z.number().int(),
  areaCount: z.number().int(),
});
export type MigrateProgress = z.infer<typeof MigrateProgress>;

export const MigrateStatus = z.object({
  state: MigrateRunState,
  app: MigrateApp.nullable(),
  jobId: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  progress: MigrateProgress.nullable(),
  log: z.array(MigrationLogEntry),
  result: MigrationResult.nullable(),
  error: z.string().nullable(),
});
export type MigrateStatus = z.infer<typeof MigrateStatus>;

export const MigrateSourceCandidate = z.object({
  app: MigrateApp,
  dbPath: z.string(),
  configPath: z.string().nullable(),
  /** Where the guess came from, e.g. `container mount` or `Windows ProgramData`. */
  origin: z.string(),
});
export type MigrateSourceCandidate = z.infer<typeof MigrateSourceCandidate>;

export const MigrateSourcesResponse = z.array(MigrateSourceCandidate);
export type MigrateSourcesResponse = z.infer<typeof MigrateSourcesResponse>;

export const MigrateErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type MigrateErrorResponse = z.infer<typeof MigrateErrorResponse>;

// ---------------------------------------------------------------------------------------
// Staging (for modules that land after the importer)
// ---------------------------------------------------------------------------------------

/**
 * Rows in `migrate_staging` (area, source_app, source_id, payload JSON, staged_at,
 * consumed_at) are keyed by `area`. A consumer module selects its areas where
 * `consumed_at IS NULL`, imports the payloads and sets `consumed_at`. Payload shapes are the
 * Staged* schemas below (other areas carry the mapped upstream row as-is).
 */
export const MigrateStagingArea = z.enum([
  'subtitles.languageProfiles',
  'subtitles.providers',
  'subtitles.history',
  'subtitles.blacklist',
  'requests.users',
  'requests.requests',
  'requests.issues',
  'requests.settings',
  'requests.discoverSliders',
  'requests.overrideRules',
  'downloadClients.unsupported',
  'indexers.cardigann',
  'indexers.proxies',
  'prowlarr.applications',
  'library.collections',
]);
export type MigrateStagingArea = z.infer<typeof MigrateStagingArea>;

export const StagedSubtitleFlagMode = z.enum(['only', 'also', 'never']);
export type StagedSubtitleFlagMode = z.infer<typeof StagedSubtitleFlagMode>;

/** `subtitles.languageProfiles`: one Bazarr languages profile mapped to ISO 639-1 codes. */
export const StagedSubtitleLanguageProfile = z.object({
  name: z.string(),
  items: z.array(
    z.object({
      language: z.string(),
      hearingImpaired: StagedSubtitleFlagMode,
      forced: StagedSubtitleFlagMode,
      /** Skip when the audio track is already in this language. */
      audioExclude: z.boolean(),
    }),
  ),
  /** Index into items of the cutoff language; null = no cutoff (keep searching all). */
  cutoff: z.number().int().nullable(),
  mustContain: z.array(z.string()),
  mustNotContain: z.array(z.string()),
  originalFormat: z.boolean(),
  /** Bazarr auto-assign tag, if any. */
  tag: z.string().nullable(),
});
export type StagedSubtitleLanguageProfile = z.infer<typeof StagedSubtitleLanguageProfile>;

/** `subtitles.providers`: one Bazarr provider and its credential/option fields. */
export const StagedSubtitleProvider = z.object({
  provider: z.string(),
  enabled: z.boolean(),
  settings: z.record(z.string(), z.unknown()),
});
export type StagedSubtitleProvider = z.infer<typeof StagedSubtitleProvider>;

/** `subtitles.history` / `subtitles.blacklist`. Paths are already remapped. */
export const StagedSubtitleEvent = z.object({
  mediaType: z.enum(['series', 'movie']),
  /** Upstream Sonarr series / episode or Radarr movie ids (resolve via migrate_imported). */
  sonarrSeriesId: z.number().int().nullable(),
  sonarrEpisodeId: z.number().int().nullable(),
  radarrMovieId: z.number().int().nullable(),
  action: z.number().int().nullable(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  provider: z.string().nullable(),
  score: z.number().nullable(),
  subsId: z.string().nullable(),
  videoPath: z.string().nullable(),
  subtitlesPath: z.string().nullable(),
  timestamp: z.string().nullable(),
});
export type StagedSubtitleEvent = z.infer<typeof StagedSubtitleEvent>;

/** `requests.users`: Seerr users. Arclight users have no "must reset password" flag yet. */
export const StagedRequestUser = z.object({
  email: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  /** Seerr permission bitfield, unchanged. */
  permissions: z.number().int(),
  userType: z.enum(['plex', 'local', 'jellyfin', 'emby', 'unknown']),
  plexId: z.number().int().nullable(),
  jellyfinUserId: z.string().nullable(),
  avatar: z.string().nullable(),
  movieQuotaLimit: z.number().int().nullable(),
  movieQuotaDays: z.number().int().nullable(),
  tvQuotaLimit: z.number().int().nullable(),
  tvQuotaDays: z.number().int().nullable(),
  settings: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().nullable(),
});
export type StagedRequestUser = z.infer<typeof StagedRequestUser>;

/** `requests.requests`: one Seerr media_request with its seasons. */
export const StagedMediaRequest = z.object({
  mediaType: z.enum(['movie', 'tv']),
  tmdbId: z.number().int().nullable(),
  tvdbId: z.number().int().nullable(),
  status: z.enum(['pending', 'approved', 'declined', 'failed', 'completed', 'unknown']),
  is4k: z.boolean(),
  /** Seerr user id (the sourceId of a `requests.users` row). */
  requestedBySourceId: z.string().nullable(),
  modifiedBySourceId: z.string().nullable(),
  seasons: z.array(z.object({ seasonNumber: z.number().int(), status: z.string() })),
  rootFolder: z.string().nullable(),
  profileId: z.number().int().nullable(),
  tags: z.array(z.number().int()),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type StagedMediaRequest = z.infer<typeof StagedMediaRequest>;

/** `requests.issues`: one Seerr issue with its comments. */
export const StagedIssue = z.object({
  issueType: z.enum(['video', 'audio', 'subtitles', 'other', 'unknown']),
  status: z.enum(['open', 'resolved', 'unknown']),
  mediaType: z.enum(['movie', 'tv']).nullable(),
  tmdbId: z.number().int().nullable(),
  problemSeason: z.number().int(),
  problemEpisode: z.number().int(),
  createdBySourceId: z.string().nullable(),
  comments: z.array(z.object({ userSourceId: z.string().nullable(), message: z.string(), createdAt: z.string().nullable() })),
  createdAt: z.string().nullable(),
});
export type StagedIssue = z.infer<typeof StagedIssue>;

export const MigrateStagingRow = z.object({
  id: z.number().int(),
  area: MigrateStagingArea,
  sourceApp: MigrateApp,
  sourceId: z.string(),
  payload: z.unknown(),
  stagedAt: z.string(),
  consumedAt: z.string().nullable(),
});
export type MigrateStagingRow = z.infer<typeof MigrateStagingRow>;
