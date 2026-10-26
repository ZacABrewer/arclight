import { z } from 'zod';

// General settings contract. Settings are stored per section (one row per section in the
// `settings` table, value = JSON). Each section has a stored shape (what the api persists),
// a response shape (secrets masked) and an update shape (what a client PUTs back).

/** Placeholder returned in place of a stored secret. Sending it back keeps the stored value. */
export const SECRET_MASK = '********';

// ---------------------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------------------

/** Stored form of the `metadata` section. */
export const MetadataSettings = z.object({
  /** TMDB v3 API key. Absent means fall back to MEDIATRON_TMDB_API_KEY. */
  tmdbApiKey: z.string().min(1).optional(),
  /** BCP-47 language tag passed to TMDB, e.g. en-US. */
  language: z.string().min(2).default('en-US'),
  /** ISO-3166-1 region used for release dates and certifications. */
  region: z.string().length(2).default('US'),
});
export type MetadataSettings = z.infer<typeof MetadataSettings>;

/** GET /api/v1/settings/metadata. `tmdbApiKey` is SECRET_MASK when a key is stored, null otherwise. */
export const MetadataSettingsResponse = z.object({
  tmdbApiKey: z.string().nullable(),
  language: z.string(),
  region: z.string(),
});
export type MetadataSettingsResponse = z.infer<typeof MetadataSettingsResponse>;

/**
 * PUT /api/v1/settings/metadata. `tmdbApiKey`: SECRET_MASK or omitted keeps the stored key,
 * null or '' clears it, any other string replaces it.
 */
export const MetadataSettingsUpdate = z.object({
  tmdbApiKey: z.string().nullable().optional(),
  language: z.string().min(2).optional(),
  region: z.string().length(2).optional(),
});
export type MetadataSettingsUpdate = z.infer<typeof MetadataSettingsUpdate>;

export const SettingsErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type SettingsErrorResponse = z.infer<typeof SettingsErrorResponse>;

// ---------------------------------------------------------------------------------------
// mediaManagement (owned by the imports module; behaviour: docs/spec/import.md section 15)
// ---------------------------------------------------------------------------------------

export const EpisodeTitleRequired = z.enum(['always', 'bulkSeasonReleases', 'never']);
export type EpisodeTitleRequired = z.infer<typeof EpisodeTitleRequired>;

export const DownloadPropersAndRepacks = z.enum(['preferAndUpgrade', 'doNotUpgrade', 'doNotPrefer']);
export type DownloadPropersAndRepacks = z.infer<typeof DownloadPropersAndRepacks>;

/** What an imported file's modified time is set to. */
export const FileDateMode = z.enum(['none', 'localAirDate', 'utcAirDate', 'releaseDate']);
export type FileDateMode = z.infer<typeof FileDateMode>;

/** Stored form of the `mediaManagement` section; also the GET/PUT body of /settings/mediamanagement. */
export const MediaManagementSettings = z.object({
  enableCompletedDownloadHandling: z.boolean().default(true),
  autoRedownloadFailed: z.boolean().default(true),
  /** Empty or absent: replaced/deleted files are deleted permanently. */
  recycleBinPath: z.string().optional(),
  /** 0 disables cleanup. */
  recycleBinCleanupDays: z.number().int().min(0).max(365).default(7),
  importExtraFiles: z.boolean().default(false),
  /** Extensions without dots, e.g. `srt`, `nfo`. */
  extraFileExtensions: z.array(z.string().trim().min(1)).default(['srt']),
  /** Copy-mode imports hard-link when possible (copyUsingHardlinks). */
  useHardlinks: z.boolean().default(true),
  skipFreeSpaceCheck: z.boolean().default(false),
  minimumFreeSpaceMb: z.number().int().min(0).default(100),
  /** Folder names (prefixes) a download client unpacks into. */
  downloadClientWorkingFolders: z.array(z.string().min(1)).default(['_UNPACK_', '_FAILED_']),
  createEmptySeriesFolders: z.boolean().default(false),
  deleteEmptyFolders: z.boolean().default(false),
  setPermissions: z.boolean().default(false),
  /** Octal string, e.g. `755`. Files get the same mode without execute bits. */
  chmodFolder: z.string().regex(/^[0-7]{3,4}$/).default('755'),
  chownGroup: z.string().default(''),
  enableMediaInfo: z.boolean().default(true),
  rescanAfterRefresh: z.enum(['always', 'afterManual', 'never']).default('always'),
  episodeTitleRequired: EpisodeTitleRequired.default('always'),
  downloadPropersAndRepacks: DownloadPropersAndRepacks.default('preferAndUpgrade'),
  fileDateMode: FileDateMode.default('none'),
});
export type MediaManagementSettings = z.infer<typeof MediaManagementSettings>;
export type MediaManagementSettingsInput = z.input<typeof MediaManagementSettings>;

// ---------------------------------------------------------------------------------------
// releases (decision-engine knobs read by the releases module; GET/PUT /settings/releases)
// ---------------------------------------------------------------------------------------

export const SeasonPackUpgradeMode = z.enum(['all', 'any', 'percent']);
export type SeasonPackUpgradeMode = z.infer<typeof SeasonPackUpgradeMode>;

/** Stored form of the `releases` section; also the GET/PUT body of /settings/releases. */
export const ReleasesSettings = z.object({
  /** Global hard cap in MB; 0 = off. */
  maximumSizeMb: z.number().int().min(0).default(0),
  /** Usenet: ignore releases newer than this (minutes); 0 = off. */
  minimumAgeMinutes: z.number().int().min(0).default(0),
  /** Usenet: ignore releases older than this (days); 0 = off. */
  retentionDays: z.number().int().min(0).default(0),
  /** Accept multi-season packs. */
  allowMultiSeasonPacks: z.boolean().default(false),
  /** How many episodes of a season pack must be upgrades before it is grabbed. */
  seasonPackUpgradeMode: SeasonPackUpgradeMode.default('all'),
  /** Percentage used when `seasonPackUpgradeMode` is `percent`. */
  seasonPackUpgradeThreshold: z.number().int().min(0).max(100).default(100),
  /** Movies: extra days after the minimum-availability date (may be negative). */
  availabilityDelayDays: z.number().int().default(0),
  /** Accept single-episode releases before the episode has aired. */
  allowUnairedEpisodes: z.boolean().default(false),
  /** Tolerance before air time a single-episode release is accepted (minutes). */
  unairedToleranceMinutes: z.number().int().min(0).default(60),
});
export type ReleasesSettings = z.infer<typeof ReleasesSettings>;
export type ReleasesSettingsInput = z.input<typeof ReleasesSettings>;
