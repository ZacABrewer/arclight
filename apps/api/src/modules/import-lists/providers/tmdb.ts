import {
  createTmdbClient,
  isMetadataError,
  type DiscoverOptions,
  type MediaKind,
  type SearchResult,
  type TmdbClient,
  type TmdbClientOptions,
} from '@arclight/metadata';
import type { ImportListMediaType, TmdbKeywordSettings, TmdbPopularSettings } from '@arclight/shared';
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
  return { mediaType: r.mediaType, tmdbId: r.tmdbId, title: r.title, year: r.year ?? null };
}

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
  for (const kind of kindsFor(mediaType)) {
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
    const res =
      s.listType === 'trending' ? await client.getTrending(kind, 'week', page) : await client.discover(kind, { ...opts, page });
    for (const r of res.results) {
      if (!inYearRange(r.year, s.yearFrom, s.yearTo)) continue;
      // Discover filters server-side; trending does not, so apply the filters here too.
      if (s.listType === 'trending') {
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
