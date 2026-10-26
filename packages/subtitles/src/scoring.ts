import { parseRelease } from '@arclight/parser';
import type { MatchKey, MediaType, SubtitleCandidate, SubtitleQuery, WantedLanguage } from './types.js';

// Scoring (spec section 4) and winner selection (section 6).

export type ScoreTable = Readonly<Partial<Record<MatchKey, number>>>;

export const EPISODE_SCORES: ScoreTable = {
  hash: 359,
  series: 160,
  year: 90,
  season: 30,
  episode: 30,
  source: 25,
  release_group: 20,
  audio_codec: 1,
  resolution: 1,
  video_codec: 1,
  hearing_impaired: 1,
  streaming_service: 1,
};

export const MOVIE_SCORES: ScoreTable = {
  hash: 179,
  title: 60,
  year: 40,
  source: 30,
  edition: 30,
  release_group: 15,
  audio_codec: 1,
  resolution: 1,
  video_codec: 1,
  hearing_impaired: 1,
  streaming_service: 1,
};

export const MAX_SCORE: Readonly<Record<MediaType, number>> = { episode: 360, movie: 180 };
export const DEFAULT_MIN_SCORE_PERCENT: Readonly<Record<MediaType, number>> = { episode: 90, movie: 70 };

export function scoreTable(mediaType: MediaType): ScoreTable {
  return mediaType === 'episode' ? EPISODE_SCORES : MOVIE_SCORES;
}

/** Integer threshold from a percent (R4.17): truncation, 90% of 360 = 324, 70% of 180 = 126. */
export function minimumScore(mediaType: MediaType, percent: number = DEFAULT_MIN_SCORE_PERCENT[mediaType]): number {
  return Math.trunc((MAX_SCORE[mediaType] * percent) / 100);
}

/** Percent of the maximum, two decimals (R1.5). */
export function scorePercent(score: number, mediaType: MediaType): number {
  return Math.round((score / MAX_SCORE[mediaType]) * 10000) / 100;
}

/** Sum of weights. A hash match wins: it stands for all other matches (score = max - 1). */
export function score(matches: ReadonlySet<MatchKey>, mediaType: MediaType): number {
  const table = scoreTable(mediaType);
  if (matches.has('hash')) return table.hash ?? 0;
  let total = 0;
  for (const m of matches) total += table[m] ?? 0;
  return total;
}

// ---------------------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------------------

/** R4.4 sanitize: - : ( ) . to space, drop apostrophes, collapse whitespace, lowercase. */
export function sanitize(s: string): string {
  return s
    .replace(/[-:().]/g, ' ')
    .replace(/['‘’`´]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Release groups treated as one (R4.8). */
export const RELEASE_GROUP_EQUIVALENTS: readonly (readonly string[])[] = [
  ['FRAMESTOR', 'W4NK3R', 'BHDSTUDIO'],
  ['LOL', 'DIMENSION'],
  ['ASAP', 'IMMERSE', 'FLEET'],
  ['AVS', 'SVA'],
];

export function sanitizeReleaseGroup(g: string): string {
  return g.replace(/\[[^\]]*\]/g, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

export function releaseGroupsMatch(a: string, b: string): boolean {
  const as = a.split(/[,/&]+/).map(sanitizeReleaseGroup).filter(Boolean);
  const bs = b.split(/[,/&]+/).map(sanitizeReleaseGroup).filter(Boolean);
  for (const x of as) {
    for (const y of bs) {
      if (x === y) return true;
      if (RELEASE_GROUP_EQUIVALENTS.some((set) => set.includes(x) && set.includes(y))) return true;
    }
  }
  return false;
}

export type SourceFamily = 'TV' | 'Air' | 'Disk-HD' | 'Disk-SD' | 'Web';

/** Map a source label (or a quality source id) to its family (R4.9); undefined when unknown. */
export function sourceFamily(source: string): SourceFamily | undefined {
  const s = source.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['hdtv', 'sdtv', 'ahdtv', 'ultrahdtv', 'uhdtv', 'pdtv', 'television', 'televisionraw', 'tv', 'hdtvrip'].includes(s)) return 'TV';
  if (['satrip', 'dvb', 'dvbrip', 'ppv', 'ppvrip', 'digitaltv', 'dsr', 'dsrip', 'dthrip'].includes(s)) return 'Air';
  if (['hddvd', 'bluray', 'blurayraw', 'bdrip', 'brrip', 'bd', 'ultrahdbluray', 'uhdbluray', 'remux', 'bdremux'].includes(s)) return 'Disk-HD';
  if (['dvd', 'dvdrip', 'vhs', 'dvdr', 'dvd5', 'dvd9'].includes(s)) return 'Disk-SD';
  if (['web', 'webdl', 'webrip', 'webhd', 'webcap'].includes(s)) return 'Web';
  return undefined;
}

export function sourcesMatch(a: string, b: string): boolean {
  const fa = sourceFamily(a);
  const fb = sourceFamily(b);
  if (fa || fb) return fa === fb;
  return a.toLowerCase() === b.toLowerCase();
}

// Token detectors for attributes the release parser does not expose as fields.
const SOURCE_TOKENS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![a-z0-9])(?:uhd[ ._-]?)?blu[ ._-]?ray|bd[ ._-]?rip|br[ ._-]?rip|bd[ ._-]?remux|(?<![a-z0-9])remux(?![a-z0-9])/i, 'Blu-ray'],
  [/(?<![a-z0-9])hd[ ._-]?dvd(?![a-z0-9])/i, 'HD-DVD'],
  [/(?<![a-z0-9])web[ ._-]?(?:dl|rip|hd|cap)?(?![a-z0-9])/i, 'Web'],
  [/(?<![a-z0-9])(?:a|u|ultra)?hdtv(?:rip)?(?![a-z0-9])|(?<![a-z0-9])(?:sd|pd)tv(?![a-z0-9])/i, 'HDTV'],
  [/(?<![a-z0-9])(?:sat[ ._-]?rip|dvb(?:rip)?|ppv(?:rip)?|dsr(?:ip)?)(?![a-z0-9])/i, 'SATRip'],
  [/(?<![a-z0-9])(?:dvd(?:rip|r|5|9)?|vhs(?:rip)?)(?![a-z0-9])/i, 'DVD'],
];
const VIDEO_CODECS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![a-z0-9])(?:[xh][ .]?265|hevc)(?![a-z0-9])/i, 'H.265'],
  [/(?<![a-z0-9])(?:[xh][ .]?264|avc)(?![a-z0-9])/i, 'H.264'],
  [/(?<![a-z0-9])xvid(?![a-z0-9])/i, 'Xvid'],
  [/(?<![a-z0-9])divx(?![a-z0-9])/i, 'DivX'],
  [/(?<![a-z0-9])av1(?![a-z0-9])/i, 'AV1'],
  [/(?<![a-z0-9])vp9(?![a-z0-9])/i, 'VP9'],
  [/(?<![a-z0-9])mpeg[ ._-]?2(?![a-z0-9])/i, 'MPEG-2'],
];
const AUDIO_CODECS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![a-z0-9])(?:true[ ._-]?hd)(?![a-z])/i, 'Dolby TrueHD'],
  [/(?<![a-z0-9])(?:e[ ._-]?ac[ ._-]?3|ddp|dd\+|dd[ ._-]?plus)/i, 'Dolby Digital Plus'],
  [/(?<![a-z0-9])(?:ac[ ._-]?3|dd(?=[ ._-]?\d|[ ._-]|$))/i, 'Dolby Digital'],
  [/(?<![a-z0-9])dts(?:[ ._-]?(?:hd|x|ma))*(?![a-z])/i, 'DTS'],
  [/(?<![a-z0-9])aac(?:[ ._-]?lc)?(?![a-z])/i, 'AAC'],
  [/(?<![a-z0-9])flac(?![a-z])/i, 'FLAC'],
  [/(?<![a-z0-9])mp3(?![a-z])/i, 'MP3'],
  [/(?<![a-z0-9])opus(?![a-z])/i, 'Opus'],
];
const STREAMING: ReadonlyArray<[RegExp, string]> = [
  [/(?<![a-z0-9])(?:amzn|amazon)(?![a-z0-9])/i, 'Amazon Prime'],
  [/(?<![A-Za-z0-9])(?:NF|[Nn]etflix)(?![A-Za-z0-9])/, 'Netflix'],
  [/(?<![a-z0-9])(?:dsnp|dsny|disney\+?)(?![a-z0-9])/i, 'Disney+'],
  [/(?<![A-Za-z0-9])(?:HMAX|MAX)(?![A-Za-z0-9])/, 'HBO Max'],
  [/(?<![a-z0-9])(?:atvp|atv\+)(?![a-z0-9])/i, 'Apple TV+'],
  [/(?<![a-z0-9])hulu(?![a-z0-9])/i, 'Hulu'],
  [/(?<![a-z0-9])pcok(?![a-z0-9])/i, 'Peacock'],
  [/(?<![a-z0-9])pmtp(?![a-z0-9])/i, 'Paramount+'],
  [/(?<![A-Za-z0-9])iT(?![A-Za-z0-9])/, 'iTunes'],
  [/(?<![A-Za-z0-9])CR(?![A-Za-z0-9])/, 'Crunchyroll'],
  [/(?<![a-z0-9])(?:bbc|iplayer)(?![a-z0-9])/i, 'BBC iPlayer'],
];

function detect(text: string, table: ReadonlyArray<[RegExp, string]>): string | undefined {
  return table.find(([re]) => re.test(text))?.[1];
}

export const detectSource = (text: string) => detect(text, SOURCE_TOKENS);
export const detectVideoCodec = (text: string) => detect(text, VIDEO_CODECS);
export const detectAudioCodec = (text: string) => detect(text, AUDIO_CODECS);
export const detectStreamingService = (text: string) => detect(text, STREAMING);
export function detectResolution(text: string): string | undefined {
  const m = /(?<![a-z0-9])(2160|1080|720|576|540|480|360)[pi](?![a-z0-9])/i.exec(text);
  if (m) return `${m[1]}p`;
  if (/(?<![a-z0-9])(?:4k|uhd)(?![a-z0-9])/i.test(text)) return '2160p';
  return undefined;
}

/** Normalise a codec/resolution label from the query to the detector vocabulary. */
function canonical(value: string, table: ReadonlyArray<[RegExp, string]>): string {
  return detect(value, table) ?? detect(` ${value} `, table) ?? value;
}
function canonicalResolution(value: string): string {
  return detectResolution(value) ?? (/^\d{3,4}$/.test(value) ? `${value}p` : value.toLowerCase());
}

// ---------------------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------------------

function titlesOf(query: SubtitleQuery): string[] {
  return [query.title, query.originalTitle, ...(query.alternativeTitles ?? [])]
    .filter((t): t is string => Boolean(t))
    .map((t) => sanitize(t.replace(/\s*\(\d{4}\)\s*$/, '')));
}

/**
 * Release-style matches (spec 4.2) of one release string against the query. Partial: only
 * attributes visible in the string are compared, absent ones are not mismatches.
 */
export function guessMatches(query: SubtitleQuery, release: string): Set<MatchKey> {
  const matches = new Set<MatchKey>();
  const text = release.trim();
  if (!text) return matches;
  const parsed = parseRelease(text, query.mediaType === 'episode' ? 'series' : 'movie');
  const titles = titlesOf(query);

  if (query.mediaType === 'episode') {
    const s = parsed.series;
    if (s) {
      const t = sanitize(s.titleInfo.titleWithoutYear || s.title);
      if (t && titles.includes(t)) matches.add('series');
      if (query.season !== undefined && s.seasons.length > 0 && s.seasons[0] === query.season) matches.add('season');
      const eps = s.episodes.length > 0 ? s.episodes : [];
      if (query.episode !== undefined && eps.length > 0 && Math.min(...eps) === query.episode) matches.add('episode');
      if (query.absoluteEpisode !== undefined && s.absoluteEpisodes.includes(query.absoluteEpisode)) matches.add('episode');
      if (s.titleInfo.year > 0) {
        if (query.year !== undefined && s.titleInfo.year === query.year) matches.add('year');
      } else if (query.originalSeries ?? true) {
        matches.add('year');
      }
    }
  } else {
    const m = parsed.movie;
    if (m) {
      const t = sanitize(m.titleWithoutYear || m.title);
      if (t && titles.includes(t)) matches.add('title');
      if (m.year > 0 && query.year !== undefined && m.year === query.year) matches.add('year');
      if (m.edition && query.edition && sanitize(m.edition) === sanitize(query.edition)) matches.add('edition');
      if (m.imdbId && query.imdbId && m.imdbId === query.imdbId) matches.add('imdb_id');
    }
  }

  const src = detectSource(text);
  if (src && query.source && sourcesMatch(src, query.source)) matches.add('source');
  const res = detectResolution(text);
  if (res && query.resolution && res === canonicalResolution(query.resolution)) matches.add('resolution');
  const vc = detectVideoCodec(text);
  if (vc && query.videoCodec && vc === canonical(query.videoCodec, VIDEO_CODECS)) matches.add('video_codec');
  const ac = detectAudioCodec(text);
  if (ac && query.audioCodec && ac === canonical(query.audioCodec, AUDIO_CODECS)) matches.add('audio_codec');
  const ss = detectStreamingService(text);
  if (ss && query.streamingService && ss === canonical(query.streamingService, STREAMING)) matches.add('streaming_service');

  if (query.releaseGroup) {
    if (parsed.releaseGroup && releaseGroupsMatch(parsed.releaseGroup, query.releaseGroup)) {
      matches.add('release_group');
    } else {
      // Tolerant: any equivalent of the video's group appears as a whole token.
      const group = sanitizeReleaseGroup(query.releaseGroup);
      const equivalents = RELEASE_GROUP_EQUIVALENTS.find((set) => set.includes(group)) ?? [group];
      const words = new Set(text.toUpperCase().split(/[^A-Z0-9]+/));
      if (group.length >= 2 && equivalents.some((g) => words.has(g))) matches.add('release_group');
    }
  }
  return matches;
}

export interface MatchResult {
  /** Final set used for the score (hash rule applied). */
  matches: Set<MatchKey>;
  /** Provider + release matches before id equivalents (R4.15, R6.2 step 5). */
  original: Set<MatchKey>;
  /** Everything except hash, equivalents included (for score_without_hash). */
  withoutHash: Set<MatchKey>;
}

/** HI preference passed to matching: only in force modes (R4.12). */
function hiPreference(wanted: WantedLanguage | undefined): boolean | undefined {
  if (!wanted) return undefined;
  if (wanted.hi === 'required') return true;
  if (wanted.hi === 'excluded') return false;
  return undefined;
}

/**
 * Compute a candidate's match set: provider-asserted matches, release-parse of every
 * release line, optional-key absence rule, HI, id equivalents, source/group rule, and the
 * hash corroboration rule (R4.14).
 */
export function computeMatches(query: SubtitleQuery, candidate: SubtitleCandidate, wanted?: WantedLanguage): MatchResult {
  const m = new Set<MatchKey>(candidate.matches);
  for (const line of candidate.releaseInfo.split(/\r?\n/)) {
    for (const k of guessMatches(query, line)) m.add(k);
  }
  const release = candidate.releaseInfo;
  // Optional keys (R4.11): both sides absent counts as a match.
  if (!query.streamingService && !detectStreamingService(release)) m.add('streaming_service');
  if (query.mediaType === 'movie' && !query.edition) {
    const parsedEdition = release ? parseRelease(release.split(/\r?\n/)[0] ?? '', 'movie').movie?.edition : null;
    if (!parsedEdition) m.add('edition');
  }
  const pref = hiPreference(wanted);
  if (pref !== undefined && candidate.hi === pref) m.add('hearing_impaired');
  // A group name on a different source is untrustworthy (R4.8).
  if (m.has('release_group') && !m.has('source')) m.delete('release_group');

  const original = new Set(m);

  // Id equivalents (R4.15).
  if (query.mediaType === 'episode') {
    if (m.has('series_imdb_id') || m.has('series_tvdb_id')) {
      m.add('series');
      m.add('year');
    }
    if (m.has('imdb_id') || m.has('tvdb_id')) {
      for (const k of ['series', 'year', 'season', 'episode'] as const) m.add(k);
    }
    if (query.season === 0 && m.has('title') && m.has('series') && m.has('year')) {
      m.add('season');
      m.add('episode');
    }
  } else if (m.has('imdb_id') || m.has('tmdb_id')) {
    m.add('title');
    m.add('year');
  }

  const withoutHash = new Set(m);
  withoutHash.delete('hash');

  let final = m;
  if (m.has('hash')) {
    if (candidate.hashVerifiable) {
      const special = query.mediaType === 'episode' && query.season === 0;
      const required: MatchKey[] = query.mediaType === 'episode' ? ['series', 'season', 'episode', 'source'] : ['video_codec', 'source'];
      const valid = special || required.every((k) => m.has(k));
      final = valid ? new Set<MatchKey>(['hash']) : withoutHash;
    } else {
      final = new Set<MatchKey>(['hash']);
    }
  }
  return { matches: final, original, withoutHash };
}

export interface ScoredCandidate extends SubtitleCandidate {
  originalMatches: Set<MatchKey>;
}

/** Score a candidate in place-free fashion; returns a copy with score fields set. */
export function scoreCandidate(query: SubtitleQuery, candidate: SubtitleCandidate, wanted?: WantedLanguage): ScoredCandidate {
  const r = computeMatches(query, candidate, wanted);
  return {
    ...candidate,
    matches: r.matches,
    originalMatches: r.original,
    score: score(r.matches, query.mediaType),
    scoreWithoutHash: score(r.withoutHash, query.mediaType),
  };
}

/** Stable sort by (score, scoreWithoutHash) descending (R6.1, R6.3). */
export function sortCandidates<T extends SubtitleCandidate>(list: readonly T[]): T[] {
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.score - a.c.score || b.c.scoreWithoutHash - a.c.scoreWithoutHash || a.i - b.i)
    .map((x) => x.c);
}

export interface SelectOptions {
  /** Integer minimum score; defaults to the media type's default percent. */
  minScore?: number | undefined;
  /** Manual search: no minimum score. */
  ignoreMinimum?: boolean | undefined;
}

/**
 * Candidates acceptable for one wanted language, best first (R6.2): same language and
 * forced flag, at or above the minimum, HI rules for force modes, and for episodes the
 * season+episode (+series or imdb) requirement on original matches.
 */
export function selectCandidates(
  query: SubtitleQuery,
  scored: readonly ScoredCandidate[],
  wanted: WantedLanguage,
  opts: SelectOptions = {},
): ScoredCandidate[] {
  const min = opts.ignoreMinimum ? -Infinity : opts.minScore ?? minimumScore(query.mediaType);
  const out: ScoredCandidate[] = [];
  for (const c of sortCandidates(scored)) {
    if (c.language !== wanted.tag || c.forced !== wanted.forced) continue;
    if (c.score < min) break;
    if (wanted.hi !== 'normal' && c.hiVerifiable && !c.matches.has('hearing_impaired')) continue;
    if (wanted.hi === 'excluded' && c.hi) continue;
    if (query.mediaType === 'episode') {
      // A surviving hash (valid verifiable one, or an unverifiable claim such as an embedded
      // track) waives the requirement; otherwise equivalents alone are not enough.
      const o = c.originalMatches;
      const ok = c.matches.has('hash') || (o.has('season') && o.has('episode') && (o.has('series') || o.has('imdb_id')));
      if (!ok) continue;
    }
    out.push(c);
  }
  return out;
}

/** The single best candidate for a wanted language, or undefined. */
export function chooseBest(query: SubtitleQuery, scored: readonly ScoredCandidate[], wanted: WantedLanguage, opts: SelectOptions = {}): ScoredCandidate | undefined {
  return selectCandidates(query, scored, wanted, opts)[0];
}

/** Must-contain / must-not-contain filters on release info (R2.15-R2.17). */
export function passesReleaseFilters(releaseInfo: string, mustContain: readonly string[] = [], mustNotContain: readonly string[] = []): boolean {
  const test = (pattern: string) => {
    try {
      return new RegExp(pattern, 'i').test(releaseInfo);
    } catch {
      return releaseInfo.toLowerCase().includes(pattern.toLowerCase());
    }
  };
  if (mustNotContain.some(test)) return false;
  return mustContain.every(test);
}

/** Matched / not-matched lists for history (R6.9). */
export function matchReport(matches: ReadonlySet<MatchKey>, mediaType: MediaType): { matched: MatchKey[]; notMatched: MatchKey[] } {
  const keys = Object.keys(scoreTable(mediaType)) as MatchKey[];
  if (matches.has('hash')) {
    return { matched: [...matches].filter((k) => k === 'hash' || k === 'hearing_impaired'), notMatched: [] };
  }
  return { matched: keys.filter((k) => matches.has(k)), notMatched: keys.filter((k) => k !== 'hash' && !matches.has(k)) };
}
