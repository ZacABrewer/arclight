import {
  createTmdbClient,
  isMetadataError,
  type DiscoverOptions,
  type MediaKind,
  type SearchResult,
  type TmdbClient,
  type TmdbClientOptions,
} from '@arclight/metadata';
import type {
  ImportListMediaType,
  TmdbCompanySettings,
  TmdbDiscoverSettings,
  TmdbKeywordSettings,
  TmdbNetworkSettings,
  TmdbPopularSettings,
} from '@arclight/shared';
import { ImportListFetchError } from '../errors.js';
import { asArray, asRecord, getJson, int, str } from './http.js';
import { inYearRange, wants, yearOf, type FetchedItem, type FetchLike, type Provider, type TmdbAccess } from './types.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
/** Safety cap on pages walked for one list. */
const MAX_PAGES = 25;

export interface TmdbAccessOptions {
  apiKey: string;
  language: string;
  region: string;
  fetch: FetchLike;
  createClient?: (options: TmdbClientOptions) => TmdbClient;
}

/** The shared TMDB client plus a raw GET for the endpoints it does not wrap. */
export function createTmdbAccess(opts: TmdbAccessOptions): TmdbAccess {
  const client = (opts.createClient ?? createTmdbClient)({
    apiKey: opts.apiKey,
    language: opts.language,
    region: opts.region,
    fetchImpl: opts.fetch,
  });
  return {
    client,
    async get(path, params = {}) {
      const url = new URL(`${TMDB_BASE}${path}`);
      url.searchParams.set('api_key', opts.apiKey);
      url.searchParams.set('language', opts.language);
      for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
      return getJson({ fetch: opts.fetch }, 'TMDB', url.toString());
    },
  };
}

/** Turn the metadata package's errors into fetch errors so sync reports them uniformly. */
export async function withTmdbErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ImportListFetchError) throw err;
    if (isMetadataError(err, 'unauthorized')) throw new ImportListFetchError('auth', 'TMDB rejected the configured API key');
    if (isMetadataError(err, 'not-found')) throw new ImportListFetchError('not-found', 'TMDB has no such list');
    if (isMetadataError(err, 'rate-limited')) throw new ImportListFetchError('rate-limited', 'TMDB rate limit exceeded');
    if (isMetadataError(err, 'unreachable')) throw new ImportListFetchError('unreachable', 'TMDB is unreachable');
    if (isMetadataError(err)) throw new ImportListFetchError('bad-response', err instanceof Error ? err.message : 'TMDB error');
    throw err;
  }
}

/** A raw TMDB row (list item, collection part, credit, discover result). */
function fromRaw(raw: unknown, fallbackKind?: 'series' | 'movie'): FetchedItem | null {
  const r = asRecord(raw);
  if (!r) return null;
  const tmdbId = int(r['id']);
  if (tmdbId === null) return null;
  const mt = str(r['media_type']);
  const mediaType = mt === 'tv' ? 'series' : mt === 'movie' ? 'movie' : fallbackKind;
  if (!mediaType) return null;
  const title = str(mediaType === 'series' ? (r['name'] ?? r['title']) : (r['title'] ?? r['name'])) ?? `TMDB ${tmdbId}`;
  const date = str(mediaType === 'series' ? r['first_air_date'] : r['release_date']);
  return { mediaType, tmdbId, title, year: yearOf(date) };
}

function fromSearchResult(r: SearchResult): FetchedItem {
  const item: FetchedItem = { mediaType: r.mediaType, tmdbId: r.tmdbId, title: r.title, year: r.year ?? null };
  if (r.ratings.tmdb.votes > 0) {
    item.rating = r.ratings.tmdb.value;
    item.votes = r.ratings.tmdb.votes;
  }
  return item;
}

/** Ready-made TMDB lists that only exist for one kind. */
const LIST_KINDS: Partial<Record<TmdbPopularSettings['listType'], MediaKind>> = {
  nowPlaying: 'movie',
  upcoming: 'movie',
  airingToday: 'tv',
  onTheAir: 'tv',
};

function kindsFor(mediaType: ImportListMediaType): MediaKind[] {
  const kinds: MediaKind[] = [];
  if (wants(mediaType, 'series')) kinds.push('tv');
  if (wants(mediaType, 'movie')) kinds.push('movie');
  return kinds;
}

function voteAverage(r: SearchResult): number | null {
  return r.ratings.tmdb.votes > 0 ? r.ratings.tmdb.value : null;
}

// ---- providers ------------------------------------------------------------------------

export const tmdbList: Provider<'tmdbList'> = async (settings, mediaType, ctx) => {
  const tmdb = ctx.tmdb();
  const out: FetchedItem[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = asRecord(await tmdb.get(`/list/${encodeURIComponent(settings.listId)}`, { page }));
    for (const raw of asArray(body?.['items'])) {
      const item = fromRaw(raw);
      if (item && wants(mediaType, item.mediaType)) out.push(item);
    }
    const totalPages = int(body?.['total_pages']) ?? 1;
    if (page >= totalPages) break;
  }
  return out;
};

export const tmdbPopular: Provider<'tmdbPopular'> = async (settings, mediaType, ctx) => {
  const { client } = ctx.tmdb();
  const out: FetchedItem[] = [];
  const only = LIST_KINDS[settings.listType];
  for (const kind of kindsFor(mediaType)) {
    if (only && only !== kind) continue;
    const items = await withTmdbErrors(() => walkPopular(client, kind, settings));
    out.push(...items);
  }
  return out;
};

async function walkPopular(client: TmdbClient, kind: MediaKind, s: TmdbPopularSettings): Promise<FetchedItem[]> {
  const out: FetchedItem[] = [];
  const minVotes = s.listType === 'topRated' ? Math.max(s.minVotes ?? 0, 200) : s.minVotes;
  const opts: DiscoverOptions = {
    sortBy: s.listType === 'topRated' ? 'vote_average.desc' : 'popularity.desc',
    ...(s.genreIds.length ? { withGenres: s.genreIds.join('|') } : {}),
    ...(s.languages.length ? { withOriginalLanguage: s.languages.join('|') } : {}),
    ...(s.minVoteAverage !== undefined ? { voteAverageGte: s.minVoteAverage } : {}),
    ...(minVotes !== undefined ? { voteCountGte: minVotes } : {}),
    ...(s.yearFrom !== undefined && s.yearFrom === s.yearTo ? { year: s.yearFrom } : {}),
  };
  const languages = new Set(s.languages.map((l) => l.toLowerCase()));
  for (let page = 1; page <= MAX_PAGES && out.length < s.limit; page++) {
    const ready = s.listType !== 'popular' && s.listType !== 'topRated' && s.listType !== 'trending';
    const res =
      s.listType === 'trending'
        ? await client.getTrending(kind, 'week', page)
        : ready
          ? await client.getList(kind, s.listType, page)
          : await client.discover(kind, { ...opts, page });
    for (const r of res.results) {
      if (!inYearRange(r.year, s.yearFrom, s.yearTo)) continue;
      // Discover filters server-side; trending and the ready-made lists do not, so filter here.
      if (s.listType === 'trending' || ready) {
        if (languages.size && !languages.has(r.originalLanguage.toLowerCase())) continue;
        const avg = voteAverage(r);
        if (s.minVoteAverage !== undefined && (avg === null || avg < s.minVoteAverage)) continue;
      }
      out.push(fromSearchResult(r));
      if (out.length >= s.limit) break;
    }
    if (page >= res.totalPages) break;
  }
  return out;
}

export const tmdbCollection: Provider<'tmdbCollection'> = async (settings, mediaType, ctx) => {
  if (!wants(mediaType, 'movie')) return [];
  const body = asRecord(await ctx.tmdb().get(`/collection/${settings.collectionId}`));
  return asArray(body?.['parts'])
    .map((raw) => fromRaw(raw, 'movie'))
    .filter((i): i is FetchedItem => i !== null && i.mediaType === 'movie');
};

export const tmdbPerson: Provider<'tmdbPerson'> = async (settings, mediaType, ctx) => {
  const body = asRecord(await ctx.tmdb().get(`/person/${settings.personId}/combined_credits`));
  const jobs = new Set(settings.crewJobs.map((j) => j.toLowerCase()));
  const rows: unknown[] = [];
  if (settings.includeCast) rows.push(...asArray(body?.['cast']));
  if (settings.includeCrew) {
    for (const raw of asArray(body?.['crew'])) {
      const job = str(asRecord(raw)?.['job'])?.toLowerCase();
      if (jobs.size === 0 || (job && jobs.has(job))) rows.push(raw);
    }
  }
  return rows.map((raw) => fromRaw(raw)).filter((i): i is FetchedItem => i !== null && wants(mediaType, i.mediaType));
};

export const tmdbKeyword: Provider<'tmdbKeyword'> = async (settings, mediaType, ctx) => {
  const tmdb = ctx.tmdb();
  const out: FetchedItem[] = [];
  for (const kind of kindsFor(mediaType)) out.push(...(await walkKeyword(tmdb, kind, settings)));
  return out;
};

async function walkKeyword(tmdb: TmdbAccess, kind: MediaKind, s: TmdbKeywordSettings): Promise<FetchedItem[]> {
  const dateField = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
  const params: Record<string, string | number | undefined> = {
    with_keywords: s.keywordId,
    sort_by: 'popularity.desc',
    'vote_average.gte': s.minVoteAverage,
    'vote_count.gte': s.minVotes,
    with_genres: s.genreIds.length ? s.genreIds.join('|') : undefined,
    with_original_language: s.languages.length ? s.languages.join('|') : undefined,
    [`${dateField}.gte`]: s.yearFrom !== undefined ? `${s.yearFrom}-01-01` : undefined,
    [`${dateField}.lte`]: s.yearTo !== undefined ? `${s.yearTo}-12-31` : undefined,
  };
  const fallback = kind === 'movie' ? 'movie' : 'series';
  const out: FetchedItem[] = [];
  for (let page = 1; page <= MAX_PAGES && out.length < s.limit; page++) {
    const body = asRecord(await tmdb.get(`/discover/${kind}`, { ...params, page }));
    for (const raw of asArray(body?.['results'])) {
      const item = fromRaw(raw, fallback);
      if (item) out.push(item);
      if (out.length >= s.limit) break;
    }
    if (page >= (int(body?.['total_pages']) ?? 1)) break;
  }
  return out;
}

// ---- discover-backed lists (company, network, any discover filter) ----------------------

type DiscoverFilters = Pick<TmdbDiscoverSettings, 'minVoteAverage' | 'minVotes' | 'yearFrom' | 'yearTo' | 'languages' | 'genreIds' | 'limit'>;

/** DiscoverOptions for the shared TMDB filters. */
export function discoverOptions(s: DiscoverFilters, extra: DiscoverOptions = {}): DiscoverOptions {
  return {
    sortBy: 'popularity.desc',
    ...(s.genreIds.length ? { withGenres: s.genreIds.join('|') } : {}),
    ...(s.languages.length ? { withOriginalLanguage: s.languages.join('|') } : {}),
    ...(s.minVoteAverage !== undefined ? { voteAverageGte: s.minVoteAverage } : {}),
    ...(s.minVotes !== undefined ? { voteCountGte: s.minVotes } : {}),
    ...(s.yearFrom !== undefined ? { releaseDateGte: `${s.yearFrom}-01-01` } : {}),
    ...(s.yearTo !== undefined ? { releaseDateLte: `${s.yearTo}-12-31` } : {}),
    ...extra,
  };
}

async function walkDiscover(client: TmdbClient, kind: MediaKind, opts: DiscoverOptions, limit: number): Promise<FetchedItem[]> {
  const out: FetchedItem[] = [];
  for (let page = 1; page <= MAX_PAGES && out.length < limit; page++) {
    const res = await withTmdbErrors(() => client.discover(kind, { ...opts, page }));
    for (const r of res.results) {
      out.push(fromSearchResult(r));
      if (out.length >= limit) break;
    }
    if (page >= res.totalPages) break;
  }
  return out;
}

export const tmdbCompany: Provider<'tmdbCompany'> = async (s: TmdbCompanySettings, mediaType, ctx) => {
  const { client } = ctx.tmdb();
  const out: FetchedItem[] = [];
  // TMDB only filters movies by company; series use networks (see tmdbNetwork).
  if (wants(mediaType, 'movie')) {
    out.push(...(await walkDiscover(client, 'movie', discoverOptions(s, { withCompanies: String(s.companyId) }), s.limit)));
  }
  return out;
};

export const tmdbNetwork: Provider<'tmdbNetwork'> = async (s: TmdbNetworkSettings, mediaType, ctx) => {
  if (!wants(mediaType, 'series')) return [];
  const { client } = ctx.tmdb();
  return walkDiscover(client, 'tv', discoverOptions(s, { withNetworks: String(s.networkId) }), s.limit);
};

export const tmdbDiscover: Provider<'tmdbDiscover'> = async (s: TmdbDiscoverSettings, mediaType, ctx) => {
  const { client } = ctx.tmdb();
  const out: FetchedItem[] = [];
  for (const kind of kindsFor(mediaType)) {
    // Series have no release date or revenue sort; map to their equivalents.
    let sortBy: string = s.sortBy;
    if (kind === 'tv' && sortBy === 'primary_release_date.desc') sortBy = 'first_air_date.desc';
    if (kind === 'tv' && sortBy === 'revenue.desc') sortBy = 'popularity.desc';
    // Companies filter movies only and networks filter series only: a list that names
    // networks has no movie half, and one that names companies has no series half.
    if (kind === 'movie' && s.networkIds.length && !s.companyIds.length) continue;
    if (kind === 'tv' && s.companyIds.length && !s.networkIds.length) continue;
    const extra: DiscoverOptions = {
      sortBy,
      ...(s.keywordIds.length ? { withKeywords: s.keywordIds.join('|') } : {}),
      ...(kind === 'movie' && s.companyIds.length ? { withCompanies: s.companyIds.join('|') } : {}),
      ...(kind === 'tv' && s.networkIds.length ? { withNetworks: s.networkIds.join('|') } : {}),
      ...(s.watchProviderIds.length
        ? { withWatchProviders: s.watchProviderIds.join('|'), ...(s.watchRegion ? { watchRegion: s.watchRegion } : {}) }
        : {}),
      ...(s.certificationLte ? { certificationLte: s.certificationLte } : {}),
      ...(s.runtimeMin !== undefined ? { withRuntimeGte: s.runtimeMin } : {}),
      ...(s.runtimeMax !== undefined ? { withRuntimeLte: s.runtimeMax } : {}),
      ...(sortBy === 'vote_average.desc' && s.minVotes === undefined ? { voteCountGte: 200 } : {}),
    };
    out.push(...(await walkDiscover(client, kind, discoverOptions(s, extra), s.limit)));
  }
  return out;
};
