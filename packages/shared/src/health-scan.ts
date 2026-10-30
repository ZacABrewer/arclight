import { z } from 'zod';

// Library health scan: files that are broken or wrong (missing, unreadable, corrupt, truncated,
// missing streams, wrong audio language, album/book structure problems), found by the
// HealthScan job and listed for review under Library → Hygiene → Health.

/** What is wrong. Plain-language explanations live in the web app (one string per type). */
export const HealthFindingType = z.enum([
  /** The file is not on disk any more. */
  'missing',
  /** The file is zero bytes. */
  'empty',
  /** The file exists but cannot be opened or read (permissions, I/O error). */
  'unreadable',
  /** ffprobe cannot read the container (corrupt or not a media file). */
  'unparseable',
  /** ffmpeg reported errors while decoding (quick: slices; deep: the whole file). */
  'decodeErrors',
  /** Much shorter than the runtime the metadata gives. */
  'truncated',
  /** A sample file rather than the full item. */
  'sample',
  'noAudio',
  /** Video files only. */
  'noVideo',
  /** None of the wanted audio languages, or a required one is missing. */
  'wrongLanguage',
  /** Music: a track file without a track number. */
  'trackNumberMissing',
  /** Music: track numbers of an album skip numbers. Album-level. */
  'trackGaps',
  /** Audiobooks: parts out of order, duplicated or missing. Book-level. */
  'bookParts',
]);
export type HealthFindingType = z.infer<typeof HealthFindingType>;

export const HealthSeverity = z.enum(['error', 'warning', 'info']);
export type HealthSeverity = z.infer<typeof HealthSeverity>;

export const HealthFindingStatus = z.enum(['open', 'ignored', 'fixed']);
export type HealthFindingStatus = z.infer<typeof HealthFindingStatus>;

/** Which file table a finding points at: `media_files` (video) or `audio_files`. */
export const HealthFileSource = z.enum(['media', 'audio']);
export type HealthFileSource = z.infer<typeof HealthFileSource>;

export const HealthMediaType = z.enum(['series', 'movie', 'music', 'audiobook']);
export type HealthMediaType = z.infer<typeof HealthMediaType>;

export const HealthScanMode = z.enum(['quick', 'deep']);
export type HealthScanMode = z.infer<typeof HealthScanMode>;

/** Type-specific facts behind a finding (all optional; the web builds sentences from them). */
export const HealthFindingData = z.object({
  /** truncated / sample: what the file plays for and what the metadata expects (seconds). */
  actualSeconds: z.number().nullish(),
  expectedSeconds: z.number().nullish(),
  /** decodeErrors: mode used, error line count and the first few lines. */
  mode: HealthScanMode.nullish(),
  errorCount: z.number().int().nullish(),
  errors: z.array(z.string()).nullish(),
  /** unreadable / unparseable: the tool's message. */
  message: z.string().nullish(),
  /** wrongLanguage: base language tags. */
  have: z.array(z.string()).nullish(),
  wanted: z.array(z.string()).nullish(),
  missing: z.array(z.string()).nullish(),
  /** trackGaps / bookParts: missing numbers; bookParts also duplicates and order. */
  missingNumbers: z.array(z.number().int()).nullish(),
  duplicateNumbers: z.array(z.number().int()).nullish(),
  outOfOrder: z.boolean().nullish(),
  /** trackGaps: disc the gaps are on. */
  disc: z.number().int().nullish(),
});
export type HealthFindingData = z.infer<typeof HealthFindingData>;

export const HealthFinding = z.object({
  id: z.number().int(),
  type: HealthFindingType,
  severity: HealthSeverity,
  status: HealthFindingStatus,
  /** Null for album / book-level findings (trackGaps, bookParts). */
  source: HealthFileSource.nullable(),
  fileId: z.number().int().nullable(),
  mediaType: HealthMediaType,
  /** The file, or the album / book folder for album / book-level findings. */
  path: z.string(),
  /** Display name of the item ("Severance S01E03", "Heat (1995)", "Album – Artist"). */
  title: z.string(),
  seriesId: z.number().int().nullable(),
  movieId: z.number().int().nullable(),
  artistId: z.number().int().nullable(),
  albumId: z.number().int().nullable(),
  authorId: z.number().int().nullable(),
  bookId: z.number().int().nullable(),
  episodeIds: z.array(z.number().int()),
  /** Plain-language English explanation (API clients; the web app uses its own strings). */
  details: z.string(),
  data: HealthFindingData,
  firstSeen: z.string(),
  lastChecked: z.string(),
  fixedAt: z.string().nullable(),
});
export type HealthFinding = z.infer<typeof HealthFinding>;

const idList = z
  .union([z.array(z.coerce.number().int().positive()), z.coerce.number().int().positive()])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .optional();

/** GET /library/health */
export const HealthListQuery = z.object({
  /** Default `open`. `all` lists every status. */
  status: z.enum(['open', 'ignored', 'fixed', 'all']).default('open'),
  type: HealthFindingType.optional(),
  severity: HealthSeverity.optional(),
  mediaType: HealthMediaType.optional(),
  seriesId: z.coerce.number().int().positive().optional(),
  movieId: z.coerce.number().int().positive().optional(),
  artistId: z.coerce.number().int().positive().optional(),
  albumId: z.coerce.number().int().positive().optional(),
  authorId: z.coerce.number().int().positive().optional(),
  bookId: z.coerce.number().int().positive().optional(),
  ids: idList,
});
export type HealthListQuery = z.infer<typeof HealthListQuery>;
export type HealthListQueryInput = z.input<typeof HealthListQuery>;

export const HealthCounts = z.object({
  open: z.number().int(),
  ignored: z.number().int(),
  fixed: z.number().int(),
  /** Open findings per type (types without any are 0). */
  byType: z.record(HealthFindingType, z.number().int()),
  /** Open findings per severity. */
  bySeverity: z.record(HealthSeverity, z.number().int()),
});
export type HealthCounts = z.infer<typeof HealthCounts>;

export const HealthListResponse = z.object({
  /** When the last scan run finished (any scope); null before the first one. */
  lastScan: z.string().nullable(),
  /** A HealthScan job is running now. */
  running: z.boolean(),
  /** Files with a recorded check (for "N of M checked"). */
  filesChecked: z.number().int(),
  /** Library files (video + audio) in total. */
  filesTotal: z.number().int(),
  /** ffprobe / ffmpeg found (checks that need them are skipped otherwise). */
  ffprobe: z.boolean(),
  ffmpeg: z.boolean(),
  counts: HealthCounts,
  records: z.array(HealthFinding),
});
export type HealthListResponse = z.infer<typeof HealthListResponse>;

/** One library file by table and id (a selection of files to check). */
export const HealthFileRef = z.object({ source: HealthFileSource, id: z.number().int().positive() });
export type HealthFileRef = z.infer<typeof HealthFileRef>;

/**
 * POST /library/health/scan. `all: true` scans the whole library (files already checked whose
 * size and modified time are unchanged are skipped unless `force`); otherwise every file of the
 * listed items / files is checked now (always forced).
 */
export const HealthScanRequest = z
  .object({
    all: z.boolean().optional(),
    seriesIds: z.array(z.number().int().positive()).optional(),
    movieIds: z.array(z.number().int().positive()).optional(),
    artistIds: z.array(z.number().int().positive()).optional(),
    albumIds: z.array(z.number().int().positive()).optional(),
    authorIds: z.array(z.number().int().positive()).optional(),
    bookIds: z.array(z.number().int().positive()).optional(),
    files: z.array(HealthFileRef).max(5000).optional(),
    /** Re-check every file even when unchanged since its last check (`all` only). */
    force: z.boolean().optional(),
    /** Overrides the configured mode for this run. */
    mode: HealthScanMode.optional(),
  })
  .refine(
    (r) =>
      r.all === true ||
      [r.seriesIds, r.movieIds, r.artistIds, r.albumIds, r.authorIds, r.bookIds, r.files].some((l) => l !== undefined && l.length > 0),
    { message: 'all: true or at least one item or file is required' },
  );
export type HealthScanRequest = z.infer<typeof HealthScanRequest>;
export type HealthScanRequestInput = z.input<typeof HealthScanRequest>;

/**
 * Fix actions, one finding or many. `replace`: blocklist the release the file came from (when
 * known), delete or recycle the file (per the recycle-bin setting) and search for another
 * release. `recheck`: check the files again now. `ignore`: hide the finding until the file
 * changes. `unignore`: open it again. `delete`: delete or recycle the file and drop it from the
 * library (no search).
 */
export const HealthAction = z.enum(['replace', 'recheck', 'ignore', 'unignore', 'delete']);
export type HealthAction = z.infer<typeof HealthAction>;

export const HealthActionRequest = z.object({
  action: HealthAction,
  ids: z.array(z.number().int().positive()).min(1).max(2000),
});
export type HealthActionRequest = z.infer<typeof HealthActionRequest>;

export const HealthActionItemResult = z.object({
  id: z.number().int(),
  ok: z.boolean(),
  error: z.string().optional(),
  /** replace: a blocklist entry was added for the file's release. */
  blocklisted: z.boolean().optional(),
  /** replace / delete: where the file went (null = deleted permanently or already gone). */
  recycledTo: z.string().nullable().optional(),
});
export type HealthActionItemResult = z.infer<typeof HealthActionItemResult>;

export const HealthActionResult = z.object({
  action: HealthAction,
  succeeded: z.number().int(),
  failed: z.number().int(),
  results: z.array(HealthActionItemResult),
  /** recheck: the HealthScan job; replace: the search job (when one was started). */
  jobId: z.number().int().nullable(),
});
export type HealthActionResult = z.infer<typeof HealthActionResult>;

// ---------------------------------------------------------------------------------------
// settings (`healthScan` section; GET/PUT /settings/healthscan)
// ---------------------------------------------------------------------------------------

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const HealthScanSettings = z.object({
  /**
   * When the HealthScan job runs by itself. Weekly by default (Sunday 03:00, or the window
   * start): after the first pass only new and changed files are checked, so later runs are short.
   */
  schedule: z.enum(['off', 'daily', 'weekly']).default('weekly'),
  /** quick: decode three short slices (start, middle, end); deep: decode every frame (CPU-heavy). */
  mode: HealthScanMode.default('quick'),
  /** Files checked in parallel. */
  concurrency: z.number().int().min(1).max(4).default(1),
  /** Run ffmpeg/ffprobe through `nice` / `ionice` (Linux, when available). */
  lowPriority: z.boolean().default(true),
  /** Scheduled and whole-library scans only run (and stop) inside this daily window. */
  window: z
    .object({ enabled: z.boolean().default(false), start: clock.default('01:00'), end: clock.default('06:00') })
    .default({ enabled: false, start: '01:00', end: '06:00' }),
  /** A file is truncated when it plays for less than this share of the expected runtime. */
  truncatedPercent: z.number().int().min(10).max(99).default(75),
  /** Check audio languages of movies and episodes against the profile. */
  checkLanguages: z.boolean().default(true),
  /** Send the "Health scan found problems" notification after a scan with new findings. */
  notify: z.boolean().default(true),
});
export type HealthScanSettings = z.infer<typeof HealthScanSettings>;
export type HealthScanSettingsInput = z.input<typeof HealthScanSettings>;
