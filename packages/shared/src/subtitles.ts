import { z } from 'zod';

// Subtitles contract (Phase 3; behaviour: docs/spec/subtitles.md). Language codes are the
// IETF-style tags the subtitles package uses ("en", "pt-BR", "zh-Hant"). Scores are integers
// out of `scoreOutOf` (360 for episodes, 180 for movies); `percent` is score / max x 100.

const isoDate = () => z.string().describe('ISO-8601 date or timestamp');

/** Library side of an item: series (episode files) or movie. */
export const SubtitleMediaType = z.enum(['series', 'movie']);
export type SubtitleMediaType = z.infer<typeof SubtitleMediaType>;

/** Provider ids served by @arclight/subtitles, in the default priority order. */
export const SUBTITLE_PROVIDER_IDS = [
  'embeddedsubtitles',
  'opensubtitlescom',
  'subdl',
  'addic7ed',
  'podnapisi',
  'gestdown',
  'subf2m',
  'napisy24',
  'animetosho',
  'jimaku',
  'yifysubtitles',
  'whisperai',
] as const;
export const SubtitleProviderId = z.enum(SUBTITLE_PROVIDER_IDS);
export type SubtitleProviderId = z.infer<typeof SubtitleProviderId>;

// ---------------------------------------------------------------------------------------
// Language profiles
// ---------------------------------------------------------------------------------------

/**
 * How a flavour is wanted: `never` (plain only), `also` (either is fine), `only` (that
 * flavour is required). For HI: never = HI excluded, also = HI accepted, only = HI required.
 * For forced: also means both a full and a forced subtitle are wanted.
 */
export const LanguageProfileFlagMode = z.enum(['never', 'also', 'only']);
export type LanguageProfileFlagMode = z.infer<typeof LanguageProfileFlagMode>;

export const LanguageProfileItem = z.object({
  code: z.string().trim().min(2).max(16),
  forced: LanguageProfileFlagMode.default('never'),
  hi: LanguageProfileFlagMode.default('also'),
});
export type LanguageProfileItem = z.infer<typeof LanguageProfileItem>;

/** Cutoff value meaning "any language of the profile satisfies it". */
export const LANGUAGE_PROFILE_CUTOFF_ANY = '*';

export const LanguageProfileInput = z.object({
  name: z.string().trim().min(1).max(100),
  languages: z.array(LanguageProfileItem).min(1),
  /**
   * Language code of one item: once a subtitle satisfying it exists nothing else is wanted.
   * `*` = any item completes the profile. Null = every item is wanted.
   */
  cutoff: z.string().nullable().default(null),
  /** Release-info patterns (regex, or substring when the regex is invalid), case-insensitive. */
  mustContain: z.array(z.string().min(1)).default([]),
  mustNotContain: z.array(z.string().min(1)).default([]),
  /** Keep the provider's format (ass, vtt...) instead of converting to SubRip. */
  originalFormat: z.boolean().default(false),
});
export type LanguageProfileInput = z.infer<typeof LanguageProfileInput>;

export const LanguageProfile = LanguageProfileInput.extend({ id: z.number().int() });
export type LanguageProfile = z.infer<typeof LanguageProfile>;

/** One requested or present language: the R1.4 triple. Forced wins over HI. */
export const SubtitleLanguageRef = z.object({
  language: z.string(),
  forced: z.boolean(),
  hi: z.boolean(),
});
export type SubtitleLanguageRef = z.infer<typeof SubtitleLanguageRef>;

/** A language the picker can offer (GET /subtitle/languages). */
export const SubtitleLanguageOption = z.object({ code: z.string(), name: z.string() });
export type SubtitleLanguageOption = z.infer<typeof SubtitleLanguageOption>;

// ---------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------

export const SubtitleProviderFieldType = z.enum(['text', 'password', 'number', 'checkbox', 'select', 'multiSelect', 'textarea']);
export type SubtitleProviderFieldType = z.infer<typeof SubtitleProviderFieldType>;

/** A provider setting, in the field vocabulary the web schema form renders. */
export const SubtitleProviderField = z.object({
  name: z.string(),
  label: z.string(),
  type: SubtitleProviderFieldType,
  helpText: z.string().optional(),
  required: z.boolean(),
  /** Masked with SECRET_MASK on read; send the mask back to keep the stored value. */
  secret: z.boolean(),
  advanced: z.boolean().optional(),
  default: z.unknown().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type SubtitleProviderField = z.infer<typeof SubtitleProviderField>;

export const SubtitleProviderSchema = z.object({
  id: SubtitleProviderId,
  name: z.string(),
  description: z.string(),
  mediaTypes: z.array(SubtitleMediaType),
  needsAuth: z.boolean(),
  fields: z.array(SubtitleProviderField),
});
export type SubtitleProviderSchema = z.infer<typeof SubtitleProviderSchema>;

/** One configured provider. Order of the list in settings is the priority order. */
export const SubtitleProviderConfig = z.object({
  id: SubtitleProviderId,
  enabled: z.boolean().default(false),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type SubtitleProviderConfig = z.infer<typeof SubtitleProviderConfig>;

export const SubtitleThrottle = z.object({
  code: z.string(),
  description: z.string(),
  until: isoDate(),
});
export type SubtitleThrottle = z.infer<typeof SubtitleThrottle>;

export const SubtitleProviderStatus = z.object({
  id: SubtitleProviderId,
  name: z.string(),
  enabled: z.boolean(),
  /** Settings validate (required fields present). */
  configured: z.boolean(),
  configError: z.string().nullable(),
  throttle: SubtitleThrottle.nullable(),
});
export type SubtitleProviderStatus = z.infer<typeof SubtitleProviderStatus>;

/** GET /subtitle/providers */
export const SubtitleProvidersResponse = z.object({
  schema: z.array(SubtitleProviderSchema),
  status: z.array(SubtitleProviderStatus),
});
export type SubtitleProvidersResponse = z.infer<typeof SubtitleProvidersResponse>;

/** POST /subtitle/providers/test: settings may contain SECRET_MASK for stored secrets. */
export const SubtitleProviderTestRequest = z.object({
  id: SubtitleProviderId,
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type SubtitleProviderTestRequest = z.infer<typeof SubtitleProviderTestRequest>;

export const SubtitleProviderTestResult = z.object({ ok: z.boolean(), message: z.string() });
export type SubtitleProviderTestResult = z.infer<typeof SubtitleProviderTestResult>;

/** POST /subtitle/providers/reset: clear throttles (all, or only auth/config ones). */
export const SubtitleProviderResetRequest = z.object({ onlyAuthOrConfig: z.boolean().default(false) });
export type SubtitleProviderResetRequest = z.infer<typeof SubtitleProviderResetRequest>;

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;

export const SubtitleEmbeddedMode = z.enum(['present', 'ignore', 'extract']);
export type SubtitleEmbeddedMode = z.infer<typeof SubtitleEmbeddedMode>;

export const SubtitleSyncTool = z.enum(['ffsubsync', 'alass']);
export type SubtitleSyncTool = z.infer<typeof SubtitleSyncTool>;

export const SubtitleSearchSettings = z.object({
  /** Items searched per SubtitleSearchWanted run (every 15 minutes). */
  batchSize: z.number().int().min(1).max(1000).default(25),
  /** Search an imported file right away instead of waiting for the next run. */
  searchOnImport: z.boolean().default(true),
  /** Skip unmonitored items (and episodes of unmonitored series) in automatic runs. */
  onlyMonitored: z.boolean().default(false),
  /** Adaptive backoff (R3.22): every run for `adaptiveDelayMs` after the first attempt, then once per `adaptiveDeltaMs`. */
  adaptiveSearching: z.boolean().default(true),
  adaptiveDelayMs: z.number().int().min(0).default(21 * DAY_MS),
  adaptiveDeltaMs: z.number().int().min(0).default(7 * DAY_MS),
  useSceneName: z.boolean().default(true),
  concurrentProviders: z.boolean().default(true),
});

export const SubtitleSettings = z.object({
  /** Provider list in priority order; secret fields are SECRET_MASK on read. */
  providers: z.array(SubtitleProviderConfig).default([]),
  /** Profile given to newly added series / movies when the add request names none. */
  defaultSeriesProfileId: z.number().int().nullable().default(null),
  defaultMovieProfileId: z.number().int().nullable().default(null),
  search: SubtitleSearchSettings.prefault({}),
  /** Minimum score percent overrides (R4.17). */
  minimumScore: z
    .object({
      series: z.number().int().min(0).max(100).default(90),
      movie: z.number().int().min(0).max(100).default(70),
    })
    .prefault({}),
  upgrade: z
    .object({
      enabled: z.boolean().default(true),
      /** Subtitles downloaded within this many days are upgrade candidates. */
      windowDays: z.number().int().min(0).max(30).default(7),
      /** Manual downloads and uploads are upgrade candidates too. */
      includeManual: z.boolean().default(true),
    })
    .prefault({}),
  embedded: z
    .object({
      /** present: embedded tracks satisfy wanted; ignore: they do not; extract: text tracks are extracted to files. */
      mode: SubtitleEmbeddedMode.default('present'),
      ignorePgs: z.boolean().default(false),
      ignoreVobsub: z.boolean().default(false),
      ignoreAss: z.boolean().default(false),
      /** Language assumed for embedded tracks tagged "und"; null skips them. */
      undefinedLanguage: z.string().nullable().default(null),
      ffmpegPath: z.string().default('ffmpeg'),
      ffprobePath: z.string().default('ffprobe'),
    })
    .prefault({}),
  naming: z
    .object({
      hiExtension: z.enum(['hi', 'cc', 'sdh']).default('hi'),
      /** Omit the language from file names (only sensible with one-language profiles). */
      singleLanguage: z.boolean().default(false),
      folder: z.enum(['current', 'absolute', 'relative']).default('current'),
      /** Absolute folder or subfolder name, for folder = absolute / relative. */
      folderPath: z.string().default(''),
      utf8Encode: z.boolean().default(true),
    })
    .prefault({}),
  hearingImpaired: z
    .object({
      /** Mark a subtitle HI when its content has bracketed cues or music symbols. */
      detectFromContent: z.boolean().default(true),
    })
    .prefault({}),
  sync: z
    .object({
      enabled: z.boolean().default(false),
      tool: SubtitleSyncTool.default('ffsubsync'),
      /** Binary path; empty uses the tool name from PATH. */
      binaryPath: z.string().default(''),
      maxOffsetSeconds: z.number().int().min(1).max(3600).default(60),
      gss: z.boolean().default(true),
      noFixFramerate: z.boolean().default(true),
      useThresholdSeries: z.boolean().default(false),
      thresholdSeries: z.number().int().min(0).max(100).default(90),
      useThresholdMovie: z.boolean().default(false),
      thresholdMovie: z.number().int().min(0).max(100).default(70),
      blacklistedProviders: z.array(z.string()).default([]),
      timeoutMs: z.number().int().min(1000).default(600_000),
    })
    .prefault({}),
  postProcessing: z
    .object({
      enabled: z.boolean().default(false),
      /** Command line with {{placeholders}}; run without a shell. */
      command: z.string().default(''),
      useThresholdSeries: z.boolean().default(false),
      thresholdSeries: z.number().int().min(0).max(100).default(90),
      useThresholdMovie: z.boolean().default(false),
      thresholdMovie: z.number().int().min(0).max(100).default(70),
      timeoutMs: z.number().int().min(1000).default(60_000),
    })
    .prefault({}),
  /** Send notifications for manual downloads and uploads too. */
  notifyManualActions: z.boolean().default(true),
});
export type SubtitleSettings = z.infer<typeof SubtitleSettings>;

// ---------------------------------------------------------------------------------------
// Subtitle state per media file
// ---------------------------------------------------------------------------------------

export const SubtitleState = z.object({
  id: z.number().int(),
  mediaFileId: z.number().int(),
  language: z.string(),
  forced: z.boolean(),
  hi: z.boolean(),
  /** Null for embedded tracks. */
  path: z.string().nullable(),
  embedded: z.boolean(),
  /** Embedded stream index, or null. */
  streamIndex: z.number().int().nullable(),
  codec: z.string().nullable(),
  provider: z.string().nullable(),
  providerSubtitleId: z.string().nullable(),
  score: z.number().int().nullable(),
  percent: z.number().nullable(),
  size: z.number().int().nullable(),
  mtime: isoDate().nullable(),
  added: isoDate(),
});
export type SubtitleState = z.infer<typeof SubtitleState>;

/** GET /subtitle/file: one media file with its subtitles and what is still wanted. */
export const MediaFileSubtitles = z.object({
  mediaFileId: z.number().int(),
  mediaType: SubtitleMediaType,
  seriesId: z.number().int().nullable(),
  movieId: z.number().int().nullable(),
  episodeIds: z.array(z.number().int()),
  seasonNumber: z.number().int().nullable(),
  /** "S01E02" style label for episode files, null for movies. */
  episodeLabel: z.string().nullish(),
  path: z.string(),
  languageProfileId: z.number().int().nullable(),
  subtitles: z.array(SubtitleState),
  missing: z.array(SubtitleLanguageRef),
});
export type MediaFileSubtitles = z.infer<typeof MediaFileSubtitles>;

export const SubtitleFileQuery = z.object({
  mediaFileId: z.coerce.number().int().optional(),
  seriesId: z.coerce.number().int().optional(),
  movieId: z.coerce.number().int().optional(),
});
export type SubtitleFileQuery = z.infer<typeof SubtitleFileQuery>;

// ---------------------------------------------------------------------------------------
// Wanted
// ---------------------------------------------------------------------------------------

export const WantedSubtitleItem = z.object({
  mediaFileId: z.number().int(),
  mediaType: SubtitleMediaType,
  seriesId: z.number().int().nullable(),
  movieId: z.number().int().nullable(),
  episodeIds: z.array(z.number().int()),
  /** Series or movie title. */
  title: z.string(),
  /** "S01E02" style label for episodes, null for movies. */
  episodeLabel: z.string().nullable(),
  episodeTitle: z.string().nullable(),
  path: z.string(),
  languageProfileId: z.number().int(),
  missing: z.array(SubtitleLanguageRef),
  lastSearch: isoDate().nullable(),
  attempts: z.number().int(),
});
export type WantedSubtitleItem = z.infer<typeof WantedSubtitleItem>;

export const WantedSubtitlesQuery = z.object({
  mediaType: SubtitleMediaType.default('series'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type WantedSubtitlesQuery = z.infer<typeof WantedSubtitlesQuery>;

export const WantedSubtitlesPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(WantedSubtitleItem),
});
export type WantedSubtitlesPage = z.infer<typeof WantedSubtitlesPage>;

// ---------------------------------------------------------------------------------------
// History and blacklist
// ---------------------------------------------------------------------------------------

/** Spec R14.2 action codes as names. */
export const SubtitleHistoryAction = z.enum([
  'deleted',
  'downloaded',
  'manualDownload',
  'upgraded',
  'uploaded',
  'synced',
  'translated',
  'extracted',
]);
export type SubtitleHistoryAction = z.infer<typeof SubtitleHistoryAction>;

export const SubtitleHistoryRecord = z.object({
  id: z.number().int(),
  action: SubtitleHistoryAction,
  description: z.string(),
  language: z.string(),
  forced: z.boolean(),
  hi: z.boolean(),
  provider: z.string().nullable(),
  providerSubtitleId: z.string().nullable(),
  score: z.number().int().nullable(),
  scoreOutOf: z.number().int().nullable(),
  mediaType: SubtitleMediaType,
  seriesId: z.number().int().nullable(),
  movieId: z.number().int().nullable(),
  episodeIds: z.array(z.number().int()),
  mediaFileId: z.number().int().nullable(),
  /** Series or movie title (with SxxEyy for episodes). */
  title: z.string(),
  subtitlePath: z.string().nullable(),
  videoPath: z.string(),
  matched: z.array(z.string()),
  notMatched: z.array(z.string()),
  upgradedFromId: z.number().int().nullable(),
  date: isoDate(),
});
export type SubtitleHistoryRecord = z.infer<typeof SubtitleHistoryRecord>;

export const SubtitleHistoryQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  mediaType: SubtitleMediaType.optional(),
  action: SubtitleHistoryAction.optional(),
  provider: z.string().optional(),
  seriesId: z.coerce.number().int().optional(),
  movieId: z.coerce.number().int().optional(),
  mediaFileId: z.coerce.number().int().optional(),
});
export type SubtitleHistoryQuery = z.infer<typeof SubtitleHistoryQuery>;

export const SubtitleHistoryPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(SubtitleHistoryRecord),
});
export type SubtitleHistoryPage = z.infer<typeof SubtitleHistoryPage>;

export const SubtitleBlacklistRecord = z.object({
  id: z.number().int(),
  provider: z.string(),
  providerSubtitleId: z.string(),
  language: z.string(),
  forced: z.boolean(),
  hi: z.boolean(),
  mediaType: SubtitleMediaType,
  seriesId: z.number().int().nullable(),
  movieId: z.number().int().nullable(),
  mediaFileId: z.number().int().nullable(),
  title: z.string(),
  date: isoDate(),
});
export type SubtitleBlacklistRecord = z.infer<typeof SubtitleBlacklistRecord>;

export const SubtitleBlacklistQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type SubtitleBlacklistQuery = z.infer<typeof SubtitleBlacklistQuery>;

export const SubtitleBlacklistPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(SubtitleBlacklistRecord),
});
export type SubtitleBlacklistPage = z.infer<typeof SubtitleBlacklistPage>;

/** POST /subtitle/blacklist: blacklist a downloaded subtitle (deletes it, then searches again). */
export const SubtitleBlacklistRequest = z.object({
  /** SubtitleState id. */
  subtitleId: z.number().int(),
  /** Search for a replacement right away. Default true. */
  search: z.boolean().default(true),
});
export type SubtitleBlacklistRequest = z.infer<typeof SubtitleBlacklistRequest>;

// ---------------------------------------------------------------------------------------
// Manual search, download, upload, sync
// ---------------------------------------------------------------------------------------

export const SubtitleManualSearchQuery = z.object({
  mediaFileId: z.coerce.number().int(),
  /** Restrict to one language code; omitted searches every profile language. */
  language: z.string().optional(),
});
export type SubtitleManualSearchQuery = z.infer<typeof SubtitleManualSearchQuery>;

export const SubtitleSearchResult = z.object({
  /** Cache key for POST /subtitle/download; valid for one hour. */
  key: z.string(),
  provider: z.string(),
  providerSubtitleId: z.string(),
  language: z.string(),
  forced: z.boolean(),
  hi: z.boolean(),
  releaseInfo: z.array(z.string()),
  uploader: z.string().nullable(),
  score: z.number().int(),
  scoreWithoutHash: z.number().int(),
  scoreOutOf: z.number().int(),
  percent: z.number(),
  matches: z.array(z.string()),
  dontMatches: z.array(z.string()),
  url: z.string().nullable(),
  hashVerifiable: z.boolean(),
  hiVerifiable: z.boolean(),
});
export type SubtitleSearchResult = z.infer<typeof SubtitleSearchResult>;

export const SubtitleManualSearchResponse = z.object({
  results: z.array(SubtitleSearchResult),
  errors: z.array(z.object({ provider: z.string(), message: z.string() })),
  throttled: z.array(z.string()),
  allThrottled: z.boolean(),
});
export type SubtitleManualSearchResponse = z.infer<typeof SubtitleManualSearchResponse>;

export const SubtitleDownloadRequest = z.object({
  mediaFileId: z.number().int(),
  key: z.string().min(1),
});
export type SubtitleDownloadRequest = z.infer<typeof SubtitleDownloadRequest>;

const formBoolean = z.preprocess((v) => v === true || v === 'true' || v === '1' || v === 'on', z.boolean());

/** Multipart fields of POST /subtitle/upload (plus one `file` part). */
export const SubtitleUploadFields = z.object({
  mediaFileId: z.coerce.number().int(),
  language: z.string().min(2),
  forced: formBoolean.default(false),
  hi: formBoolean.default(false),
});
export type SubtitleUploadFields = z.infer<typeof SubtitleUploadFields>;

export const SubtitleSyncResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  subtitle: SubtitleState.nullable(),
});
export type SubtitleSyncResult = z.infer<typeof SubtitleSyncResult>;

/** POST /command/subtitlesearch scope: series (optionally one season), episodes, movie, or one file. */
export const SubtitleSearchCommand = z.object({
  seriesId: z.number().int().optional(),
  seasonNumber: z.number().int().min(0).optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
  mediaFileId: z.number().int().optional(),
});
export type SubtitleSearchCommand = z.infer<typeof SubtitleSearchCommand>;

export const SubtitleSearchCommandResult = z.object({
  files: z.number().int(),
  searched: z.number().int(),
  downloaded: z.number().int(),
  message: z.string(),
});
export type SubtitleSearchCommandResult = z.infer<typeof SubtitleSearchCommandResult>;

export const SubtitleErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type SubtitleErrorResponse = z.infer<typeof SubtitleErrorResponse>;
