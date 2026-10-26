import { z } from 'zod';
import { CustomFormatInput } from './profiles.js';

// Guides sync: keeps custom formats and quality-profile scores in line with a published
// "guide" repository (TRaSH-style JSON: one file per custom format carrying `trash_id`,
// `trash_scores` and *arr-style specifications, plus quality-profile files listing the
// formats they score). Owned by the guides module (routes under /guides and /settings/guides).

/** The TRaSH guides repository as a raw-content base (the branch is appended). */
export const TRASH_GUIDES_REPO_URL = 'https://raw.githubusercontent.com/TRaSH-Guides/Guides/';

export const GuideApp = z.enum(['radarr', 'sonarr']);
export type GuideApp = z.infer<typeof GuideApp>;

export const GuidesMode = z.enum(['notify', 'apply']);
export type GuidesMode = z.infer<typeof GuidesMode>;

export const GuidesSource = z.enum(['trash', 'custom']);
export type GuidesSource = z.infer<typeof GuidesSource>;

export const GuidesProfileMapping = z.object({
  /** Profile name as the guide publishes it, e.g. `HD Bluray + WEB` (case-insensitive). */
  guideProfileName: z.string().trim().min(1),
  localQualityProfileId: z.number().int().min(1),
  /** Which app's guide profile; omitted = the first app in `apps` that has the name. */
  app: GuideApp.optional(),
});
export type GuidesProfileMapping = z.infer<typeof GuidesProfileMapping>;

/** Stored form of the `guides` settings section; also the GET/PUT body of /settings/guides. */
export const GuidesSettings = z.object({
  enabled: z.boolean().default(false),
  /** `trash` always reads TRASH_GUIDES_REPO_URL; `custom` reads `repoUrl`. */
  source: GuidesSource.default('trash'),
  /**
   * Raw-content base of the repository (`https://raw.githubusercontent.com/<owner>/<repo>/`).
   * GitHub-hosted repos are listed through the contents API; any other host must serve a
   * JSON array of file names as `<dir>/index.json`.
   */
  repoUrl: z.string().url().default(TRASH_GUIDES_REPO_URL),
  branch: z.string().trim().min(1).default('master'),
  /** Guide sections to read. A format name present in both gets an app suffix on the second. */
  apps: z.array(GuideApp).min(1).default(['radarr']),
  /** 1-168 hours between automatic syncs. */
  syncIntervalHours: z.number().int().min(1).max(168).default(24),
  /** `notify`: store a pending diff and notify. `apply`: apply it straight away. */
  mode: GuidesMode.default('notify'),
  profiles: z.array(GuidesProfileMapping).default([]),
  /**
   * Formats to sync besides the ones mapped profiles reference: names or trash ids, `*` and
   * `?` wildcards, case-insensitive. `["*"]` syncs the whole guide.
   */
  includeFormats: z.array(z.string().trim().min(1)).default([]),
  /** Never synced, even when a mapped profile references them. Same matching rules. */
  excludeFormats: z.array(z.string().trim().min(1)).default([]),
  /** Also give every synced format its guide score on mapped profiles, not only the ones the guide profile lists. */
  scoreAllSyncedFormats: z.boolean().default(true),
});
export type GuidesSettings = z.infer<typeof GuidesSettings>;
export type GuidesSettingsInput = z.input<typeof GuidesSettings>;

// ---- diff -------------------------------------------------------------------------------

const FormatChangeFields = {
  /** Stable id (`format:<guideId>`); POST /guides/apply takes these. */
  id: z.string(),
  guideId: z.string(),
  app: GuideApp,
  name: z.string(),
  /** Local format id (update/adopt); null for create. */
  formatId: z.number().int().nullable(),
  before: CustomFormatInput.nullable(),
  after: CustomFormatInput,
  /** Guide specifications Arclight cannot express (dropped from `after`). */
  warnings: z.array(z.string()),
};

export const GuidesScoreChange = z.object({
  /** Stable id (`score:<profileId>:<guideId>`). */
  id: z.string(),
  kind: z.literal('setScore'),
  guideId: z.string(),
  app: GuideApp,
  profileId: z.number().int(),
  profileName: z.string(),
  guideProfileName: z.string(),
  formatName: z.string(),
  /** Null while the format does not exist locally yet (its createFormat must be applied too). */
  formatId: z.number().int().nullable(),
  /** Null = the profile has no score for the format today. */
  before: z.number().int().nullable(),
  after: z.number().int(),
});
export type GuidesScoreChange = z.infer<typeof GuidesScoreChange>;

/**
 * createFormat: new format. updateFormat: a synced format changed upstream. adoptFormat: a
 * user-created format with the same name would be linked to the guide and overwritten; it is
 * never applied automatically, only when its id is passed to POST /guides/apply.
 */
export const GuidesDiffItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('createFormat'), ...FormatChangeFields }),
  z.object({ kind: z.literal('updateFormat'), ...FormatChangeFields }),
  z.object({ kind: z.literal('adoptFormat'), ...FormatChangeFields }),
  GuidesScoreChange,
]);
export type GuidesDiffItem = z.infer<typeof GuidesDiffItem>;
export type GuidesFormatChange = Exclude<GuidesDiffItem, GuidesScoreChange>;

export const GuidesDiff = z.object({
  generatedAt: z.string(),
  /** Hash of the change set; equal revisions mean the same pending changes. */
  revision: z.string(),
  items: z.array(GuidesDiffItem),
  /** Synced formats the guide no longer publishes. Reported only; never deleted. */
  staleFormats: z.array(z.object({ formatId: z.number().int(), name: z.string(), guideId: z.string() })),
  /** Mapping problems, unreadable files and the like. */
  warnings: z.array(z.string()),
});
export type GuidesDiff = z.infer<typeof GuidesDiff>;

// ---- status / sync / apply ------------------------------------------------------------

export const GuidesFetchStats = z.object({
  /** Guide files read. */
  files: z.number().int(),
  /** Files served from the cache (unchanged sha or 304). */
  cached: z.number().int(),
  /** HTTP requests made. */
  requests: z.number().int(),
});
export type GuidesFetchStats = z.infer<typeof GuidesFetchStats>;

export const GuidesStatus = z.object({
  enabled: z.boolean(),
  mode: GuidesMode,
  source: GuidesSource,
  repoUrl: z.string(),
  branch: z.string(),
  syncIntervalHours: z.number().int(),
  lastSyncAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastAppliedAt: z.string().nullable(),
  /** Items in the stored pending diff. */
  pendingCount: z.number().int(),
  pendingSince: z.string().nullable(),
  lastFetch: GuidesFetchStats.nullable(),
  /** Local formats linked to the guide. */
  syncedFormats: z.number().int(),
});
export type GuidesStatus = z.infer<typeof GuidesStatus>;

export const GuidesApplyRequest = z.object({
  /** Diff item ids to apply; omitted = every item except `adoptFormat`. */
  ids: z.array(z.string()).optional(),
});
export type GuidesApplyRequest = z.infer<typeof GuidesApplyRequest>;

export const GuidesApplyResult = z.object({
  applied: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
  formatsCreated: z.number().int(),
  formatsUpdated: z.number().int(),
  scoresSet: z.number().int(),
  /** Items still pending afterwards. */
  pendingCount: z.number().int(),
});
export type GuidesApplyResult = z.infer<typeof GuidesApplyResult>;

export const GuidesSyncResult = z.object({
  mode: GuidesMode,
  /** Changes found by this sync. */
  changes: z.number().int(),
  /** Set in `apply` mode. */
  applied: GuidesApplyResult.nullable(),
  pendingCount: z.number().int(),
  warnings: z.array(z.string()),
  fetch: GuidesFetchStats,
});
export type GuidesSyncResult = z.infer<typeof GuidesSyncResult>;

export const GuideProfileInfo = z.object({
  app: GuideApp,
  trashId: z.string(),
  name: z.string(),
  description: z.string(),
  /** Which `trash_scores` key the profile scores with. */
  scoreSet: z.string(),
  formats: z.array(z.object({ name: z.string(), guideId: z.string() })),
  /** Local quality profile id this guide profile is mapped to, if any. */
  mappedTo: z.number().int().nullable(),
});
export type GuideProfileInfo = z.infer<typeof GuideProfileInfo>;

export const GuidesErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type GuidesErrorResponse = z.infer<typeof GuidesErrorResponse>;
