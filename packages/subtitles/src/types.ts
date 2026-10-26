// Core vocabulary of the subtitle layer: languages, queries, candidates, files and the
// provider contract. Everything here is plain data so the api module can persist it.

// ---------------------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------------------

/** One row of the ISO 639 table (see languages.ts). */
export interface Language {
  /** ISO 639-1 two-letter code, or null when the language has none. */
  alpha2: string | null;
  /** ISO 639-2/B (bibliographic) three-letter code, e.g. "fre", "ger". */
  alpha3b: string;
  /** ISO 639-2/T (terminology) three-letter code, e.g. "fra", "deu". */
  alpha3t: string;
  /** ISO 639-3 code (identical to 639-2/T for every 639-1 language). */
  alpha3: string;
  /** English name. */
  name: string;
}

/**
 * IETF-style tag used everywhere a language is stored or named: the two-letter code (or the
 * three-letter one when no two-letter exists), optionally followed by a script or region:
 * "en", "pt-BR", "zh-TW", "zh-Hans", "sr-Latn", "es-MX".
 */
export type LanguageTag = string;

/** A language with the two flavour flags. Forced wins over HI when both would be set. */
export interface SubtitleLanguage {
  tag: LanguageTag;
  forced: boolean;
  hi: boolean;
}

/**
 * HI requirement of a requested language (spec R2.4-R2.6):
 * - normal: prefer non-HI, accept HI ("False")
 * - required: HI only ("True")
 * - excluded: non-HI only ("Excluded")
 */
export type HiPreference = 'normal' | 'required' | 'excluded';

/** One requested language (spec R1.2). */
export interface WantedLanguage {
  tag: LanguageTag;
  forced: boolean;
  hi: HiPreference;
}

// ---------------------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------------------

export type MediaType = 'episode' | 'movie';

/** Inputs a provider can make use of; providers declare a subset (see ProviderCapabilities). */
export type QueryInput =
  | 'hash'
  | 'imdb'
  | 'tmdb'
  | 'tvdb'
  | 'anidb'
  | 'anilist'
  | 'title'
  | 'season-episode'
  | 'file';

export interface FileHashes {
  /** OpenSubtitles-style 64-bit hash, 16 lowercase hex chars. */
  opensubtitles?: string | undefined;
  /** MD5 of the first 10 MiB (Napiprojekt). */
  napiprojekt?: string | undefined;
}

/** The video descriptor providers receive (spec R5.5). All ids are optional. */
export interface SubtitleQuery {
  mediaType: MediaType;
  /** Series title for episodes, movie title for movies (trailing "(YYYY)" removed). */
  title: string;
  originalTitle?: string | undefined;
  alternativeTitles?: readonly string[] | undefined;
  year?: number | undefined;

  season?: number | undefined;
  episode?: number | undefined;
  absoluteEpisode?: number | undefined;
  episodeTitle?: string | undefined;
  /** True when the series is the original (not a remake); grants year when absent (R4.7). */
  originalSeries?: boolean | undefined;

  /** Movie imdb id, or episode imdb id for episodes ("tt0123456"). */
  imdbId?: string | undefined;
  seriesImdbId?: string | undefined;
  tmdbId?: number | undefined;
  /** Episode tvdb id. */
  tvdbId?: number | undefined;
  seriesTvdbId?: number | undefined;
  anidbEpisodeId?: number | undefined;
  anilistId?: number | undefined;

  // Release attributes parsed from the file name / scene name / media info.
  releaseGroup?: string | undefined;
  /** Source label: "Web", "Blu-ray", "HDTV", "DVD" ... (see sourceFamily in scoring.ts). */
  source?: string | undefined;
  /** "1080p", "720p", "2160p" ... */
  resolution?: string | undefined;
  videoCodec?: string | undefined;
  audioCodec?: string | undefined;
  streamingService?: string | undefined;
  edition?: string | undefined;

  sceneName?: string | undefined;
  /** Absolute path of the video on disk (embedded/whisper only). */
  filePath?: string | undefined;
  fileName?: string | undefined;
  fileSize?: number | undefined;
  fps?: number | undefined;
  hashes?: FileHashes | undefined;
  /** Audio languages from probing, as tags. */
  audioLanguages?: readonly LanguageTag[] | undefined;

  /** The languages wanted, each with its forced/HI rules. */
  languages: readonly WantedLanguage[];
}

// ---------------------------------------------------------------------------------------
// Candidates and files
// ---------------------------------------------------------------------------------------

export type MatchKey =
  | 'hash'
  | 'series'
  | 'title'
  | 'year'
  | 'season'
  | 'episode'
  | 'source'
  | 'edition'
  | 'release_group'
  | 'audio_codec'
  | 'resolution'
  | 'video_codec'
  | 'hearing_impaired'
  | 'streaming_service'
  | 'imdb_id'
  | 'series_imdb_id'
  | 'tvdb_id'
  | 'series_tvdb_id'
  | 'tmdb_id';

export type SubtitleFormat = 'srt' | 'ass' | 'ssa' | 'vtt' | 'sub' | 'unknown';

export type ProviderKind =
  | 'opensubtitlescom'
  | 'subdl'
  | 'addic7ed'
  | 'podnapisi'
  | 'gestdown'
  | 'animetosho'
  | 'jimaku'
  | 'yifysubtitles'
  | 'subf2m'
  | 'napisy24'
  | 'embeddedsubtitles'
  | 'whisperai';

export interface SubtitleCandidate {
  provider: ProviderKind;
  /** Unique within the provider. */
  id: string;
  language: LanguageTag;
  forced: boolean;
  hi: boolean;
  /** Free text, may be multi-line; used for release matching. */
  releaseInfo: string;
  /** Match keys asserted by the provider; scoring adds release-parse and equivalents. */
  matches: Set<MatchKey>;
  /** Filled by scoring (0 until scored). */
  score: number;
  scoreWithoutHash: number;
  /** Direct download URL, when the provider has one. */
  downloadUrl?: string | undefined;
  /** Human-readable page. */
  pageUrl?: string | undefined;
  /** Provider-private data needed for download (opaque to callers). */
  token?: Readonly<Record<string, unknown>> | undefined;
  format?: SubtitleFormat | undefined;
  uploader?: string | undefined;
  rating?: number | undefined;
  downloads?: number | undefined;
  fps?: number | undefined;
  /** Declared encoding hint from the provider. */
  encoding?: string | undefined;
  /** The provider can prove a hash match (R1.3 rule 7). */
  hashVerifiable: boolean;
  /** The provider can really tell HI from non-HI. */
  hiVerifiable: boolean;
  isPack?: boolean | undefined;
  season?: number | undefined;
  episode?: number | undefined;
}

export interface SubtitleFile {
  bytes: Uint8Array;
  format: SubtitleFormat;
  /** Encoding of `bytes` (after normalisation this is "utf-8"). */
  encoding: string;
  /** Name inside an archive, when it came from one. */
  fileName?: string | undefined;
}

// ---------------------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------------------

export type ProviderErrorCode =
  | 'auth'
  | 'rate-limited'
  | 'daily-limit'
  | 'unreachable'
  | 'bad-response'
  | 'not-found'
  | 'captcha'
  | 'config'
  | 'api-throttled'
  | 'unsupported'
  | 'must-blacklist';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: ProviderKind | undefined;
  /** Server-specified wait, when known. */
  readonly retryAfterMs: number | undefined;
  /** Absolute reset time (epoch ms) for quota errors, when known. */
  readonly resetAt: number | undefined;

  constructor(
    code: ProviderErrorCode,
    message: string,
    opts: { provider?: ProviderKind | undefined; retryAfterMs?: number | undefined; resetAt?: number | undefined; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.provider = opts.provider;
    this.retryAfterMs = opts.retryAfterMs;
    this.resetAt = opts.resetAt;
  }
}

/** How long a provider is throttled after an error of a class. */
export type ThrottleRule =
  | { kind: 'duration'; ms: number }
  /** Until the next occurrence of hour:minute UTC (e.g. midnight UTC = 0:00). */
  | { kind: 'until-utc'; hour: number; minute: number };

export interface RateLimit {
  /** Minimum spacing between requests to this provider. */
  minIntervalMs: number;
  /** Per-call timeout for API/page requests. */
  requestTimeoutMs: number;
  /** Per-provider throttle overrides (spec 1.7). */
  throttle?: Partial<Record<ProviderErrorCode, ThrottleRule>> | undefined;
}

export interface ProviderCapabilities {
  mediaTypes: readonly MediaType[];
  /** Query inputs the provider can search with; at least one must be present to search. */
  inputs: readonly QueryInput[];
  /** Languages served (tags), or 'any'. */
  languages: ReadonlySet<LanguageTag> | 'any';
  forced: boolean;
  hi: boolean;
  hashVerifiable: boolean;
  hiVerifiable: boolean;
  /** A hash the provider cannot work without. */
  requiredHash?: keyof FileHashes | undefined;
}

export type SupportResult = { ok: true } | { ok: false; reason: string };

export interface SubtitleProvider {
  readonly kind: ProviderKind;
  readonly needsAuth: boolean;
  readonly rateLimit: RateLimit;
  readonly capabilities: ProviderCapabilities;
  /** Whether this query can be served at all (media type, inputs, languages). */
  supports(query: SubtitleQuery): SupportResult;
  /** List candidates; never returns languages outside query.languages. */
  search(query: SubtitleQuery): Promise<SubtitleCandidate[]>;
  /** Fetch the subtitle content (may be an archive; the searcher unpacks). */
  download(candidate: SubtitleCandidate, query?: SubtitleQuery): Promise<SubtitleFile>;
  /** Verify configuration/credentials/reachability. */
  test(): Promise<void>;
}

/** Shared dependencies injected into providers (tests pass fakes). */
export interface ProviderContext {
  fetch?: typeof fetch | undefined;
  /** Epoch ms clock. */
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  userAgent?: string | undefined;
}
