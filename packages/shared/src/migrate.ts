import { z } from 'zod';

// Adoption importer contract: read an existing Sonarr / Radarr / Prowlarr / Bazarr / Seerr /
// qBittorrent installation, either through its live API or from its files (SQLite database
// plus config file, or qBittorrent's BT_backup folder), and populate Arclight from it.
// Single source: `POST /migrate/plan` analyses without writing; `POST /migrate/apply` runs the
// import as a background job whose progress is served by `GET /migrate/status`.
// Whole stack: `POST /migrate/stack/preview` plans every source, `POST /migrate/stack/apply`
// takes a backup and imports every source in dependency order as one `MigrateStack` job
// (`GET /migrate/stack/status`, `GET /migrate/stack/report`, `POST /migrate/stack/resume`).
// The source apps are never written to, except the optional qBittorrent pause/remove step,
// which needs an explicit confirmation.

export const MigrateApp = z.enum(['sonarr', 'radarr', 'prowlarr', 'bazarr', 'seerr', 'qbittorrent']);
export type MigrateApp = z.infer<typeof MigrateApp>;

/** How a source is read: its live HTTP API, or its database/config files. */
export const MigrateSourceMode = z.enum(['files', 'api']);
export type MigrateSourceMode = z.infer<typeof MigrateSourceMode>;

/** Shown instead of an API key or password in responses. */
export const MIGRATE_SECRET_MASK = '********';

/** Rewrites a path prefix seen by the old app (`from`) to the one Arclight sees (`to`). */
export const MigratePathMapping = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type MigratePathMapping = z.infer<typeof MigratePathMapping>;

export const MigrateSource = z
  .object({
    app: MigrateApp,
    mode: MigrateSourceMode.default('files'),
    /**
     * Files mode: the app's SQLite database (sonarr.db, radarr.db, prowlarr.db, bazarr.db,
     * db.sqlite3). For qBittorrent: its `BT_backup` folder (or the qBittorrent config folder
     * that contains it).
     */
    dbPath: z.string().trim().min(1).optional(),
    /** Files mode: config.xml (arr apps), config.yaml / config.ini (Bazarr) or settings.json (Seerr). */
    configPath: z.string().trim().min(1).optional(),
    /** API mode: base URL including any URL base, e.g. `http://sonarr:8989`. */
    url: z.string().trim().min(1).optional(),
    /** API mode: the app's API key (not used by qBittorrent). */
    apiKey: z.string().trim().min(1).optional(),
    /** API mode, qBittorrent: WebUI username and password (empty when the WebUI bypasses auth). */
    username: z.string().optional(),
    password: z.string().optional(),
    /** Display name, e.g. "Sonarr 4K" when a stack has two instances of one app. */
    label: z.string().trim().max(60).optional(),
    pathMappings: z.array(MigratePathMapping).default([]),
  })
  .superRefine((s, ctx) => {
    if (s.mode === 'files' && !s.dbPath) ctx.addIssue({ code: 'custom', path: ['dbPath'], message: 'a database path is required when reading files' });
    if (s.mode === 'api') {
      if (!s.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'a URL is required when using the API' });
      else if (!/^https?:\/\//i.test(s.url)) ctx.addIssue({ code: 'custom', path: ['url'], message: 'the URL must start with http:// or https://' });
      if (s.app !== 'qbittorrent' && !s.apiKey) ctx.addIssue({ code: 'custom', path: ['apiKey'], message: 'an API key is required when using the API' });
    }
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
  'subtitleFiles',
  'subtitleAssignments',
  'torrents',
]);
export type MigrateArea = z.infer<typeof MigrateArea>;

/**
 * What happens when an item matches something Arclight already has: keep Arclight's
 * (`skip`), replace its settings with the imported ones (`overwrite`), or keep Arclight's
 * settings and add what it is missing, such as episodes, files, links (`merge`). Nothing is
 * ever deleted. Areas without a merge rule treat `merge` like `skip`.
 */
export const MigrateConflictPolicy = z.enum(['skip', 'overwrite', 'merge']);
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

/** One qBittorrent category in a plan, so the wizard can choose adopt/external per category. */
export const MigrateTorrentCategory = z.object({
  /** '' for torrents without a category. */
  category: z.string(),
  count: z.number().int().min(0),
  complete: z.number().int().min(0),
  sizeBytes: z.number().int().min(0),
  /** Most common save path of the category, as Arclight sees it (after path mapping). */
  savePath: z.string().nullable(),
  /** Torrents of this category matched to Sonarr/Radarr grab history by info-hash. */
  linked: z.number().int().min(0),
});
export type MigrateTorrentCategory = z.infer<typeof MigrateTorrentCategory>;

export const MigrationPlan = z.object({
  /** The source as given, API key and password masked. */
  source: MigrateSource,
  app: MigrateApp,
  /** Upstream schema version (VersionInfo / alembic) or app version when readable. */
  schemaVersion: z.string().nullable(),
  areas: z.array(MigrationAreaPlan),
  warnings: z.array(MigrationWarning),
  conflicts: z.array(MigrationConflict),
  unsupported: z.array(MigrationUnsupported),
  /** qBittorrent sources only. */
  torrentCategories: z.array(MigrateTorrentCategory).optional(),
  /** qBittorrent sources only: whether the built-in engine is running, so torrents can be adopted. */
  torrentEngineRunning: z.boolean().optional(),
  createdAt: z.string(),
});
export type MigrationPlan = z.infer<typeof MigrationPlan>;

export const MigratePlanRequest = MigrateSource;
export type MigratePlanRequest = z.input<typeof MigratePlanRequest>;

export const MigrateTorrentAction = z.enum(['adopt', 'external', 'skip']);
export type MigrateTorrentAction = z.infer<typeof MigrateTorrentAction>;

const TORRENT_OPTION_DEFAULTS = { categories: {}, defaultAction: 'adopt', verify: 'recheck', pauseInSource: false, confirmSourceChanges: false } as const;

/** How qBittorrent torrents are brought over. */
export const MigrateTorrentOptions = z
  .object({
    /**
     * Per qBittorrent category ('' = no category): `adopt` into the built-in engine with the
     * data in place, keep it in qBittorrent and add qBittorrent as an `external` download
     * client, or `skip` it. Categories not listed use `defaultAction`.
     */
    categories: z.record(z.string(), MigrateTorrentAction).default({}),
    defaultAction: MigrateTorrentAction.default('adopt'),
    /**
     * `recheck`: hash every piece of the existing data before the engine uses it (safe, reads
     * all data once). `trust`: a torrent qBittorrent reports complete whose files all exist
     * with the right sizes is taken as complete without hashing (fast). Incomplete torrents
     * are always rechecked, so only missing pieces are downloaded.
     */
    verify: z.enum(['recheck', 'trust']).default('recheck'),
    /**
     * Pause each torrent in qBittorrent right before adopting it, so only one client seeds it
     * and writes to it. This changes qBittorrent, so it needs `confirmSourceChanges`. Without
     * it adopted torrents are added paused in Arclight (resume them once qBittorrent is stopped).
     */
    pauseInSource: z.boolean().default(false),
    confirmSourceChanges: z.boolean().default(false),
  })
  .refine((o) => !o.pauseInSource || o.confirmSourceChanges, { path: ['confirmSourceChanges'], message: 'pausing torrents in qBittorrent needs an explicit confirmation' });
export type MigrateTorrentOptions = z.infer<typeof MigrateTorrentOptions>;
export type MigrateTorrentOptionsInput = z.input<typeof MigrateTorrentOptions>;

export const MigrateApplyOptions = z.object({
  /** Areas to import; empty means every area in the plan. */
  areas: z.array(MigrateArea).default([]),
  conflictPolicy: MigrateConflictPolicy.default('skip'),
  /** Per-area override of `conflictPolicy`. */
  areaPolicies: z.partialRecord(MigrateArea, MigrateConflictPolicy).default({}),
  /** Run every area inside a transaction that is rolled back; reports what would happen. */
  dryRun: z.boolean().default(false),
  torrents: MigrateTorrentOptions.default(TORRENT_OPTION_DEFAULTS),
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

export const MigrationItemOutcome = z.object({
  area: MigrateArea,
  sourceId: z.string(),
  name: z.string(),
  outcome: z.enum(['created', 'updated', 'merged', 'skipped', 'staged', 'failed']),
  message: z.string().optional(),
});
export type MigrationItemOutcome = z.infer<typeof MigrationItemOutcome>;

export const MigrationResult = z.object({
  app: MigrateApp,
  dryRun: z.boolean(),
  areas: z.array(MigrationAreaResult),
  warnings: z.array(MigrationWarning),
  /** Per-item outcomes for the report (capped; areas with many rows keep the first ones). */
  items: z.array(MigrationItemOutcome).default([]),
  startedAt: z.string(),
  endedAt: z.string(),
});
export type MigrationResult = z.infer<typeof MigrationResult>;

export const MigrateRunState = z.enum(['idle', 'running', 'completed', 'failed', 'interrupted']);
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
// Connection test and discovery
// ---------------------------------------------------------------------------------------

export const MigrateTestRequest = MigrateSource;
export type MigrateTestRequest = z.input<typeof MigrateTestRequest>;

export const MigrateTestResult = z.object({
  ok: z.boolean(),
  app: MigrateApp,
  /** The app's version (API) or schema version (files) when known. */
  version: z.string().nullable(),
  /** The app that answered, when it is not the one asked for (wrong port, wrong file). */
  detected: MigrateApp.nullable(),
  message: z.string().nullable(),
});
export type MigrateTestResult = z.infer<typeof MigrateTestResult>;

/** A running app found on the Docker network (a suggestion; it still has to be tested). */
export const MigrateNetworkCandidate = z.object({
  app: MigrateApp,
  url: z.string(),
  /** e.g. `docker network` or `host`. */
  origin: z.string(),
});
export type MigrateNetworkCandidate = z.infer<typeof MigrateNetworkCandidate>;

export const MigrateDiscovery = z.object({
  files: z.array(MigrateSourceCandidate),
  network: z.array(MigrateNetworkCandidate),
});
export type MigrateDiscovery = z.infer<typeof MigrateDiscovery>;

// ---------------------------------------------------------------------------------------
// Whole-stack import
// ---------------------------------------------------------------------------------------

export const MigrateStackRequest = z.object({
  sources: z.array(MigrateSource).min(1).max(20),
});
export type MigrateStackRequest = z.input<typeof MigrateStackRequest>;

export const MigrateStackSourcePlan = z.object({
  /** Position in the request, as a string; identifies the source in later calls. */
  key: z.string(),
  app: MigrateApp,
  label: z.string(),
  plan: MigrationPlan.nullable(),
  /** Set when the source could not be read. */
  error: z.string().nullable(),
});
export type MigrateStackSourcePlan = z.infer<typeof MigrateStackSourcePlan>;

export const MigrateStackPreview = z.object({
  sources: z.array(MigrateStackSourcePlan),
  createdAt: z.string(),
});
export type MigrateStackPreview = z.infer<typeof MigrateStackPreview>;

export const MigrateStackSourceSelection = z.object({
  source: MigrateSource,
  /** Areas to import from this source; empty means every area. */
  areas: z.array(MigrateArea).default([]),
});
export type MigrateStackSourceSelection = z.infer<typeof MigrateStackSourceSelection>;

export const MigrateStackApplyRequest = z.object({
  sources: z.array(MigrateStackSourceSelection).min(1).max(20),
  conflictPolicy: MigrateConflictPolicy.default('skip'),
  areaPolicies: z.partialRecord(MigrateArea, MigrateConflictPolicy).default({}),
  /** Default true: the first run of a stack import is a rehearsal. */
  dryRun: z.boolean().default(true),
  /** Take an Arclight backup before writing anything (ignored for dry runs). */
  backup: z.boolean().default(true),
  torrents: MigrateTorrentOptions.default(TORRENT_OPTION_DEFAULTS),
});
export type MigrateStackApplyRequest = z.input<typeof MigrateStackApplyRequest>;
export type MigrateStackApplyRequestParsed = z.output<typeof MigrateStackApplyRequest>;

export const MigrateStackSourceState = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);
export type MigrateStackSourceState = z.infer<typeof MigrateStackSourceState>;

export const MigrateStackSourceStatus = z.object({
  key: z.string(),
  app: MigrateApp,
  label: z.string(),
  mode: MigrateSourceMode,
  state: MigrateStackSourceState,
  result: MigrationResult.nullable(),
  error: z.string().nullable(),
});
export type MigrateStackSourceStatus = z.infer<typeof MigrateStackSourceStatus>;

export const MigrateBackupRef = z.object({ id: z.string(), name: z.string() });
export type MigrateBackupRef = z.infer<typeof MigrateBackupRef>;

export const MigrateStackStatus = z.object({
  state: MigrateRunState,
  /** `migrate_runs` row of the current or last run. */
  runId: z.number().int().nullable(),
  jobId: z.number().int().nullable(),
  dryRun: z.boolean(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** The backup taken before this run wrote anything. */
  backup: MigrateBackupRef.nullable(),
  sources: z.array(MigrateStackSourceStatus),
  /** Index into `sources` of the source being imported. */
  current: z.number().int().nullable(),
  progress: MigrateProgress.nullable(),
  log: z.array(MigrationLogEntry),
  error: z.string().nullable(),
  /** A failed or interrupted real run can be resumed (already imported items are skipped). */
  resumable: z.boolean(),
  /** Torrents adopted from qBittorrent by real runs that the optional clean-up step can pause or remove there. */
  adoptedTorrents: z.number().int().min(0),
});
export type MigrateStackStatus = z.infer<typeof MigrateStackStatus>;

export const MigrateReportTotals = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  staged: z.number().int(),
  failed: z.number().int(),
});
export type MigrateReportTotals = z.infer<typeof MigrateReportTotals>;

/** The downloadable final report (`GET /migrate/stack/report`). Secrets are masked. */
export const MigrateReport = z.object({
  version: z.literal(1),
  runId: z.number().int(),
  state: MigrateRunState,
  dryRun: z.boolean(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  backup: MigrateBackupRef.nullable(),
  request: MigrateStackApplyRequest,
  sources: z.array(MigrateStackSourceStatus),
  totals: MigrateReportTotals,
  log: z.array(MigrationLogEntry),
});
export type MigrateReport = z.infer<typeof MigrateReport>;

/**
 * Optional last step: pause or remove (keeping the files) in qBittorrent the torrents that
 * were adopted into the built-in engine. Changes qBittorrent, so `confirm` must be true.
 */
export const MigrateSourceCleanupRequest = z.object({
  action: z.enum(['pause', 'remove']),
  confirm: z.literal(true),
});
export type MigrateSourceCleanupRequest = z.input<typeof MigrateSourceCleanupRequest>;

export const MigrateSourceCleanupResult = z.object({
  action: z.enum(['pause', 'remove']),
  done: z.number().int().min(0),
  failed: z.array(z.object({ hash: z.string(), message: z.string() })),
});
export type MigrateSourceCleanupResult = z.infer<typeof MigrateSourceCleanupResult>;

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
