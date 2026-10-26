import { DISCOVER_MOVIE_SORTS, DISCOVER_TV_SORTS, type DiscoverQuery } from '@arclight/shared';

// Browse filters live in the URL (?sort=vote_average.desc&genres=18,35&from=1990 ...) so a
// filtered grid can be shared, bookmarked and restored with Back. Everything is optional and
// invalid values are dropped, never errors.

export type BrowseKind = 'movie' | 'tv';

export interface BrowseSearch {
  sort?: string;
  /** Genre ids, comma separated (titles matching any of them). */
  genres?: string;
  /** Year range. */
  from?: string;
  to?: string;
  ratingMin?: string;
  ratingMax?: string;
  /** Minimum number of votes (keeps one-vote 10/10 titles out of rating sorts). */
  votesMin?: string;
  runtimeMin?: string;
  runtimeMax?: string;
  /** Original language (ISO-639-1). */
  lang?: string;
  /** Highest certification. */
  cert?: string;
  /** Watch provider ids, comma separated (any of them). */
  providers?: string;
  /** Region for providers and certifications. */
  region?: string;
  /** Keyword ids, comma separated (any of them). */
  keywords?: string;
  hideAvailable?: boolean;
  hideRequested?: boolean;
}

export const BROWSE_KEYS: readonly (keyof BrowseSearch)[] = [
  'sort',
  'genres',
  'from',
  'to',
  'ratingMin',
  'ratingMax',
  'votesMin',
  'runtimeMin',
  'runtimeMax',
  'lang',
  'cert',
  'providers',
  'region',
  'keywords',
  'hideAvailable',
  'hideRequested',
];

const str = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s.slice(0, 200);
};
const flag = (v: unknown): boolean | undefined => (v === true || v === 'true' || v === '1' || v === 1 ? true : undefined);
const ids = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const list = [...new Set(s.split(/[,|]/).filter((x) => /^\d+$/.test(x)))];
  return list.length ? list.join(',') : undefined;
};
const year = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^\d{4}$/.test(s) ? s : undefined;
};
const number = (v: unknown, min: number, max: number): string | undefined => {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= min && n <= max ? String(n) : undefined;
};

/** Route validateSearch: the URL query → BrowseSearch (unknown keys and bad values dropped). */
export function parseBrowseSearch(raw: Record<string, unknown>): BrowseSearch {
  const out: BrowseSearch = {};
  const sort = str(raw['sort']);
  if (sort && /^[a-z_]+\.(asc|desc)$/.test(sort)) out.sort = sort;
  const set = <K extends keyof BrowseSearch>(k: K, v: BrowseSearch[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set('genres', ids(raw['genres']));
  set('from', year(raw['from']));
  set('to', year(raw['to']));
  set('ratingMin', number(raw['ratingMin'], 0, 10));
  set('ratingMax', number(raw['ratingMax'], 0, 10));
  set('votesMin', number(raw['votesMin'], 0, 1_000_000));
  set('runtimeMin', number(raw['runtimeMin'], 0, 1000));
  set('runtimeMax', number(raw['runtimeMax'], 0, 1000));
  const lang = str(raw['lang'])?.toLowerCase();
  if (lang && /^[a-z]{2,3}$/.test(lang)) out.lang = lang;
  const cert = str(raw['cert']);
  if (cert && cert.length <= 12) out.cert = cert;
  set('providers', ids(raw['providers']));
  const region = str(raw['region'])?.toUpperCase();
  if (region && /^[A-Z]{2}$/.test(region)) out.region = region;
  set('keywords', ids(raw['keywords']));
  set('hideAvailable', flag(raw['hideAvailable']));
  set('hideRequested', flag(raw['hideRequested']));
  return out;
}

/** How many filters differ from the defaults (drives the Clear button). */
export function activeFilterCount(s: BrowseSearch): number {
  return BROWSE_KEYS.filter((k) => k !== 'sort' && k !== 'region' && s[k] !== undefined).length + (s.sort && s.sort !== 'popularity.desc' ? 1 : 0);
}

/** Merge a change into the current search, dropping emptied keys. */
export function patchSearch(prev: BrowseSearch, patch: Partial<Record<keyof BrowseSearch, string | boolean | undefined>>): BrowseSearch {
  return parseBrowseSearch({ ...prev, ...patch });
}

export function sortsFor(kind: BrowseKind): readonly string[] {
  return kind === 'movie' ? DISCOVER_MOVIE_SORTS : DISCOVER_TV_SORTS;
}

/** The same sort on the other media type (release date ↔ first air date, title ↔ name). */
export function sortFor(kind: BrowseKind, sort: string | undefined): string {
  if (!sort) return 'popularity.desc';
  const swapped =
    kind === 'movie'
      ? sort.replace('first_air_date', 'primary_release_date').replace('original_name', 'original_title')
      : sort.replace('primary_release_date', 'first_air_date').replace('original_title', 'original_name').replace(/^revenue\./, 'popularity.');
  return sortsFor(kind).includes(swapped) ? swapped : 'popularity.desc';
}

/** Filters a page fixes (genre page → its genre, studio page → its studio, ...). */
export type BrowseLock = Pick<DiscoverQuery, 'genre' | 'keywords' | 'studio' | 'network' | 'watchProviders' | 'watchRegion'>;

/** BrowseSearch (+ what the page fixes) → the api query, page excluded. */
export function browseQuery(kind: BrowseKind, s: BrowseSearch, lock: BrowseLock = {}): Omit<DiscoverQuery, 'page'> {
  const q: Omit<DiscoverQuery, 'page'> = { sortBy: sortFor(kind, s.sort) };
  // Genres picked in the filter bar match any of them (TMDB "|"); on a genre page they narrow
  // the page's own genre (TMDB ",": all of them).
  const picked = idList(s.genres).filter((g) => String(g) !== lock.genre);
  if (lock.genre) q.genre = [lock.genre, ...picked].join(',');
  else if (picked.length) q.genre = picked.join('|');
  const keywords = [lock.keywords, s.keywords].filter(Boolean).join('|');
  if (keywords) q.keywords = keywords;
  if (lock.studio) q.studio = lock.studio;
  if (lock.network) q.network = lock.network;
  const providers = [lock.watchProviders, s.providers].filter(Boolean).join('|');
  if (providers) {
    q.watchProviders = providers.split(/[,|]/).join('|');
    const region = lock.watchRegion ?? s.region;
    if (region) q.watchRegion = region;
  }
  if (s.from) q.releaseDateGte = `${s.from}-01-01`;
  if (s.to) q.releaseDateLte = `${s.to}-12-31`;
  if (s.ratingMin) q.voteAverageGte = Number(s.ratingMin);
  if (s.ratingMax) q.voteAverageLte = Number(s.ratingMax);
  if (s.votesMin) q.voteCountGte = Math.floor(Number(s.votesMin));
  else if (q.sortBy?.startsWith('vote_average')) q.voteCountGte = 100;
  if (s.runtimeMin) q.runtimeGte = Math.floor(Number(s.runtimeMin));
  if (s.runtimeMax) q.runtimeLte = Math.floor(Number(s.runtimeMax));
  if (s.lang) q.language = s.lang;
  if (s.cert) {
    q.certificationLte = s.cert;
    if (s.region) q.certificationCountry = s.region;
  }
  if (s.hideAvailable) q.hideAvailable = true;
  if (s.hideRequested) q.hideRequested = true;
  return q;
}

/** "18,35" → [18, 35]. */
export function idList(v: string | undefined): number[] {
  return (v ?? '').split(/[,|]/).filter((x) => /^\d+$/.test(x)).map(Number);
}

/** Toggle one id in a comma list. */
export function toggleId(v: string | undefined, id: number): string | undefined {
  const list = idList(v);
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  return next.length ? next.join(',') : undefined;
}
