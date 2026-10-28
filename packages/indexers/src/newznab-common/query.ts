import { DEFAULT_AUDIOBOOK_CATEGORIES, DEFAULT_MUSIC_CATEGORIES, isMovieCategory, isTvCategory } from '../categories.js';
import {
  IndexerError,
  type BookSearchRequest,
  type IndexerCapabilities,
  type IndexerDefinition,
  type MovieSearchRequest,
  type MusicSearchRequest,
  type SearchModeCapabilities,
  type SearchRequest,
  type TvSearchRequest,
} from '../types.js';

export type Flavor = 'torznab' | 'newznab';

/** The `t=` function plus the request-specific parameters, before paging and auth are added. */
export interface SearchPlan {
  t: 'search' | 'tvsearch' | 'movie' | 'music' | 'book';
  params: Array<[string, string]>;
  categories: number[];
}

export interface Paging {
  limit?: number;
  offset?: number;
}

export function apiEndpoint(def: IndexerDefinition): string {
  const base = def.baseUrl.trim().replace(/\/+$/, '');
  const rawPath = (def.apiPath ?? '/api').trim().replace(/\/+$/, '');
  const path = rawPath === '' || rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return `${base}${path}`;
}

function apiKeyOf(def: IndexerDefinition): string | undefined {
  const key = def.apiKey?.trim();
  return key ? key : undefined;
}

function encodePairs(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function withExtrasAndKey(def: IndexerDefinition, query: string): string {
  const extra = def.additionalParameters?.trim().replace(/^[?&]+/, '');
  let result = query;
  if (extra) result += `&${extra}`;
  const key = apiKeyOf(def);
  if (key) result += `&apikey=${encodeURIComponent(key)}`;
  return result;
}

export function buildCapsUrl(def: IndexerDefinition): string {
  const key = apiKeyOf(def);
  return `${apiEndpoint(def)}?t=caps${key ? `&apikey=${encodeURIComponent(key)}` : ''}`;
}

export function buildSearchUrl(def: IndexerDefinition, plan: SearchPlan, paging: Paging = {}): string {
  const pairs: Array<[string, string]> = [['t', plan.t], ...plan.params];
  if (plan.categories.length > 0) pairs.push(['cat', plan.categories.join(',')]);
  pairs.push(['extended', '1']);
  if (paging.limit !== undefined && paging.limit > 0) pairs.push(['limit', String(paging.limit)]);
  if (paging.offset !== undefined && paging.offset > 0) pairs.push(['offset', String(paging.offset)]);
  // ',' in cat= and '/' in ep=MM/DD are read as literal separators by indexers; keep them unescaped.
  const query = encodePairs(pairs).replace(/%2C/g, ',').replace(/%2F/g, '/');
  return `${apiEndpoint(def)}?${withExtrasAndKey(def, query)}`;
}

function unique(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

/**
 * Categories per request kind: movie searches drop standard TV ids, TV searches drop
 * standard movie ids and add the anime categories, music and book searches use their own
 * lists (defaults when unset). RSS and free-text use everything configured, including the
 * music/audiobook lists only when the definition carries them.
 */
export function categoriesFor(def: IndexerDefinition, kind: SearchRequest['kind']): number[] {
  const anime = def.animeCategories ?? [];
  switch (kind) {
    case 'movie':
      return unique(def.categories.filter((id) => !isTvCategory(id)));
    case 'tv':
      return unique([...def.categories.filter((id) => !isMovieCategory(id)), ...anime]);
    case 'music':
      return unique(def.musicCategories ?? DEFAULT_MUSIC_CATEGORIES);
    case 'book':
      return unique(def.audiobookCategories ?? DEFAULT_AUDIOBOOK_CATEGORIES);
    default:
      return unique([...def.categories, ...anime, ...(def.musicCategories ?? []), ...(def.audiobookCategories ?? [])]);
  }
}

/** Newznab documents bare digits; Torznab servers accept and prefer the `tt` form. */
export function formatImdbId(imdbId: string, flavor: Flavor): string | undefined {
  const digits = imdbId.trim().replace(/^tt/i, '');
  if (!/^\d+$/.test(digits)) return undefined;
  const padded = digits.padStart(7, '0');
  return flavor === 'newznab' ? padded : `tt${padded}`;
}

function supports(mode: SearchModeCapabilities, param: string): boolean {
  return mode.available && (mode.supportedParams as readonly string[]).includes(param);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

interface AirDateParts {
  year: string;
  monthDay: string;
  spaced: string;
}

function parseAirDate(airDate: string): AirDateParts | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(airDate.trim());
  if (!match) return undefined;
  const [, y = '', m = '', d = ''] = match;
  return { year: y, monthDay: `${m}/${d}`, spaced: `${y} ${m} ${d}` };
}

function unsupported(message: string): IndexerError {
  return new IndexerError('unsupported-search', message);
}

/** Decide which API function and parameters satisfy a request given the indexer's caps. */
export function planSearch(
  def: IndexerDefinition,
  request: SearchRequest,
  caps: IndexerCapabilities,
  flavor: Flavor,
): SearchPlan {
  const categories = categoriesFor(def, request.kind);
  switch (request.kind) {
    case 'rss':
      return { t: 'search', params: [], categories };
    case 'search': {
      const q = nonEmpty(request.query);
      if (!q) throw unsupported('Free-text search needs a non-empty query');
      if (!caps.searching.search.available) throw unsupported('Indexer does not support free-text search');
      return { t: 'search', params: [['q', q]], categories };
    }
    case 'tv':
      return planTv(request, caps, flavor, categories);
    case 'movie':
      return planMovie(request, caps, flavor, categories);
    case 'music':
      return planMusic(request, caps, categories);
    case 'book':
      return planBook(request, caps, categories);
  }
}

function fallbackTextSearch(
  q: string | undefined,
  caps: IndexerCapabilities,
  categories: number[],
  what: string,
): SearchPlan {
  if (!q) throw unsupported(`Indexer cannot run this ${what} search without a query`);
  if (!caps.searching.search.available) {
    throw unsupported(`Indexer supports neither ${what} search nor free-text search`);
  }
  return { t: 'search', params: [['q', q]], categories };
}

function planTv(
  req: TvSearchRequest,
  caps: IndexerCapabilities,
  flavor: Flavor,
  categories: number[],
): SearchPlan {
  const mode = caps.searching.tvSearch;
  const query = nonEmpty(req.query);
  const airDate = req.airDate === undefined ? undefined : parseAirDate(req.airDate);
  if (req.airDate !== undefined && !airDate) {
    throw unsupported(`Invalid airDate "${req.airDate}", expected YYYY-MM-DD`);
  }

  const ids: Array<[string, string]> = [];
  if (req.tvdbId !== undefined && supports(mode, 'tvdbid')) ids.push(['tvdbid', String(req.tvdbId)]);
  if (req.imdbId !== undefined && supports(mode, 'imdbid')) {
    const imdb = formatImdbId(req.imdbId, flavor);
    if (imdb) ids.push(['imdbid', imdb]);
  }
  if (req.tmdbId !== undefined && supports(mode, 'tmdbid')) ids.push(['tmdbid', String(req.tmdbId)]);

  if (ids.length > 0 || (query !== undefined && supports(mode, 'q'))) {
    const params: Array<[string, string]> = [...ids];
    // Ids are exact; adding q on top makes some indexers return nothing, so q only without ids.
    if (ids.length === 0 && query) params.push(['q', query]);
    if (airDate) {
      if (supports(mode, 'season')) params.push(['season', airDate.year]);
      if (supports(mode, 'ep')) params.push(['ep', airDate.monthDay]);
    } else if (req.season !== undefined && supports(mode, 'season')) {
      params.push(['season', String(req.season)]);
      if (req.episode !== undefined && supports(mode, 'ep')) params.push(['ep', String(req.episode)]);
    }
    return { t: 'tvsearch', params, categories };
  }

  let q = query;
  if (q && airDate) q = `${q} ${airDate.spaced}`;
  else if (q && req.season !== undefined) {
    q = `${q} S${pad2(req.season)}${req.episode === undefined ? '' : `E${pad2(req.episode)}`}`;
  }
  return fallbackTextSearch(q, caps, categories, 'TV');
}

function planMovie(
  req: MovieSearchRequest,
  caps: IndexerCapabilities,
  flavor: Flavor,
  categories: number[],
): SearchPlan {
  const mode = caps.searching.movieSearch;
  const query = nonEmpty(req.query);

  const ids: Array<[string, string]> = [];
  if (req.imdbId !== undefined && supports(mode, 'imdbid')) {
    const imdb = formatImdbId(req.imdbId, flavor);
    if (imdb) ids.push(['imdbid', imdb]);
  }
  if (req.tmdbId !== undefined && supports(mode, 'tmdbid')) ids.push(['tmdbid', String(req.tmdbId)]);

  if (ids.length > 0 || (query !== undefined && supports(mode, 'q'))) {
    const params: Array<[string, string]> = [...ids];
    if (ids.length === 0 && query) params.push(['q', query]);
    if (req.year !== undefined && supports(mode, 'year')) params.push(['year', String(req.year)]);
    return { t: 'movie', params, categories };
  }

  const q = query !== undefined && req.year !== undefined ? `${query} ${req.year}` : query;
  return fallbackTextSearch(q, caps, categories, 'movie');
}

/** Space-joined non-empty parts, or undefined. */
function joined(...parts: Array<string | undefined>): string | undefined {
  return nonEmpty(parts.map((p) => p?.trim() ?? '').filter(Boolean).join(' '));
}

function planMusic(req: MusicSearchRequest, caps: IndexerCapabilities, categories: number[]): SearchPlan {
  const mode = caps.searching.musicSearch;
  const query = nonEmpty(req.query);
  const artist = nonEmpty(req.artist);
  const album = nonEmpty(req.album);
  const label = nonEmpty(req.label);

  if (mode.available) {
    const params: Array<[string, string]> = [];
    // Unsupported structured fields fold into q so they still narrow the search.
    const loose: Array<string | undefined> = [query];
    if (artist) {
      if (supports(mode, 'artist')) params.push(['artist', artist]);
      else loose.push(artist);
    }
    if (album) {
      if (supports(mode, 'album')) params.push(['album', album]);
      else loose.push(album);
    }
    if (label && supports(mode, 'label')) params.push(['label', label]);
    const q = joined(...loose);
    if (q && supports(mode, 'q')) params.unshift(['q', q]);
    if (params.length > 0) {
      if (req.year !== undefined && supports(mode, 'year')) params.push(['year', String(req.year)]);
      return { t: 'music', params, categories };
    }
  }

  return fallbackTextSearch(query ?? joined(artist, album), caps, categories, 'music');
}

function planBook(req: BookSearchRequest, caps: IndexerCapabilities, categories: number[]): SearchPlan {
  const mode = caps.searching.bookSearch;
  const query = nonEmpty(req.query);
  const author = nonEmpty(req.author);
  const title = nonEmpty(req.title);

  if (mode.available) {
    const params: Array<[string, string]> = [];
    const loose: Array<string | undefined> = [query];
    if (author) {
      if (supports(mode, 'author')) params.push(['author', author]);
      else loose.push(author);
    }
    if (title) {
      if (supports(mode, 'title')) params.push(['title', title]);
      else loose.push(title);
    }
    const q = joined(...loose);
    if (q && supports(mode, 'q')) params.unshift(['q', q]);
    if (params.length > 0) return { t: 'book', params, categories };
  }

  return fallbackTextSearch(query ?? joined(author, title), caps, categories, 'book');
}
