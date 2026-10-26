import { parseRelease, type MediaTypeHint, type ParsedRelease } from '@media-tron/parser';
import type { Episode, Movie, Series } from '@media-tron/shared';

// Maps a parsed release onto library items (decision-engine spec §3). Pure: the library is
// read through the `LibrarySnapshot` interface so the matcher is testable without a DB.

export interface LibrarySnapshot {
  series(): readonly Series[];
  episodes(seriesId: number): readonly Episode[];
  movies(): readonly Movie[];
}

export interface ReleaseIds {
  tvdbId?: number | undefined;
  tmdbId?: number | undefined;
  imdbId?: string | undefined;
}

/** The item a search is running for; matching prefers it (§3.1.3 step 2, §3.3.1 step 2). */
export interface MatchCriteria {
  mediaType: 'series' | 'movie';
  seriesId?: number;
  episodeIds?: readonly number[];
  seasonNumber?: number;
  movieId?: number;
}

export type MatchType = 'title' | 'id' | 'criteria' | 'override';

export interface SeriesMatch {
  status: 'mapped';
  mediaType: 'series';
  series: Series;
  episodes: Episode[];
  seasonNumber: number | undefined;
  fullSeason: boolean;
  special: boolean;
  matchType: MatchType;
}

export interface MovieMatch {
  status: 'mapped';
  mediaType: 'movie';
  movie: Movie;
  matchType: MatchType;
}

export type UnmatchedReason = 'unableToParse' | 'unknownSeries' | 'unknownEpisode' | 'unknownMovie';

export interface Unmatched {
  status: 'unknown' | 'ambiguous';
  mediaType: 'series' | 'movie' | undefined;
  reason: UnmatchedReason;
  message: string;
  /** Set for `unknownEpisode`: the series matched, the episodes did not. */
  series?: Series;
  /** Set for `ambiguous`: the ids that matched equally well. */
  candidates?: number[];
}

export type MatchResult = SeriesMatch | MovieMatch | Unmatched;

// ---- titles -------------------------------------------------------------------------

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of']);

function words(title: string): string[] {
  return title
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/%/g, ' percent ')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Spec §3.1.4 cleaned title: lowercase, diacritics stripped, punctuation and whitespace
 * removed, the words a/an/the/and/or/of dropped, `%` → `percent`. All-digit titles verbatim.
 */
export function cleanTitle(title: string): string {
  const trimmed = title.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const all = words(trimmed);
  const kept = all.filter((w) => !STOP_WORDS.has(w));
  return (kept.length > 0 ? kept : all).join('');
}

const NUMERALS: Record<string, string> = {
  ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10',
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};
const NUMERAL_PREFIXES = new Set(['part', 'chapter', 'volume', 'vol', 'episode']);

/** Cleaned title with roman numerals / number words as digits ("Part II" == "Part Two" == "Part 2"). */
export function numeralTitle(title: string): string {
  const all = words(title);
  const mapped = all.map((w, i) => {
    if (w === 'i' && i > 0 && NUMERAL_PREFIXES.has(all[i - 1]!)) return '1';
    return NUMERALS[w] ?? w;
  });
  const kept = mapped.filter((w) => !STOP_WORDS.has(w));
  return (kept.length > 0 ? kept : mapped).join('');
}

function titleKeys(title: string): Set<string> {
  return new Set([cleanTitle(title), numeralTitle(title)].filter(Boolean));
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const k of a) if (b.has(k)) return true;
  return false;
}

function normalizeImdb(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const digits = id.trim().replace(/^tt/i, '');
  if (!/^\d+$/.test(digits) || Number(digits) === 0) return undefined;
  return `tt${digits.padStart(7, '0')}`;
}

// ---- series -------------------------------------------------------------------------

function seriesKeys(s: Series): Set<string> {
  const keys = titleKeys(s.title);
  if (s.cleanTitle) keys.add(s.cleanTitle);
  return keys;
}

function uniqueSeries(candidates: Series[], year: number): Series | Series[] | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  if (year > 0) {
    const byYear = candidates.filter((s) => s.year === year);
    if (byYear.length === 1) return byYear[0]!;
  }
  return candidates;
}

function findSeriesByIds(all: readonly Series[], ids: ReleaseIds): Series | null {
  if (ids.tvdbId) {
    const hit = all.find((s) => s.tvdbId === ids.tvdbId);
    if (hit) return hit;
  }
  if (ids.tmdbId) {
    const hit = all.find((s) => s.tmdbId === ids.tmdbId);
    if (hit) return hit;
  }
  const imdb = normalizeImdb(ids.imdbId);
  if (imdb && !ids.tvdbId) {
    const hit = all.find((s) => normalizeImdb(s.imdbId) === imdb);
    if (hit) return hit;
  }
  return null;
}

type SeriesLookup = { series: Series; matchType: MatchType } | { ambiguous: number[] } | null;

function lookupSeries(parsed: ParsedRelease, ids: ReleaseIds, lib: LibrarySnapshot, criteria?: MatchCriteria): SeriesLookup {
  const info = parsed.series;
  const all = lib.series();
  const title = info?.titleInfo.title ?? info?.title ?? '';
  const withoutYear = info?.titleInfo.titleWithoutYear ?? title;
  const year = info?.titleInfo.year ?? 0;
  const keys = titleKeys(title);
  const keysWithoutYear = titleKeys(withoutYear);

  // A running search: compare against the searched series first.
  if (criteria?.seriesId !== undefined) {
    const searched = all.find((s) => s.id === criteria.seriesId);
    if (searched) {
      const sk = seriesKeys(searched);
      if (intersects(keys, sk) || (year > 0 && searched.year === year && intersects(keysWithoutYear, sk))) {
        return { series: searched, matchType: 'title' };
      }
      if (
        (ids.tvdbId && searched.tvdbId === ids.tvdbId) ||
        (ids.tmdbId && searched.tmdbId === ids.tmdbId) ||
        (!ids.tvdbId && normalizeImdb(ids.imdbId) && normalizeImdb(ids.imdbId) === normalizeImdb(searched.imdbId))
      ) {
        return { series: searched, matchType: 'id' };
      }
    }
  }

  if (title) {
    const exact = uniqueSeries(all.filter((s) => intersects(keys, seriesKeys(s))), year);
    if (exact && !Array.isArray(exact)) return { series: exact, matchType: 'title' };
    if (Array.isArray(exact)) return { ambiguous: exact.map((s) => s.id) };
    if (year > 0) {
      const withYear = all.filter((s) => s.year === year && intersects(keysWithoutYear, seriesKeys(s)));
      if (withYear.length === 1) return { series: withYear[0]!, matchType: 'title' };
    }
  }
  const byId = findSeriesByIds(all, ids);
  return byId ? { series: byId, matchType: 'id' } : null;
}

/** Episodes a parsed release covers within the series (§3.2). */
export function mapEpisodes(
  parsed: ParsedRelease,
  series: Series,
  episodes: readonly Episode[],
): { episodes: Episode[]; seasonNumber: number | undefined; fullSeason: boolean; special: boolean } {
  const info = parsed.series;
  const none = { episodes: [], seasonNumber: undefined, fullSeason: false, special: false };
  if (!info) return none;
  const season = info.seasons[0];

  if (info.airDate) {
    if (series.seriesType !== 'daily') return none; // §3.2.2
    const hits = episodes.filter((e) => e.airDate === info.airDate);
    return { episodes: hits, seasonNumber: hits[0]?.seasonNumber, fullSeason: false, special: false };
  }

  if (info.special && season !== undefined && season !== 0) return none; // §3.2.7

  if (info.fullSeason) {
    const seasons = new Set(info.isMultiSeason ? info.seasons : season !== undefined ? [season] : []);
    const hits = episodes.filter((e) => seasons.has(e.seasonNumber));
    return { episodes: sortEpisodes(hits), seasonNumber: season, fullSeason: true, special: false };
  }

  if (info.absoluteEpisodes.length > 0 && (info.episodes.length === 0 || series.seriesType === 'anime')) {
    const hits: Episode[] = [];
    for (const abs of info.absoluteEpisodes) {
      const pool = info.special ? episodes.filter((e) => e.seasonNumber === 0) : episodes.filter((e) => e.seasonNumber > 0);
      const hit = pool.find((e) => e.absoluteEpisodeNumber === abs);
      if (hit) hits.push(hit);
    }
    if (hits.length > 0) {
      return { episodes: dedupeEpisodes(hits), seasonNumber: hits[0]!.seasonNumber, fullSeason: false, special: info.special };
    }
    if (info.episodes.length === 0) return none;
  }

  if (season === undefined) return none;
  const hits: Episode[] = [];
  for (const n of info.episodes) {
    const hit = episodes.find((e) => e.seasonNumber === season && e.episodeNumber === n);
    if (hit) hits.push(hit); // missing numbers are skipped (§3.2.6)
  }
  return { episodes: dedupeEpisodes(hits), seasonNumber: season, fullSeason: false, special: season === 0 };
}

function sortEpisodes(list: Episode[]): Episode[] {
  return [...list].sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

function dedupeEpisodes(list: Episode[]): Episode[] {
  const seen = new Set<number>();
  return sortEpisodes(list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))));
}

/**
 * Unparseable titles may still be specials named only by episode title (§3.1.1): find the
 * series whose title the release starts with (leftmost, then longest), then a season-0
 * episode whose title appears in the rest.
 */
function matchSpecialByTitle(releaseTitle: string, lib: LibrarySnapshot, criteria?: MatchCriteria): SeriesMatch | null {
  const cleaned = cleanTitle(releaseTitle);
  const pool = criteria?.seriesId !== undefined ? lib.series().filter((s) => s.id === criteria.seriesId) : lib.series();
  let best: { series: Series; at: number; len: number } | null = null;
  for (const s of pool) {
    const key = cleanTitle(s.title);
    if (!key) continue;
    const at = cleaned.indexOf(key);
    if (at < 0) continue;
    if (!best || at < best.at || (at === best.at && key.length > best.len)) best = { series: s, at, len: key.length };
  }
  if (!best) return null;
  const rest = cleaned.slice(best.at + best.len);
  const special = lib
    .episodes(best.series.id)
    .filter((e) => e.seasonNumber === 0 && cleanTitle(e.title).length > 0)
    .find((e) => rest.includes(cleanTitle(e.title)));
  if (!special) return null;
  return {
    status: 'mapped',
    mediaType: 'series',
    series: best.series,
    episodes: [special],
    seasonNumber: 0,
    fullSeason: false,
    special: true,
    matchType: 'title',
  };
}

export function matchSeries(parsed: ParsedRelease, ids: ReleaseIds, lib: LibrarySnapshot, criteria?: MatchCriteria): SeriesMatch | Unmatched {
  if (!parsed.series) {
    const special = matchSpecialByTitle(parsed.releaseTitle, lib, criteria);
    if (special) return special;
    return { status: 'unknown', mediaType: 'series', reason: 'unableToParse', message: 'Unable to parse release' };
  }
  const found = lookupSeries(parsed, ids, lib, criteria);
  if (!found) return { status: 'unknown', mediaType: 'series', reason: 'unknownSeries', message: 'Unknown Series' };
  if ('ambiguous' in found) {
    return {
      status: 'ambiguous',
      mediaType: 'series',
      reason: 'unknownSeries',
      message: 'Release matches several series',
      candidates: found.ambiguous,
    };
  }
  const mapped = mapEpisodes(parsed, found.series, lib.episodes(found.series.id));
  if (mapped.episodes.length === 0) {
    return {
      status: 'unknown',
      mediaType: 'series',
      reason: 'unknownEpisode',
      message: 'Unable to identify correct episode(s) using release name and scene mappings',
      series: found.series,
    };
  }
  return { status: 'mapped', mediaType: 'series', series: found.series, ...mapped, matchType: found.matchType };
}

// ---- movies -------------------------------------------------------------------------

function movieKeys(m: Movie): Set<string> {
  const keys = titleKeys(m.title);
  for (const k of titleKeys(m.originalTitle)) keys.add(k);
  if (m.cleanTitle) keys.add(m.cleanTitle);
  return keys;
}

/** Year rule: absent (< 1800) accepts; otherwise exact, or within ±1 when `loose`. */
function yearOk(parsedYear: number, movieYear: number, loose: boolean): boolean {
  if (parsedYear < 1800) return true;
  return loose ? Math.abs(parsedYear - movieYear) <= 1 : parsedYear === movieYear;
}

function movieTitleForms(parsed: ParsedRelease): string[] {
  const m = parsed.movie;
  if (!m) return [];
  const forms = new Set<string>([m.title, m.titleWithoutYear]);
  for (const part of m.title.split(/\s+(?:AKA|A\.K\.A\.?)\s+/i)) if (part.trim()) forms.add(part.trim());
  return [...forms].filter(Boolean);
}

export function matchMovie(parsed: ParsedRelease, ids: ReleaseIds, lib: LibrarySnapshot, criteria?: MatchCriteria): MovieMatch | Unmatched {
  const info = parsed.movie;
  if (!info) return { status: 'unknown', mediaType: 'movie', reason: 'unableToParse', message: 'Unable to parse release' };
  const all = lib.movies();
  const year = info.year;
  const keys = new Set<string>();
  for (const form of movieTitleForms(parsed)) for (const k of titleKeys(form)) keys.add(k);

  const imdb = normalizeImdb(ids.imdbId ?? info.imdbId);
  const tmdb = ids.tmdbId ?? info.tmdbId ?? undefined;

  // 1. Indexer ids, trusted only when the year agrees.
  if (imdb) {
    const hit = all.find((m) => normalizeImdb(m.imdbId) === imdb && yearOk(year, m.year, true));
    if (hit) return { status: 'mapped', mediaType: 'movie', movie: hit, matchType: 'id' };
  }
  if (tmdb) {
    const hit = all.find((m) => m.tmdbId === tmdb && yearOk(year, m.year, true));
    if (hit) return { status: 'mapped', mediaType: 'movie', movie: hit, matchType: 'id' };
  }

  // 2. The searched movie.
  if (criteria?.movieId !== undefined) {
    const searched = all.find((m) => m.id === criteria.movieId);
    if (searched && intersects(keys, movieKeys(searched)) && yearOk(year, searched.year, true)) {
      return { status: 'mapped', mediaType: 'movie', movie: searched, matchType: 'title' };
    }
  }

  // 3. Library-wide: exact year first, then ±1.
  const byTitle = all.filter((m) => intersects(keys, movieKeys(m)));
  for (const loose of [false, true]) {
    const hits = byTitle.filter((m) => yearOk(year, m.year, loose));
    if (hits.length === 1) return { status: 'mapped', mediaType: 'movie', movie: hits[0]!, matchType: 'title' };
    if (hits.length > 1) {
      return {
        status: 'ambiguous',
        mediaType: 'movie',
        reason: 'unknownMovie',
        message: 'Release matches several movies',
        candidates: hits.map((m) => m.id),
      };
    }
  }
  return { status: 'unknown', mediaType: 'movie', reason: 'unknownMovie', message: 'Unknown Movie' };
}

// ---- entry point --------------------------------------------------------------------

export interface MatchOutcome {
  parsed: ParsedRelease;
  match: MatchResult;
}

/**
 * Parse and match a release title. With hint 'auto' the series interpretation is tried
 * first; when it finds nothing, the title is re-parsed as a movie ("Dune Part Two 2024"
 * looks like an episode to a series parser).
 */
export function matchRelease(
  title: string,
  ids: ReleaseIds,
  lib: LibrarySnapshot,
  opts: { hint?: MediaTypeHint; criteria?: MatchCriteria } = {},
): MatchOutcome {
  const hint: MediaTypeHint = opts.criteria?.mediaType ?? opts.hint ?? 'auto';
  const criteria = opts.criteria;
  if (hint === 'series') {
    const parsed = parseRelease(title, 'series');
    return { parsed, match: matchSeries(parsed, ids, lib, criteria) };
  }
  if (hint === 'movie') {
    const parsed = parseRelease(title, 'movie');
    return { parsed, match: matchMovie(parsed, ids, lib, criteria) };
  }
  const parsed = parseRelease(title, 'auto');
  let seriesOutcome: MatchOutcome | null = null;
  if (parsed.series) {
    seriesOutcome = { parsed, match: matchSeries(parsed, ids, lib, criteria) };
    if (seriesOutcome.match.status === 'mapped' || seriesOutcome.match.reason === 'unknownEpisode') return seriesOutcome;
  }
  const asMovie = parsed.movie ? parsed : parseRelease(title, 'movie');
  if (asMovie.movie) {
    const movieOutcome = { parsed: asMovie, match: matchMovie(asMovie, ids, lib, criteria) };
    if (movieOutcome.match.status === 'mapped' || !seriesOutcome) return movieOutcome;
  }
  if (seriesOutcome) return seriesOutcome;
  // Not parseable either way; a special named by episode title is the last chance.
  return { parsed, match: matchSeries(parsed, ids, lib, criteria) };
}
