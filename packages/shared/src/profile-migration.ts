import { z } from 'zod';
import { Job } from './jobs.js';
import { MediaType, Paged } from './library.js';

// Profile migration: moving library items from one quality profile to another, judging the
// files they already have against their (new) profile, and replacing the ones that no longer
// fit, by hand or gradually in the background. Routes under /api/v1/profilemigration.

// ---------------------------------------------------------------------------------------
// File fit
// ---------------------------------------------------------------------------------------

/**
 * How an existing file fits the profile governing it: `meets` (nothing to do),
 * `upgradeAllowed` (accepted, below the quality or format cutoff), `notAllowed` (the quality is
 * not allowed, or the custom-format score is below the profile minimum).
 */
export const ProfileFileStatus = z.enum(['meets', 'upgradeAllowed', 'notAllowed']);
export type ProfileFileStatus = z.infer<typeof ProfileFileStatus>;

export const ProfileFileStatusReason = z.enum(['qualityNotAllowed', 'belowMinFormatScore', 'belowQualityCutoff', 'belowFormatCutoff']);
export type ProfileFileStatusReason = z.infer<typeof ProfileFileStatusReason>;

/**
 * Per-profile rule "When files don't meet this profile":
 * `none` do nothing; `replace` search and grab any release the profile accepts (it replaces a
 * file the profile does not allow even when that file ranks higher); `replaceIfBetter` search,
 * and replace only with a release strictly better by the profile's own ranking and scores.
 * Files that are allowed but below cutoff follow the normal upgrade rules in every mode.
 */
export const ProfileMismatchAction = z.enum(['none', 'replace', 'replaceIfBetter']);
export type ProfileMismatchAction = z.infer<typeof ProfileMismatchAction>;

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

/** Global automatic-mode settings (settings section `profileMigration`; GET/PUT /profilemigration/settings). */
export const ProfileMigrationSettings = z.object({
  /** Global switch for the scheduled ProfileMigration job (each profile has its own switch too). */
  enabled: z.boolean().default(true),
  /** Minutes between runs of the ProfileMigration job. */
  intervalMinutes: z.number().int().min(5).max(1440).default(30),
  /** Searches started by one run, at most. */
  searchesPerRun: z.number().int().min(1).max(100).default(10),
  /** Searches started by the job in any rolling 24 hours, at most. */
  maxSearchesPerDay: z.number().int().min(1).max(5000).default(100),
  /** Searches per item that found nothing before the item is marked failed. */
  maxAttempts: z.number().int().min(1).max(20).default(3),
  /** Hours before an item whose search found nothing is searched again. */
  retryAfterHours: z.number().int().min(1).max(720).default(24),
});
export type ProfileMigrationSettings = z.infer<typeof ProfileMigrationSettings>;
export type ProfileMigrationSettingsInput = z.input<typeof ProfileMigrationSettings>;

/** Migration settings of one quality profile. */
export const ProfileMigrationProfileSettings = z.object({
  qualityProfileId: z.number().int(),
  mismatchAction: ProfileMismatchAction,
  /** Work through mismatched items automatically (scheduled job). */
  autoEnabled: z.boolean(),
  /** Automatic mode paused; manual "search all" still works. */
  paused: z.boolean(),
});
export type ProfileMigrationProfileSettings = z.infer<typeof ProfileMigrationProfileSettings>;

export const ProfileMigrationProfileUpdate = z.object({
  mismatchAction: ProfileMismatchAction.optional(),
  autoEnabled: z.boolean().optional(),
  paused: z.boolean().optional(),
});
export type ProfileMigrationProfileUpdate = z.infer<typeof ProfileMigrationProfileUpdate>;

// ---------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------

/** Queue state of one mismatched file (slot) in the migration work list. */
export const ProfileMigrationQueueState = z.enum(['queued', 'grabbed', 'done', 'failed']);
export type ProfileMigrationQueueState = z.infer<typeof ProfileMigrationQueueState>;

export const ProfileMigrationCounts = z.object({
  /** Waiting for a search. */
  remaining: z.number().int(),
  /** A release was grabbed; waiting for the download and import. */
  inProgress: z.number().int(),
  /** Replaced by a file that fits the profile. */
  done: z.number().int(),
  /** Searched the maximum number of times without finding a release. */
  failed: z.number().int(),
});
export type ProfileMigrationCounts = z.infer<typeof ProfileMigrationCounts>;

export const ProfileMigrationProgress = z.object({
  qualityProfileId: z.number().int(),
  qualityProfileName: z.string(),
  settings: ProfileMigrationProfileSettings,
  /** Series and movies with at least one file judged by this profile. */
  items: z.number().int(),
  /** Of those, items with at least one file that does not meet the profile. */
  mismatchedItems: z.number().int(),
  files: z.object({
    meets: z.number().int(),
    upgradeAllowed: z.number().int(),
    notAllowed: z.number().int(),
  }),
  queue: ProfileMigrationCounts,
  /** Searches a manual "search all now" would start (episodes are searched per season). */
  pendingSearches: z.number().int(),
  /** ISO-8601 of the last re-evaluation of this profile's files; null before the first. */
  evaluatedAt: z.string().nullable(),
});
export type ProfileMigrationProgress = z.infer<typeof ProfileMigrationProgress>;

export const ProfileMigrationSearchResult = z.object({
  /** Searches the job will run. */
  searches: z.number().int(),
  job: Job.nullable(),
});
export type ProfileMigrationSearchResult = z.infer<typeof ProfileMigrationSearchResult>;

// ---------------------------------------------------------------------------------------
// Bulk migration (preview / apply)
// ---------------------------------------------------------------------------------------

/**
 * Which items to move. Filters combine (AND); at least one must be given. `fromProfileId`
 * matches an item's own profile, or (on versioned items) any version slot using it.
 */
export const ProfileMigrationSelection = z
  .object({
    /** Limit to one media type; omit for both. */
    mediaType: MediaType.optional(),
    seriesIds: z.array(z.number().int().positive()).max(10_000).optional(),
    movieIds: z.array(z.number().int().positive()).max(10_000).optional(),
    fromProfileId: z.number().int().positive().optional(),
    rootFolderPath: z.string().min(1).optional(),
    /** Items carrying any of these tags. */
    tagIds: z.array(z.number().int().positive()).optional(),
    /** Multi-version library: change only this version slot (items without it are skipped). */
    versionTag: z.string().trim().min(1).optional(),
  })
  .refine(
    (s) =>
      s.seriesIds !== undefined ||
      s.movieIds !== undefined ||
      s.fromProfileId !== undefined ||
      s.rootFolderPath !== undefined ||
      (s.tagIds !== undefined && s.tagIds.length > 0),
    { message: 'choose items, a profile, a root folder or a tag' },
  );
export type ProfileMigrationSelection = z.infer<typeof ProfileMigrationSelection>;

export const ProfileMigrationRequest = z.object({
  selection: ProfileMigrationSelection,
  toProfileId: z.number().int().positive(),
});
export type ProfileMigrationRequest = z.infer<typeof ProfileMigrationRequest>;

export const ProfileMigrationPreviewItem = z.object({
  mediaType: MediaType,
  id: z.number().int(),
  title: z.string(),
  /** Profile names the item (or slot) uses today. */
  fromProfiles: z.array(z.string()),
  files: z.number().int(),
  /** Worst status of the item's files under the new profile; null without files. */
  status: ProfileFileStatus.nullable(),
});
export type ProfileMigrationPreviewItem = z.infer<typeof ProfileMigrationPreviewItem>;

export const ProfileMigrationPreview = z.object({
  toProfileId: z.number().int(),
  toProfileName: z.string(),
  /** The new profile's rule for files that do not meet it. */
  mismatchAction: ProfileMismatchAction,
  /** Items whose profile (or slot profile) would change. */
  items: z.number().int(),
  series: z.number().int(),
  movies: z.number().int(),
  /** Selected items that already use the new profile. */
  unchanged: z.number().int(),
  itemsWithoutFiles: z.number().int(),
  files: z.object({
    total: z.number().int(),
    /** Already satisfy the new profile. */
    meets: z.number().int(),
    /** Allowed, below the cutoff: upgraded by the normal upgrade rules. */
    upgradeAllowed: z.number().int(),
    /** Not allowed at all by the new profile. */
    notAllowed: z.number().int(),
  }),
  /** Files a replacement would be searched for (both kinds above when the rule is not `none`). */
  needReplacing: z.number().int(),
  /** Rough size of the replacements (cutoff quality's preferred size x runtime); null when unknown. */
  estimatedDownloadBytes: z.number().int().nullable(),
  /** Up to 200 affected items, worst first. */
  sample: z.array(ProfileMigrationPreviewItem),
});
export type ProfileMigrationPreview = z.infer<typeof ProfileMigrationPreview>;

export const ProfileMigrationApplyResult = z.object({
  preview: ProfileMigrationPreview,
  changedSeries: z.array(z.number().int()),
  changedMovies: z.array(z.number().int()),
});
export type ProfileMigrationApplyResult = z.infer<typeof ProfileMigrationApplyResult>;

// ---------------------------------------------------------------------------------------
// Mismatch lists (Wanted -> Profile mismatch, library badges)
// ---------------------------------------------------------------------------------------

const queryList = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  return (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(',')).filter((v) => v !== '');
}, z.array(ProfileFileStatus).optional());

export const ProfileMismatchQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  mediaType: MediaType.optional(),
  /** Statuses to list; default `notAllowed`. */
  status: queryList,
  qualityProfileId: z.coerce.number().int().positive().optional(),
});
export type ProfileMismatchQuery = z.infer<typeof ProfileMismatchQuery>;

/**
 * Will a mismatched file be replaced? `scheduled` on the work list, the ProfileMigration job
 * will search it (`nextSearchAt`); `downloading` a replacement was grabbed; `failed` searched
 * `maxAttempts` times without a fitting release (retry from Settings → Profiles); `manualOnly`
 * the profile has a rule but automatic replacement is off ("Search all now" still works);
 * `paused` automatic replacement is paused for the profile; `globalOff` automatic profile
 * migration is off, or its job is disabled; `noRule` the profile's rule is "do nothing", the
 * file stays; `cutoffSearch` no rule, but the file is below the cutoff, so the Cutoff unmet
 * search upgrades it like any other (a profile without upgrades has no such files: its cutoff
 * is its lowest quality); `unmonitored` the item, episode or version slot is not monitored,
 * nothing replaces it.
 */
export const ProfileReplacementState = z.enum([
  'scheduled',
  'downloading',
  'failed',
  'manualOnly',
  'paused',
  'globalOff',
  'noRule',
  'cutoffSearch',
  'unmonitored',
]);
export type ProfileReplacementState = z.infer<typeof ProfileReplacementState>;

export const ProfileMismatchRecord = z.object({
  mediaFileId: z.number().int(),
  mediaType: MediaType,
  seriesId: z.number().int().nullable(),
  movieId: z.number().int().nullable(),
  /** Episodes the file holds (series only). */
  episodeIds: z.array(z.number().int()),
  title: z.string(),
  year: z.number().int().nullable(),
  /** "S01E02" (series files); null for movies. */
  episodeLabel: z.string().nullable(),
  versionTag: z.string().nullable(),
  qualityProfileId: z.number().int(),
  qualityProfileName: z.string(),
  quality: z.string(),
  formatScore: z.number().int(),
  status: ProfileFileStatus,
  reasons: z.array(ProfileFileStatusReason),
  migration: z
    .object({
      state: ProfileMigrationQueueState,
      attempts: z.number().int(),
      lastSearchedAt: z.string().nullable(),
      /** ISO-8601: earliest retry after a search that found nothing; null = as soon as a run reaches it. */
      nextSearchAt: z.string().nullable().optional(),
      message: z.string().nullable(),
    })
    .nullable(),
  /** Whether (and when) the file will be searched for and replaced. Optional: older servers omit it. */
  replacement: z
    .object({
      state: ProfileReplacementState,
      /** ISO-8601 estimate of the ProfileMigration run that will search it (`scheduled` only). */
      nextSearchAt: z.string().nullable(),
      /** Searches before the item is given up on (`profileMigration.maxAttempts`). */
      maxAttempts: z.number().int(),
    })
    .optional(),
});
export type ProfileMismatchRecord = z.infer<typeof ProfileMismatchRecord>;

export const ProfileMismatchPage = Paged(ProfileMismatchRecord);
export type ProfileMismatchPage = z.infer<typeof ProfileMismatchPage>;

/** One library item with files that do not meet their profile (library badges). */
export const ProfileItemStatus = z.object({
  mediaType: MediaType,
  id: z.number().int(),
  /** Worst file status: `upgradeAllowed` or `notAllowed`. */
  status: ProfileFileStatus,
  notAllowed: z.number().int(),
  upgradeAllowed: z.number().int(),
});
export type ProfileItemStatus = z.infer<typeof ProfileItemStatus>;

export const ProfileMigrationErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type ProfileMigrationErrorResponse = z.infer<typeof ProfileMigrationErrorResponse>;
