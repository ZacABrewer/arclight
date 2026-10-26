// @arclight/subtitles: the pure subtitle layer (Phase 3). No database, no HTTP server.

export * from './types.js';
export {
  LANGUAGES,
  findLanguage,
  parseLanguageTag,
  baseTag,
  languageName,
  toAlpha2,
  toAlpha3,
  isKnownLanguage,
  sameBaseLanguage,
  languageString,
  parseLanguageString,
  allLanguageTags,
} from './languages.js';
export {
  EPISODE_SCORES,
  MOVIE_SCORES,
  MAX_SCORE,
  DEFAULT_MIN_SCORE_PERCENT,
  RELEASE_GROUP_EQUIVALENTS,
  scoreTable,
  minimumScore,
  scorePercent,
  score,
  sanitize,
  releaseGroupsMatch,
  sourceFamily,
  sourcesMatch,
  guessMatches,
  computeMatches,
  scoreCandidate,
  sortCandidates,
  selectCandidates,
  chooseBest,
  passesReleaseFilters,
  matchReport,
  detectSource,
  detectResolution,
  detectVideoCodec,
  detectAudioCodec,
  detectStreamingService,
  type ScoreTable,
  type SourceFamily,
  type MatchResult,
  type ScoredCandidate,
  type SelectOptions,
} from './scoring.js';
export {
  SubtitleSearcher,
  SubtitleContentError,
  prepareSubtitle,
  type SearcherOptions,
  type SearchOutcome,
  type LanguageResult,
  type ManualRow,
  type PrepareOptions,
  type PreparedSubtitle,
} from './search.js';
export {
  ThrottleTracker,
  DEFAULT_THROTTLE,
  COUNTED_CODES,
  MAX_BACKOFF_MS,
  nextUtcTime,
  type ThrottleEntry,
  type ThrottleOptions,
  type ErrorOutcome,
} from './throttle.js';
export { buildQuery, type QueryInputData, type QueryFile } from './query.js';
export { nameSubtitleFile, parseSubtitleFileName, fileLanguageCode, type NamingStyle, type HiExtension } from './naming.js';
export {
  buildFfsubsyncCommand,
  buildAlassCommand,
  syncedOutputPath,
  shouldSync,
  postProcessVariables,
  postProcessEnv,
  splitCommandLine,
  buildPostProcessCommand,
  shouldPostProcess,
  type CommandDescriptor,
  type FfsubsyncOptions,
  type AlassOptions,
  type SyncSettings,
  type PostProcessContext,
} from './postprocess.js';
export {
  openSubtitlesHash,
  openSubtitlesHashOfBuffer,
  computeOpenSubtitlesHash,
  computeNapiprojektHash,
  computeFileHashes,
  HASH_MIN_FILE_SIZE,
} from './hash.js';
export {
  sniffArchive,
  readZip,
  writeZip,
  gunzip,
  extractSubtitle,
  pickEntry,
  parseEntryEpisode,
  ArchiveError,
  crc32,
  type ArchiveKind,
  type ZipEntry,
  type PickHints,
} from './archive.js';
export { xzDecompress, isXz, XzError } from './xz.js';
export { decodeSubtitle, toUtf8, type DecodedText } from './encoding.js';
export {
  detectFormat,
  detectFormatFromBytes,
  parseSrt,
  serializeSrt,
  parseVtt,
  parseAss,
  parseMicroDvd,
  convertToSrt,
  isValidSrt,
  normalizeLineEndings,
  looksHearingImpaired,
  extensionFor,
  formatSrtTime,
  type Cue,
} from './formats.js';

// Providers
export { BaseProvider, hasInput, parseRetryAfter, DEFAULT_USER_AGENT } from './providers/base.js';
export { OpenSubtitlesComProvider, oscWireLanguage, type OpenSubtitlesComConfig, type OpenSubtitlesQuota } from './providers/opensubtitles-com.js';
export { SubdlProvider, subdlLanguageCode, type SubdlConfig } from './providers/subdl.js';
export { Addic7edProvider, addic7edLanguageFromName, addic7edLanguageName, ADDIC7ED_LANGUAGES, type Addic7edConfig } from './providers/addic7ed.js';
export { PodnapisiProvider, type PodnapisiConfig } from './providers/podnapisi.js';
export { GestdownProvider, type GestdownConfig } from './providers/gestdown.js';
export { AnimetoshoProvider, type AnimetoshoConfig } from './providers/animetosho.js';
export { JimakuProvider, guessJimakuLanguages, type JimakuConfig } from './providers/jimaku.js';
export { YifySubtitlesProvider, type YifySubtitlesConfig } from './providers/yifysubtitles.js';
export { Subf2mProvider, type Subf2mConfig } from './providers/subf2m.js';
export { Napisy24Provider, type Napisy24Config } from './providers/napisy24.js';
export {
  EmbeddedProvider,
  buildSubtitleExtractArgs,
  codecFormat,
  DEFAULT_EMBEDDED_CODECS,
  type EmbeddedConfig,
  type EmbeddedDeps,
  type ProbeResult,
  type ProbeStream,
} from './providers/embedded.js';
export { WhisperProvider, buildAudioExtractArgs, type WhisperConfig, type WhisperDeps } from './providers/whisper.js';

/** Default provider order for Phase 3 (R5.3), embedded first per Q9, whisper last. */
export const DEFAULT_PROVIDER_ORDER = [
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
