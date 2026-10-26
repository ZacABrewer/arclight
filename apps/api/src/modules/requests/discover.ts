import { and, desc, eq, inArray, asc } from 'drizzle-orm';
import type { DiscoverOptions, MediaKind, MovieMetadata, PagedResults, SearchResult, SeriesMetadata, TmdbClient, TmdbListName } from '@arclight/metadata';
import {
  BUILT_IN_SLIDERS,
  CollectionRequestInput,
  DISCOVER_MOVIE_SORTS,
  DISCOVER_TV_SORTS,
  DiscoverKindQuery,
  DiscoverListQuery,
  DiscoverQuery,
  DiscoverSearchQuery,
  DiscoverSliderInput,
  DiscoverTextQuery,
  PERSONAL_SLIDERS,
  POPULAR_NETWORKS,
  POPULAR_STUDIOS,
  Permission,
  TrendingQuery,
  type CollectionDetail,
  type CollectionRequestResult,
  type DiscoverEntity,
  type DiscoverEntityKind,
  type DiscoverFilterOptions,
  type DiscoverGenre,
  type DiscoverItem,
  type DiscoverListName,
  type DiscoverPage,
  type DiscoverSlider,
  type DiscoverSliderOrder,
  type DiscoverSliderUpdate,
  type DiscoverTile,
  type KeywordPage,
  type MediaImage,
  type MediaType,
  type PersonCredit,
  type PersonDetail,
  type PersonPage,
  type TitleDetail,
  type TitleSeason,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { movies, series } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { getSection } from '../settings/service.js';
import { DETAIL_TTL_MS, DiscoverCache, LIST_TTL_MS, STATIC_TTL_MS } from './discover-cache.js';
import { RequestsError } from './errors.js';
import type { IssuesService } from './issues.js';
import { type Actor, can, canManageSettings, canRequest, canRequestAdvanced } from './permissions.js';
import { discoverSliders, mediaRequests } from './schema.js';
import type { RequestsService } from './service.js';
import { userPermissions, findUserRow } from './users.js';
import type { WatchlistService } from './watchlist.js';

// Discover (docs/spec/requests.md section 15): TMDB lists and title pages, each result
// annotated with Arclight's status (library + requests), plus the slider configuration.
// TMDB data goes through a DiscoverCache (see discover-cache.ts for the TTLs); the status
// overlay is computed per response with one batched query per media type.

type SliderRow = typeof discoverSliders.$inferSelect;

export interface DiscoverServiceOptions {
  db: Db;
  bus: EventBus;
  requests: RequestsService;
  issues: IssuesService;
  watchlist: WatchlistService;
  /** Injectable for tests. */
  cache?: DiscoverCache;
}

/** List-type sliders the web renders itself (genre tiles, studio/network/provider logos). */
const LIST_SLIDERS = new Set(['movieGenres', 'tvGenres', 'studios', 'networks', 'providers']);

/** TMDB lists behind each ready-made list name. */
const LISTS: Record<Exclude<DiscoverListName, 'upcomingMovies' | 'upcomingTv'>, { kind: MediaKind; list: TmdbListName }> = {
  popularMovies: { kind: 'movie', list: 'popular' },
  popularTv: { kind: 'tv', list: 'popular' },
  nowPlaying: { kind: 'movie', list: 'nowPlaying' },
  topRatedMovies: { kind: 'movie', list: 'topRated' },
  topRatedTv: { kind: 'tv', list: 'topRated' },
  airingToday: { kind: 'tv', list: 'airingToday' },
  onTheAir: { kind: 'tv', list: 'onTheAir' },
};

/** How many genre tiles get a backdrop looked up (one TMDB discover call each, cached a day). */
const MAX_GENRE_TILES = 24;

function localDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function videoUrl(site: string, key: string): string | undefined {
  const s = site.toLowerCase();
  if (s === 'youtube') return `https://www.youtube.com/watch?v=${encodeURIComponent(key)}`;
  if (s === 'vimeo') return `https://vimeo.com/${encodeURIComponent(key)}`;
  return undefined;
}

function imageOf(images: MediaImage[], cover: 'poster' | 'fanart'): string | null {
  const img = images.find((i) => i.coverType === cover);
  return img ? (img.remoteUrl ?? img.url) : null;
}

const dateOnly = (iso: string | undefined | null): string | null => (iso ? iso.slice(0, 10) : null);

interface EnrichOptions {
  /** Apply Settings > Requests hideAvailable / hideRequested. */
  filter?: boolean;
  /** Per-query hides (browse filter bar), on top of the settings. */
  hideAvailable?: boolean | undefined;
  hideRequested?: boolean | undefined;
}

export class DiscoverService {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly requests: RequestsService;
  private readonly issues: IssuesService;
  private readonly watchlist: WatchlistService;
  readonly cache: DiscoverCache;

  constructor(opts: DiscoverServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.requests = opts.requests;
    this.issues = opts.issues;
    this.watchlist = opts.watchlist;
    this.cache = opts.cache ?? new DiscoverCache();
    // A new TMDB key, language or region makes every cached page stale.
    this.bus.subscribe((event) => {
      if (event.type === 'settings' && event.section === 'metadata') this.cache.clear();
    });
  }

  private client(): TmdbClient {
    try {
      return this.requests.titles.client();
    } catch (err) {
      throw new RequestsError('NOT_CONFIGURED', err instanceof Error ? err.message : 'TMDB is not configured');
    }
  }

  /** Runs a TMDB call and maps its errors. */
  private async tmdb<T>(fn: (c: TmdbClient) => Promise<T>): Promise<T> {
    const client = this.client();
    try {
      return await fn(client);
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? (err as { code: unknown }).code : undefined;
      if (code === 'not-found') throw new RequestsError('NOT_FOUND', 'TMDB has no such item');
      if (code === 'unauthorized') throw new RequestsError('NOT_CONFIGURED', 'TMDB rejected the API key');
      if (typeof code === 'string') throw new RequestsError('UPSTREAM', err instanceof Error ? err.message : 'TMDB failed');
      throw err;
    }
  }

  /** A TMDB call through the discover cache. `key` must identify the call and its arguments. */
  private cached<T>(key: string, ttlMs: number, fn: (c: TmdbClient) => Promise<T>): Promise<T> {
    return this.cache.get(key, ttlMs, () => this.tmdb(fn));
  }

  /** Instance TMDB region and language (Settings > Metadata). */
  private locale(): { region: string; language: string } {
    const m = getSection(this.db, 'metadata');
    return { region: m.region.toUpperCase(), language: m.language };
  }

  // -------------------------------------------------------------------------------------
  // enrichment
  // -------------------------------------------------------------------------------------

  /** Titles whose newest normal-track request was declined (and none is active), batched per type. */
  private declined(type: MediaType, tmdbIds: readonly number[]): Set<number> {
    const ids = [...new Set(tmdbIds)];
    if (ids.length === 0) return new Set();
    const rows = this.db
      .select({ tmdbId: mediaRequests.tmdbId, status: mediaRequests.status })
      .from(mediaRequests)
      .where(and(eq(mediaRequests.type, type), eq(mediaRequests.is4k, false), inArray(mediaRequests.tmdbId, ids)))
      .orderBy(desc(mediaRequests.id))
      .all();
    const newest = new Map<number, string>();
    for (const r of rows) if (!newest.has(r.tmdbId)) newest.set(r.tmdbId, r.status);
    return new Set([...newest].filter(([, status]) => status === 'declined').map(([id]) => id));
  }

  /**
   * Annotates TMDB results with library/request status: one batched lookup per media type
   * however many results there are. `filter` applies hideAvailable/hideRequested.
   */
  enrich(results: readonly SearchResult[], opts: EnrichOptions = {}): DiscoverItem[] {
    const idsOf = (type: MediaType) => results.filter((r) => r.mediaType === type).map((r) => r.tmdbId);
    const statuses = {
      movie: this.requests.titleStatuses('movie', idsOf('movie')),
      series: this.requests.titleStatuses('series', idsOf('series')),
    };
    const declined = { movie: this.declined('movie', idsOf('movie')), series: this.declined('series', idsOf('series')) };
    const settings = opts.filter ? this.requests.settings() : null;
    const hideAvailable = (settings?.hideAvailable ?? false) || opts.hideAvailable === true;
    const hideRequested = (settings?.hideRequested ?? false) || opts.hideRequested === true;
    const items: DiscoverItem[] = [];
    for (const r of results) {
      const st = statuses[r.mediaType].get(r.tmdbId);
      const request = st?.request ?? null;
      const item: DiscoverItem = {
        mediaType: r.mediaType,
        tmdbId: r.tmdbId,
        title: r.title,
        originalTitle: r.originalTitle,
        year: r.year ?? null,
        overview: r.overview,
        posterUrl: r.images.poster ?? null,
        backdropUrl: r.images.backdrop ?? null,
        rating: r.ratings.tmdb.value,
        voteCount: r.ratings.tmdb.votes,
        popularity: r.popularity ?? null,
        releaseDate: (r.mediaType === 'movie' ? r.releaseDate : r.firstAired) ?? null,
        originalLanguage: r.originalLanguage,
        mediaStatus: st?.status ?? 'unknown',
        mediaStatus4k: st?.status4k ?? 'unknown',
        requestId: request?.id ?? null,
        requestStatus: request?.status ?? (declined[r.mediaType].has(r.tmdbId) ? 'declined' : null),
        libraryId: st?.libraryId ?? null,
      };
      if (hideAvailable && item.mediaStatus === 'available') continue;
      if (hideRequested && (item.requestStatus === 'pending' || item.requestStatus === 'approved')) continue;
      items.push(item);
    }
    return items;
  }

  private page(raw: PagedResults<SearchResult>, extra: { title?: string; imageUrl?: string } = {}, hide: EnrichOptions = {}): DiscoverPage {
    return {
      page: raw.page,
      // TMDB serves at most 500 pages of any list.
      totalPages: Math.min(raw.totalPages, 500),
      totalResults: raw.totalResults,
      results: this.enrich(raw.results, { ...hide, filter: true }),
      ...(extra.title ? { title: extra.title } : {}),
      ...(extra.imageUrl ? { imageUrl: extra.imageUrl } : {}),
    };
  }

  // -------------------------------------------------------------------------------------
  // lists
  // -------------------------------------------------------------------------------------

  private options(kind: 'movie' | 'tv', q: DiscoverQuery): DiscoverOptions {
    const parsed = DiscoverQuery.parse(q);
    const sorts: readonly string[] = kind === 'movie' ? DISCOVER_MOVIE_SORTS : DISCOVER_TV_SORTS;
    const opts: DiscoverOptions = {
      page: parsed.page,
      // Invalid sort values fall back to the default (section 15.4).
      sortBy: parsed.sortBy && sorts.includes(parsed.sortBy) ? parsed.sortBy : 'popularity.desc',
    };
    if (parsed.genre) opts.withGenres = parsed.genre;
    if (parsed.keywords) opts.withKeywords = parsed.keywords;
    if (parsed.language) opts.withOriginalLanguage = parsed.language;
    if (parsed.voteAverageGte !== undefined) opts.voteAverageGte = parsed.voteAverageGte;
    if (parsed.voteAverageLte !== undefined) opts.voteAverageLte = parsed.voteAverageLte;
    if (parsed.voteCountGte !== undefined) opts.voteCountGte = parsed.voteCountGte;
    if (parsed.runtimeGte !== undefined) opts.withRuntimeGte = parsed.runtimeGte;
    if (parsed.runtimeLte !== undefined) opts.withRuntimeLte = parsed.runtimeLte;
    if (parsed.watchProviders) opts.withWatchProviders = parsed.watchProviders;
    if (parsed.watchRegion) opts.watchRegion = parsed.watchRegion;
    if (parsed.certification) opts.certification = parsed.certification;
    if (parsed.certificationLte) opts.certificationLte = parsed.certificationLte;
    if (parsed.certificationCountry) opts.certificationCountry = parsed.certificationCountry;
    if (kind === 'movie' && parsed.studio) opts.withCompanies = String(parsed.studio);
    if (kind === 'tv' && parsed.network) opts.withNetworks = String(parsed.network);
    // TMDB needs both ends of a date range (section 15.3.3).
    if (parsed.releaseDateGte || parsed.releaseDateLte) {
      opts.releaseDateGte = parsed.releaseDateGte ?? '1900-01-01';
      opts.releaseDateLte = parsed.releaseDateLte ?? '2999-12-31';
    }
    return opts;
  }

  private discoverCall(kind: MediaKind, opts: DiscoverOptions): Promise<PagedResults<SearchResult>> {
    return this.cached(`discover:${kind}:${JSON.stringify(opts)}`, LIST_TTL_MS, (c) => c.discover(kind, opts));
  }

  async movies(q: DiscoverQuery): Promise<DiscoverPage> {
    const parsed = DiscoverQuery.parse(q);
    return this.page(await this.discoverCall('movie', this.options('movie', q)), {}, parsed);
  }

  async tv(q: DiscoverQuery): Promise<DiscoverPage> {
    const parsed = DiscoverQuery.parse(q);
    return this.page(await this.discoverCall('tv', this.options('tv', q)), {}, parsed);
  }

  async trending(raw: TrendingQuery): Promise<DiscoverPage> {
    const q = TrendingQuery.parse(raw);
    return this.page(await this.cached(`trending:${q.mediaType}:${q.timeWindow}:${q.page}`, LIST_TTL_MS, (c) => c.getTrending(q.mediaType, q.timeWindow, q.page)));
  }

  async upcoming(raw: DiscoverKindQuery, hide: EnrichOptions = {}): Promise<DiscoverPage> {
    const q = DiscoverKindQuery.parse(raw);
    const today = localDate(this.requests.now());
    return this.page(
      await this.discoverCall(q.mediaType, {
        page: q.page,
        sortBy: q.mediaType === 'movie' ? 'primary_release_date.asc' : 'first_air_date.asc',
        releaseDateGte: today,
        releaseDateLte: '2999-12-31',
      }),
      {},
      hide,
    );
  }

  /** GET /discover/list/:list: ready-made lists (popular, top rated, now playing, airing). */
  async list(name: DiscoverListName, raw: DiscoverListQuery): Promise<DiscoverPage> {
    const q = DiscoverListQuery.parse(raw);
    if (name === 'upcomingMovies' || name === 'upcomingTv') return this.upcoming({ page: q.page, mediaType: name === 'upcomingMovies' ? 'movie' : 'tv' }, q);
    const { kind, list } = LISTS[name];
    return this.page(await this.cached(`list:${kind}:${list}:${q.page}`, LIST_TTL_MS, (c) => c.getList(kind, list, q.page)), {}, q);
  }

  async search(raw: DiscoverSearchQuery): Promise<DiscoverPage> {
    const q = DiscoverSearchQuery.parse(raw);
    const key = `search:${q.mediaType}:${q.query.toLowerCase()}:${q.page}`;
    const result = await this.cached(key, LIST_TTL_MS, (c) =>
      q.mediaType === 'movie'
        ? c.searchMovies(q.query, { page: q.page })
        : q.mediaType === 'tv'
          ? c.searchSeries(q.query, { page: q.page })
          : c.searchMulti(q.query, { page: q.page }),
    );
    return this.page(result);
  }

  async searchPeople(raw: DiscoverTextQuery): Promise<PersonPage> {
    const q = DiscoverTextQuery.parse(raw);
    const raw2 = await this.cached(`people:${q.query.toLowerCase()}:${q.page}`, LIST_TTL_MS, (c) => c.searchPeople(q.query, { page: q.page }));
    return {
      page: raw2.page,
      totalPages: Math.min(raw2.totalPages, 500),
      totalResults: raw2.totalResults,
      results: raw2.results.map((p) => ({
        tmdbId: p.tmdbId,
        name: p.name,
        profileUrl: p.profile ?? null,
        knownForDepartment: p.knownForDepartment ?? null,
        knownFor: p.knownFor.map((k) => k.title).slice(0, 3),
      })),
    };
  }

  async keywords(raw: DiscoverTextQuery): Promise<KeywordPage> {
    const q = DiscoverTextQuery.parse(raw);
    const page = await this.cached(`keywords:${q.query.toLowerCase()}:${q.page}`, LIST_TTL_MS, (c) => c.searchKeywords(q.query, q.page));
    return { page: page.page, totalPages: page.totalPages, totalResults: page.totalResults, results: page.results.map((k) => ({ id: k.tmdbId, name: k.name })) };
  }

  async genres(kind: 'movie' | 'tv'): Promise<DiscoverGenre[]> {
    const list = await this.cached(`genres:${kind}`, STATIC_TTL_MS, (c) => c.getGenres(kind));
    return list.map((g) => ({ id: g.tmdbId, name: g.name }));
  }

  /** Genres with a backdrop from their most popular title (home page tiles). */
  async genreTiles(kind: 'movie' | 'tv'): Promise<DiscoverTile[]> {
    const genres = await this.genres(kind);
    return Promise.all(
      genres.slice(0, MAX_GENRE_TILES).map(async (g): Promise<DiscoverTile> => {
        const top = await this.cache
          .get(`genreTile:${kind}:${g.id}`, STATIC_TTL_MS, () => this.tmdb((c) => c.discover(kind, { page: 1, withGenres: String(g.id), sortBy: 'popularity.desc' })))
          .catch(() => null);
        const backdrop = top?.results.find((r) => r.images.backdrop)?.images.backdrop ?? null;
        return { id: g.id, name: g.name, imageUrl: backdrop };
      }),
    );
  }

  /** The well-known studios (movie) or networks (tv) with their logos. */
  async companies(kind: 'movie' | 'tv'): Promise<DiscoverTile[]> {
    const list = kind === 'movie' ? POPULAR_STUDIOS : POPULAR_NETWORKS;
    return Promise.all(
      list.map(async (entry): Promise<DiscoverTile> => {
        const info = await this.entity(kind === 'movie' ? 'studio' : 'network', entry.id).catch(() => null);
        return { id: entry.id, name: entry.name, imageUrl: info?.imageUrl ?? null };
      }),
    );
  }

  /** Streaming services in a region (default: the instance region), most prominent first. */
  async providers(kind: 'movie' | 'tv', region?: string): Promise<DiscoverTile[]> {
    const r = (region ?? this.locale().region).toUpperCase();
    const list = await this.cached(`providers:${kind}:${r}`, STATIC_TTL_MS, (c) => c.getWatchProviders(kind, r));
    return list.map((p) => ({ id: p.tmdbId, name: p.name, imageUrl: p.logo ?? null }));
  }

  /** Name (and logo) of a studio, network or keyword for a grid page header. */
  async entity(kind: DiscoverEntityKind, id: number): Promise<DiscoverEntity> {
    if (kind === 'keyword') {
      const k = await this.cached(`keyword:${id}`, STATIC_TTL_MS, (c) => c.getKeyword(id));
      return { id: k.tmdbId, name: k.name, imageUrl: null };
    }
    const info = await this.cached(`${kind}:${id}`, STATIC_TTL_MS, (c) => (kind === 'studio' ? c.getCompany(id) : c.getNetwork(id)));
    return { id: info.tmdbId, name: info.name, imageUrl: info.logo ?? null };
  }

  /** Filter vocabularies: regions, languages, certifications, and the instance defaults. */
  async filterOptions(): Promise<DiscoverFilterOptions> {
    const { region, language } = this.locale();
    const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    const [regions, languages, movieCerts, tvCerts] = await Promise.all([
      safe(this.cached('regions', STATIC_TTL_MS, (c) => c.getWatchRegions()), []),
      safe(this.cached('languages', STATIC_TTL_MS, (c) => c.getLanguages()), []),
      safe(this.cached(`certs:movie:${region}`, STATIC_TTL_MS, (c) => c.getCertifications('movie', region)), []),
      safe(this.cached(`certs:tv:${region}`, STATIC_TTL_MS, (c) => c.getCertifications('tv', region)), []),
    ]);
    const cert = (c: { certification: string; meaning: string }) => ({ certification: c.certification, meaning: c.meaning });
    return {
      region,
      language,
      regions,
      languages,
      certifications: { movie: movieCerts.map(cert), tv: tvCerts.map(cert) },
    };
  }

  async genre(id: number, raw: DiscoverKindQuery): Promise<DiscoverPage> {
    const q = DiscoverKindQuery.parse(raw);
    const [results, genres] = await Promise.all([
      this.discoverCall(q.mediaType, { page: q.page, withGenres: String(id) }),
      this.genres(q.mediaType).catch(() => [] as DiscoverGenre[]),
    ]);
    const name = genres.find((g) => g.id === id)?.name;
    return this.page(results, name ? { title: name } : {});
  }

  async keyword(id: number, raw: DiscoverKindQuery): Promise<DiscoverPage> {
    const q = DiscoverKindQuery.parse(raw);
    return this.page(await this.discoverCall(q.mediaType, { page: q.page, withKeywords: String(id) }));
  }

  async network(id: number, page: number): Promise<DiscoverPage> {
    const [results, info] = await Promise.all([this.discoverCall('tv', { page, withNetworks: String(id) }), this.entity('network', id).catch(() => null)]);
    return this.page(results, { ...(info ? { title: info.name } : {}), ...(info?.imageUrl ? { imageUrl: info.imageUrl } : {}) });
  }

  async studio(id: number, page: number): Promise<DiscoverPage> {
    const [results, info] = await Promise.all([this.discoverCall('movie', { page, withCompanies: String(id) }), this.entity('studio', id).catch(() => null)]);
    return this.page(results, { ...(info ? { title: info.name } : {}), ...(info?.imageUrl ? { imageUrl: info.imageUrl } : {}) });
  }

  async person(id: number): Promise<PersonDetail> {
    const p = await this.cached(`person:${id}`, DETAIL_TTL_MS, (c) => c.getPerson(id));
    const all = this.enrich([...p.cast, ...p.crew]);
    const key = (r: { mediaType: MediaType; tmdbId: number }) => `${r.mediaType}:${r.tmdbId}`;
    const byKey = new Map(all.map((i) => [key(i), i]));
    const credit = (r: (typeof p.cast)[number]): PersonCredit => ({
      ...byKey.get(key(r))!,
      ...(r.character ? { character: r.character } : {}),
      ...(r.job ? { job: r.job } : {}),
    });
    return {
      tmdbId: p.tmdbId,
      name: p.name,
      biography: p.biography,
      birthday: p.birthday ?? null,
      deathday: p.deathday ?? null,
      placeOfBirth: p.placeOfBirth ?? null,
      knownForDepartment: p.knownForDepartment ?? null,
      profileUrl: p.profile ?? null,
      cast: p.cast.map(credit),
      crew: p.crew.map(credit),
    };
  }

  // -------------------------------------------------------------------------------------
  // collections
  // -------------------------------------------------------------------------------------

  private requestableMovie(item: DiscoverItem, is4k: boolean): boolean {
    const status = is4k ? item.mediaStatus4k : item.mediaStatus;
    return status === 'unknown';
  }

  async collection(actor: Actor, id: number): Promise<CollectionDetail> {
    const c = await this.cached(`collection:${id}`, DETAIL_TTL_MS, (client) => client.getCollection(id));
    const parts = this.enrich(c.parts);
    const settings = this.requests.settings();
    const held = this.actorPermissions(actor);
    return {
      tmdbId: c.tmdbId,
      name: c.name,
      overview: c.overview,
      posterUrl: c.images.poster ?? null,
      backdropUrl: c.images.backdrop ?? null,
      parts,
      missing: parts.filter((p) => this.requestableMovie(p, false)).length,
      canRequest: canRequest(held, 'movie', false),
      canRequest4k: canRequest(held, 'movie', true) && settings.movie4k.enabled,
    };
  }

  /** Requests every part of a collection the library lacks and nobody has requested yet. */
  async requestCollection(actor: Actor, id: number, raw: CollectionRequestInput): Promise<CollectionRequestResult> {
    const input = CollectionRequestInput.parse(raw);
    const detail = await this.collection(actor, id);
    if (!(input.is4k ? detail.canRequest4k : detail.canRequest)) throw RequestsError.forbidden();
    const result: CollectionRequestResult = { requested: [], skipped: 0, failed: [] };
    for (const part of detail.parts) {
      if (!this.requestableMovie(part, input.is4k)) {
        result.skipped += 1;
        continue;
      }
      try {
        const outcome = await this.requests.create(actor, { mediaType: 'movie', tmdbId: part.tmdbId, is4k: input.is4k });
        result.requested.push({ tmdbId: part.tmdbId, title: part.title, status: outcome.kind === 'created' ? outcome.request.status : null });
      } catch (err) {
        result.failed.push({ tmdbId: part.tmdbId, title: part.title, error: err instanceof Error ? err.message : String(err) });
        // Over quota: the remaining parts would fail the same way.
        if (err instanceof RequestsError && /quota/i.test(err.message)) break;
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------------------
  // title pages
  // -------------------------------------------------------------------------------------

  private actorPermissions(actor: Actor): number {
    if (actor.userId === null || actor.anonymous) return actor.permissions;
    const row = findUserRow(this.db, actor.userId);
    return row ? userPermissions(row) : actor.permissions;
  }

  async title(actor: Actor, type: MediaType, tmdbId: number): Promise<TitleDetail> {
    const [core, extras] = await Promise.all([
      this.cached<MovieMetadata | SeriesMetadata>(`${type}:${tmdbId}`, DETAIL_TTL_MS, (c) => (type === 'movie' ? c.getMovie(tmdbId) : c.getSeries(tmdbId))),
      this.cached(`${type}Extras:${tmdbId}`, DETAIL_TTL_MS, (c) => (type === 'movie' ? c.getMovieExtras(tmdbId) : c.getSeriesExtras(tmdbId))),
    ]);
    const settings = this.requests.settings();
    const status = this.requests.titleStatuses(type, [tmdbId]).get(tmdbId);
    const held = this.actorPermissions(actor);
    const releaseDate = 'firstAired' in core ? core.firstAired : 'inCinemas' in core ? (core.inCinemas ?? core.digitalRelease ?? core.physicalRelease) : undefined;

    let seasons: TitleSeason[] = [];
    if ('seasons' in core) {
      const known = new Map((status?.seasons ?? []).map((s) => [s.seasonNumber, s]));
      const active = status?.activeRequests ?? [];
      const reqSeasons = new Map<number, { normal?: string; uhd?: string }>();
      for (const req of active) {
        for (const r of this.requests.toResources([req], actor)[0]?.seasons ?? []) {
          const entry = reqSeasons.get(r.seasonNumber) ?? {};
          if (req.is4k) entry.uhd ??= req.status;
          else entry.normal ??= req.status;
          reqSeasons.set(r.seasonNumber, entry);
        }
      }
      seasons = core.seasons.map((s) => {
        const st = known.get(s.seasonNumber);
        const rs = reqSeasons.get(s.seasonNumber);
        return {
          seasonNumber: s.seasonNumber,
          ...(s.name ? { name: s.name } : {}),
          episodeCount: s.episodeCount,
          airDate: null,
          posterUrl: s.poster ?? null,
          status: st?.status ?? 'unknown',
          status4k: st?.status4k ?? 'unknown',
          requestStatus: (rs?.normal as TitleSeason['requestStatus']) ?? null,
          requestStatus4k: (rs?.uhd as TitleSeason['requestStatus4k']) ?? null,
        };
      });
    }

    const requestable = (is4k: boolean): boolean => {
      if (!canRequest(held, type, is4k)) return false;
      if (is4k && !(type === 'movie' ? settings.movie4k.enabled : settings.series4k.enabled)) return false;
      if (type === 'movie') return (is4k ? status?.status4k : status?.status) === 'unknown' || status === undefined;
      return seasons.some(
        (s) =>
          (settings.enableSpecialEpisodes || s.seasonNumber > 0) &&
          s.episodeCount > 0 &&
          (is4k ? s.status4k : s.status) === 'unknown',
      );
    };

    const base = this.enrich([
      type === 'movie'
        ? {
            mediaType: 'movie',
            tmdbId,
            title: core.title,
            originalTitle: core.originalTitle,
            ...(core.year !== undefined ? { year: core.year } : {}),
            ...(releaseDate ? { releaseDate } : {}),
            overview: core.overview,
            originalLanguage: core.originalLanguage,
            images: core.images,
            ratings: core.ratings,
          }
        : {
            mediaType: 'series',
            tmdbId,
            title: core.title,
            originalTitle: core.originalTitle,
            ...(core.year !== undefined ? { year: core.year } : {}),
            ...(releaseDate ? { firstAired: releaseDate } : {}),
            overview: core.overview,
            originalLanguage: core.originalLanguage,
            images: core.images,
            ratings: core.ratings,
          },
    ])[0]!;

    return {
      ...base,
      tagline: extras.tagline ?? null,
      status: core.status,
      runtimeMinutes: core.runtimeMinutes ?? null,
      imdbId: core.imdbId ?? null,
      tvdbId: 'tvdbId' in core ? (core.tvdbId ?? null) : null,
      genres: extras.genres.map((g) => ({ id: g.tmdbId, name: g.name })),
      keywords: extras.keywords.map((k) => ({ id: k.tmdbId, name: k.name })),
      companies: extras.companies.map((c) => ({ id: c.tmdbId, name: c.name, logoUrl: c.logo ?? null })),
      cast: extras.cast.map((c) => ({ tmdbId: c.tmdbId, name: c.name, ...(c.character ? { character: c.character } : {}), profileUrl: c.profile ?? null })),
      crew: extras.crew.map((c) => ({
        tmdbId: c.tmdbId,
        name: c.name,
        job: c.job ?? '',
        ...(c.department ? { department: c.department } : {}),
        profileUrl: c.profile ?? null,
      })),
      videos: extras.videos.map((v) => {
        const url = videoUrl(v.site, v.key);
        return { name: v.name, key: v.key, site: v.site, type: v.type, ...(url ? { url } : {}) };
      }),
      similar: this.enrich(extras.similar),
      recommendations: this.enrich(extras.recommendations),
      seasons,
      requests: actor.anonymous ? [] : this.requests.forTitle(actor, type, tmdbId),
      canRequest: requestable(false),
      canRequest4k: requestable(true),
      canRequestAdvanced: canRequestAdvanced(held),
      onWatchlist: !actor.anonymous && actor.userId !== null && this.watchlist.has(actor.userId, type, tmdbId),
      openIssues: actor.anonymous ? 0 : this.issues.openCount(actor, type, tmdbId),
      collection: 'collection' in core && core.collection ? { id: core.collection.tmdbId, name: core.collection.name } : null,
      releaseDates:
        type === 'movie'
          ? {
              inCinemas: dateOnly('inCinemas' in core ? core.inCinemas : null),
              digital: dateOnly('digitalRelease' in core ? core.digitalRelease : null),
              physical: dateOnly('physicalRelease' in core ? core.physicalRelease : null),
            }
          : null,
      certification: core.certification ?? null,
      firstAirDate: dateOnly('firstAired' in core ? core.firstAired : null),
      lastAirDate: dateOnly('lastAired' in core ? core.lastAired : null),
    };
  }

  // -------------------------------------------------------------------------------------
  // sliders
  // -------------------------------------------------------------------------------------

  private toSlider(row: SliderRow): DiscoverSlider {
    return {
      id: row.id,
      type: row.type,
      order: row.sortOrder,
      isBuiltIn: row.isBuiltIn,
      enabled: row.enabled,
      title: row.title,
      data: row.data,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Creates any missing built-in slider (section 15.2.2). */
  ensureDefaultSliders(): void {
    const rows = this.db.select().from(discoverSliders).all();
    const now = this.requests.now().toISOString();
    let order = rows.reduce((max, r) => Math.max(max, r.sortOrder), -1);
    for (const type of BUILT_IN_SLIDERS) {
      if (rows.some((r) => r.isBuiltIn && r.type === type)) continue;
      order = rows.length === 0 ? BUILT_IN_SLIDERS.indexOf(type) : order + 1;
      this.db.insert(discoverSliders).values({ type, sortOrder: order, isBuiltIn: true, enabled: true, title: null, data: null, createdAt: now, updatedAt: now }).run();
    }
  }

  /**
   * Sliders in display order. Managers of settings see every slider (to edit them); everyone
   * else sees the enabled ones they can use: anonymous portal visitors get no personal sliders
   * (their requests, their watchlist) and "Recently added" needs View recently added.
   */
  sliders(actor: Actor): DiscoverSlider[] {
    this.ensureDefaultSliders();
    const rows = this.db.select().from(discoverSliders).orderBy(asc(discoverSliders.sortOrder), asc(discoverSliders.id)).all();
    const all = rows.map((r) => this.toSlider(r));
    if (canManageSettings(actor.permissions)) return all;
    const held = this.actorPermissions(actor);
    return all.filter((s) => {
      if (!s.enabled) return false;
      if (actor.anonymous && PERSONAL_SLIDERS.includes(s.type)) return false;
      if (s.type === 'recentlyAdded' && !can(held, Permission.RECENT_VIEW)) return false;
      return true;
    });
  }

  private sliderRow(id: number): SliderRow {
    const row = this.db.select().from(discoverSliders).where(eq(discoverSliders.id, id)).get();
    if (!row) throw RequestsError.notFound('slider', id);
    return row;
  }

  createSlider(actor: Actor, raw: DiscoverSliderInput): DiscoverSlider {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    const input = DiscoverSliderInput.parse(raw);
    if ((BUILT_IN_SLIDERS as readonly string[]).includes(input.type)) throw new RequestsError('VALIDATION', `${input.type} is a built-in slider type`);
    this.ensureDefaultSliders();
    const max = this.db.select().from(discoverSliders).all().reduce((m, r) => Math.max(m, r.sortOrder), -1);
    const now = this.requests.now().toISOString();
    const row = this.db
      .insert(discoverSliders)
      .values({ type: input.type, sortOrder: max + 1, isBuiltIn: false, enabled: input.enabled, title: input.title, data: input.data, createdAt: now, updatedAt: now })
      .returning()
      .get();
    this.bus.publish({ type: 'settings', section: 'discoverSliders' });
    return this.toSlider(row);
  }

  updateSlider(actor: Actor, id: number, input: DiscoverSliderUpdate): DiscoverSlider {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    const row = this.sliderRow(id);
    if (row.isBuiltIn && (input.title !== undefined || input.data !== undefined)) {
      throw new RequestsError('VALIDATION', 'built-in sliders can only be enabled or disabled');
    }
    const patch: Partial<typeof discoverSliders.$inferInsert> = { updatedAt: this.requests.now().toISOString() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.data !== undefined) patch.data = input.data;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    const updated = this.db.update(discoverSliders).set(patch).where(eq(discoverSliders.id, id)).returning().get()!;
    this.bus.publish({ type: 'settings', section: 'discoverSliders' });
    return this.toSlider(updated);
  }

  deleteSlider(actor: Actor, id: number): void {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    const row = this.sliderRow(id);
    if (row.isBuiltIn) throw new RequestsError('VALIDATION', 'built-in sliders cannot be deleted; disable them instead');
    this.db.delete(discoverSliders).where(eq(discoverSliders.id, id)).run();
    this.bus.publish({ type: 'settings', section: 'discoverSliders' });
  }

  orderSliders(actor: Actor, order: DiscoverSliderOrder): DiscoverSlider[] {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    const rows = this.db.select().from(discoverSliders).all();
    const ids = new Set(rows.map((r) => r.id));
    for (const entry of order) if (!ids.has(entry.id)) throw RequestsError.notFound('slider', entry.id);
    const now = this.requests.now().toISOString();
    order.forEach((entry, index) => {
      this.db.update(discoverSliders).set({ sortOrder: index, enabled: entry.enabled, updatedAt: now }).where(eq(discoverSliders.id, entry.id)).run();
    });
    // Sliders left out keep their relative order after the listed ones.
    const listed = new Set(order.map((o) => o.id));
    rows
      .filter((r) => !listed.has(r.id))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .forEach((r, i) => this.db.update(discoverSliders).set({ sortOrder: order.length + i }).where(eq(discoverSliders.id, r.id)).run());
    this.bus.publish({ type: 'settings', section: 'discoverSliders' });
    return this.sliders(actor);
  }

  resetSliders(actor: Actor): DiscoverSlider[] {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    this.db.delete(discoverSliders).run();
    this.ensureDefaultSliders();
    this.bus.publish({ type: 'settings', section: 'discoverSliders' });
    return this.sliders(actor);
  }

  /** The items of one slider. `timeWindow` applies to the trending slider. */
  async sliderItems(actor: Actor, id: number, page = 1, timeWindow: 'day' | 'week' = 'day'): Promise<DiscoverPage> {
    const row = this.sliderRow(id);
    if (!row.enabled && !canManageSettings(actor.permissions)) throw RequestsError.notFound('slider', id);
    if (LIST_SLIDERS.has(row.type)) throw new RequestsError('VALIDATION', `${row.type} is a list slider; use /discover/genres/tiles, /discover/companies or /discover/providers`);
    const one = (results: DiscoverItem[]): DiscoverPage => ({ page: 1, totalPages: 1, totalResults: results.length, results });
    const data = row.data ?? '';
    const titled = { title: row.title ?? '' };
    switch (row.type) {
      case 'recentlyAdded':
        if (!can(this.actorPermissions(actor), Permission.RECENT_VIEW)) throw RequestsError.forbidden('the recently added slider needs View recently added');
        return one(this.recentlyAdded());
      case 'recentRequests':
        return one(actor.anonymous ? [] : this.recentRequests(actor));
      case 'watchlist':
        return one(actor.userId === null || actor.anonymous ? [] : this.watchlist.asDiscoverItems(actor.userId));
      case 'trending':
        return this.trending({ page, mediaType: 'all', timeWindow });
      case 'popularMovies':
        return this.movies({ page });
      case 'popularTv':
        return this.tv({ page });
      case 'upcomingMovies':
        return this.upcoming({ page, mediaType: 'movie' });
      case 'upcomingTv':
        return this.upcoming({ page, mediaType: 'tv' });
      case 'nowPlaying':
        return this.list('nowPlaying', { page });
      case 'topRatedMovies':
        return this.list('topRatedMovies', { page });
      case 'topRatedTv':
        return this.list('topRatedTv', { page });
      case 'airingTv':
        return this.list('onTheAir', { page });
      case 'tmdbMovieKeyword':
        return this.page(await this.discoverCall('movie', { page, withKeywords: data }), titled);
      case 'tmdbTvKeyword':
        return this.page(await this.discoverCall('tv', { page, withKeywords: data }), titled);
      case 'tmdbMovieGenre':
        return this.page(await this.discoverCall('movie', { page, withGenres: data }), titled);
      case 'tmdbTvGenre':
        return this.page(await this.discoverCall('tv', { page, withGenres: data }), titled);
      case 'tmdbSearch':
        return this.page(await this.cached(`search:all:${data.toLowerCase()}:${page}`, LIST_TTL_MS, (c) => c.searchMulti(data, { page })), titled);
      case 'tmdbStudio':
        return this.page(await this.discoverCall('movie', { page, withCompanies: data }), titled);
      case 'tmdbNetwork':
        return this.page(await this.discoverCall('tv', { page, withNetworks: data }), titled);
      default:
        throw new RequestsError('VALIDATION', `unsupported slider type ${row.type}`);
    }
  }

  private recentlyAdded(): DiscoverItem[] {
    const movieRows = this.db.select().from(movies).orderBy(desc(movies.added)).limit(20).all();
    const seriesRows = this.db.select().from(series).orderBy(desc(series.added)).limit(20).all();
    const merged = [
      ...movieRows.map((r) => ({ type: 'movie' as const, row: r, added: r.added })),
      ...seriesRows.map((r) => ({ type: 'series' as const, row: r, added: r.added })),
    ]
      .sort((a, b) => b.added.localeCompare(a.added))
      .slice(0, 20);
    return this.enrich(
      merged.map(({ type, row }) => {
        const poster = imageOf(row.images, 'poster');
        const backdrop = imageOf(row.images, 'fanart');
        const common = {
          tmdbId: row.tmdbId,
          title: row.title,
          originalTitle: row.title,
          year: row.year,
          overview: row.overview,
          originalLanguage: row.originalLanguage,
          images: { ...(poster ? { poster } : {}), ...(backdrop ? { backdrop } : {}) },
          ratings: { tmdb: { value: row.ratings['tmdb']?.value ?? 0, votes: row.ratings['tmdb']?.votes ?? 0 } },
        };
        return type === 'movie' ? { ...common, mediaType: 'movie' as const } : { ...common, mediaType: 'series' as const };
      }),
    );
  }

  private recentRequests(actor: Actor): DiscoverItem[] {
    const page = this.requests.list(actor, { take: 20, sort: 'added', sortDirection: 'desc' });
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const r of page.results) {
      const key = `${r.type}:${r.mediaTmdbId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const images = { ...(r.mediaPoster ? { poster: r.mediaPoster } : {}), ...(r.mediaBackdrop ? { backdrop: r.mediaBackdrop } : {}) };
      const common = {
        tmdbId: r.mediaTmdbId,
        title: r.mediaTitle,
        originalTitle: r.mediaTitle,
        ...(r.mediaYear ? { year: r.mediaYear } : {}),
        overview: '',
        originalLanguage: '',
        images,
        ratings: { tmdb: { value: 0, votes: 0 } },
      };
      results.push(r.type === 'movie' ? { ...common, mediaType: 'movie' } : { ...common, mediaType: 'series' });
    }
    return this.enrich(results);
  }
}
