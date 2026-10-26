import { asc, desc, eq } from 'drizzle-orm';
import type { DiscoverOptions, PagedResults, SearchResult, TmdbClient } from '@media-tron/metadata';
import {
  BUILT_IN_SLIDERS,
  DISCOVER_MOVIE_SORTS,
  DISCOVER_TV_SORTS,
  DiscoverKindQuery,
  DiscoverQuery,
  DiscoverSearchQuery,
  DiscoverSliderInput,
  Permission,
  TrendingQuery,
  type DiscoverGenre,
  type DiscoverItem,
  type DiscoverPage,
  type DiscoverSlider,
  type DiscoverSliderOrder,
  type DiscoverSliderUpdate,
  type MediaImage,
  type MediaType,
  type PersonCredit,
  type PersonDetail,
  type TitleDetail,
  type TitleSeason,
} from '@media-tron/shared';
import type { Db } from '../../db/index.js';
import { movies, series } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { RequestsError } from './errors.js';
import type { IssuesService } from './issues.js';
import { type Actor, can, canManageSettings, canRequest, canRequestAdvanced } from './permissions.js';
import { discoverSliders } from './schema.js';
import type { RequestsService } from './service.js';
import { userPermissions, findUserRow } from './users.js';
import type { WatchlistService } from './watchlist.js';

// Discover (docs/spec/requests.md section 15): TMDB lists and title pages, each result
// annotated with Media-Tron's status (library + requests), plus the slider configuration.

type SliderRow = typeof discoverSliders.$inferSelect;

export interface DiscoverServiceOptions {
  db: Db;
  bus: EventBus;
  requests: RequestsService;
  issues: IssuesService;
  watchlist: WatchlistService;
}

/** List-type sliders the web renders itself (genre chips, studio/network logos). */
const LIST_SLIDERS = new Set(['movieGenres', 'tvGenres', 'studios', 'networks']);

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

export class DiscoverService {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly requests: RequestsService;
  private readonly issues: IssuesService;
  private readonly watchlist: WatchlistService;

  constructor(opts: DiscoverServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.requests = opts.requests;
    this.issues = opts.issues;
    this.watchlist = opts.watchlist;
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

  // -------------------------------------------------------------------------------------
  // enrichment
  // -------------------------------------------------------------------------------------

  /** Annotates TMDB results with library/request status. `filter` applies hideAvailable/hideRequested. */
  enrich(results: readonly SearchResult[], opts: { filter?: boolean } = {}): DiscoverItem[] {
    const statuses = {
      movie: this.requests.titleStatuses('movie', results.filter((r) => r.mediaType === 'movie').map((r) => r.tmdbId)),
      series: this.requests.titleStatuses('series', results.filter((r) => r.mediaType === 'series').map((r) => r.tmdbId)),
    };
    const settings = opts.filter ? this.requests.settings() : null;
    const items: DiscoverItem[] = [];
    for (const r of results) {
      const st = statuses[r.mediaType].get(r.tmdbId);
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
        requestId: st?.request?.id ?? null,
        requestStatus: st?.request?.status ?? null,
        libraryId: st?.libraryId ?? null,
      };
      if (settings?.hideAvailable && item.mediaStatus === 'available') continue;
      if (settings?.hideRequested && (item.requestStatus === 'pending' || item.requestStatus === 'approved')) continue;
      items.push(item);
    }
    return items;
  }

  private page(raw: PagedResults<SearchResult>, extra: { title?: string; imageUrl?: string } = {}): DiscoverPage {
    return {
      page: raw.page,
      totalPages: raw.totalPages,
      totalResults: raw.totalResults,
      results: this.enrich(raw.results, { filter: true }),
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
    if (kind === 'movie' && parsed.studio) opts.withCompanies = String(parsed.studio);
    if (kind === 'tv' && parsed.network) opts.withNetworks = String(parsed.network);
    // TMDB needs both ends of a date range (section 15.3.3).
    if (parsed.releaseDateGte || parsed.releaseDateLte) {
      opts.releaseDateGte = parsed.releaseDateGte ?? '1900-01-01';
      opts.releaseDateLte = parsed.releaseDateLte ?? '2999-12-31';
    }
    return opts;
  }

  async movies(q: DiscoverQuery): Promise<DiscoverPage> {
    return this.page(await this.tmdb((c) => c.discover('movie', this.options('movie', q))));
  }

  async tv(q: DiscoverQuery): Promise<DiscoverPage> {
    return this.page(await this.tmdb((c) => c.discover('tv', this.options('tv', q))));
  }

  async trending(raw: TrendingQuery): Promise<DiscoverPage> {
    const q = TrendingQuery.parse(raw);
    return this.page(await this.tmdb((c) => c.getTrending(q.mediaType, q.timeWindow, q.page)));
  }

  async upcoming(raw: DiscoverKindQuery): Promise<DiscoverPage> {
    const q = DiscoverKindQuery.parse(raw);
    const today = localDate(this.requests.now());
    return this.page(
      await this.tmdb((c) =>
        c.discover(q.mediaType, { page: q.page, sortBy: q.mediaType === 'movie' ? 'primary_release_date.asc' : 'first_air_date.asc', releaseDateGte: today, releaseDateLte: '2999-12-31' }),
      ),
    );
  }

  async search(raw: DiscoverSearchQuery): Promise<DiscoverPage> {
    const q = DiscoverSearchQuery.parse(raw);
    return this.page(await this.tmdb((c) => c.searchMulti(q.query, { page: q.page })));
  }

  async genres(kind: 'movie' | 'tv'): Promise<DiscoverGenre[]> {
    const list = await this.tmdb((c) => c.getGenres(kind));
    return list.map((g) => ({ id: g.tmdbId, name: g.name }));
  }

  async genre(id: number, raw: DiscoverKindQuery): Promise<DiscoverPage> {
    const q = DiscoverKindQuery.parse(raw);
    const [results, genres] = await Promise.all([
      this.tmdb((c) => c.discover(q.mediaType, { page: q.page, withGenres: String(id) })),
      this.genres(q.mediaType).catch(() => [] as DiscoverGenre[]),
    ]);
    const name = genres.find((g) => g.id === id)?.name;
    return this.page(results, name ? { title: name } : {});
  }

  async keyword(id: number, raw: DiscoverKindQuery): Promise<DiscoverPage> {
    const q = DiscoverKindQuery.parse(raw);
    return this.page(await this.tmdb((c) => c.discover(q.mediaType, { page: q.page, withKeywords: String(id) })));
  }

  async network(id: number, page: number): Promise<DiscoverPage> {
    const [results, info] = await Promise.all([
      this.tmdb((c) => c.discover('tv', { page, withNetworks: String(id) })),
      this.tmdb((c) => c.getNetwork(id)).catch(() => null),
    ]);
    return this.page(results, { ...(info ? { title: info.name } : {}), ...(info?.logo ? { imageUrl: info.logo } : {}) });
  }

  async studio(id: number, page: number): Promise<DiscoverPage> {
    const [results, info] = await Promise.all([
      this.tmdb((c) => c.discover('movie', { page, withCompanies: String(id) })),
      this.tmdb((c) => c.getCompany(id)).catch(() => null),
    ]);
    return this.page(results, { ...(info ? { title: info.name } : {}), ...(info?.logo ? { imageUrl: info.logo } : {}) });
  }

  async person(id: number): Promise<PersonDetail> {
    const p = await this.tmdb((c) => c.getPerson(id));
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
  // title pages
  // -------------------------------------------------------------------------------------

  private actorPermissions(actor: Actor): number {
    if (actor.userId === null) return actor.permissions;
    const row = findUserRow(this.db, actor.userId);
    return row ? userPermissions(row) : actor.permissions;
  }

  async title(actor: Actor, type: MediaType, tmdbId: number): Promise<TitleDetail> {
    const [core, extras] = await this.tmdb((c) =>
      Promise.all([
        type === 'movie' ? c.getMovie(tmdbId) : c.getSeries(tmdbId),
        type === 'movie' ? c.getMovieExtras(tmdbId) : c.getSeriesExtras(tmdbId),
      ]),
    );
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
      requests: this.requests.forTitle(actor, type, tmdbId),
      canRequest: requestable(false),
      canRequest4k: requestable(true),
      canRequestAdvanced: canRequestAdvanced(held),
      onWatchlist: actor.userId !== null && this.watchlist.has(actor.userId, type, tmdbId),
      openIssues: this.issues.openCount(actor, type, tmdbId),
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

  sliders(actor: Actor): DiscoverSlider[] {
    this.ensureDefaultSliders();
    const rows = this.db.select().from(discoverSliders).orderBy(asc(discoverSliders.sortOrder), asc(discoverSliders.id)).all();
    const all = rows.map((r) => this.toSlider(r));
    return canManageSettings(actor.permissions) ? all : all.filter((s) => s.enabled);
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

  /** The items of one slider. */
  async sliderItems(actor: Actor, id: number, page = 1): Promise<DiscoverPage> {
    const row = this.sliderRow(id);
    if (!row.enabled && !canManageSettings(actor.permissions)) throw RequestsError.notFound('slider', id);
    if (LIST_SLIDERS.has(row.type)) throw new RequestsError('VALIDATION', `${row.type} is a list slider; use /discover/genres or the studio/network constants`);
    const one = (results: DiscoverItem[]): DiscoverPage => ({ page: 1, totalPages: 1, totalResults: results.length, results });
    const data = row.data ?? '';
    switch (row.type) {
      case 'recentlyAdded':
        if (!can(this.actorPermissions(actor), Permission.RECENT_VIEW)) throw RequestsError.forbidden('the recently added slider needs View recently added');
        return one(this.recentlyAdded());
      case 'recentRequests':
        return one(this.recentRequests(actor));
      case 'watchlist':
        return one(actor.userId === null ? [] : this.watchlist.asDiscoverItems(actor.userId));
      case 'trending':
        return this.trending({ page, mediaType: 'all', timeWindow: 'day' });
      case 'popularMovies':
        return this.movies({ page });
      case 'popularTv':
        return this.tv({ page });
      case 'upcomingMovies':
        return this.upcoming({ page, mediaType: 'movie' });
      case 'upcomingTv':
        return this.upcoming({ page, mediaType: 'tv' });
      case 'tmdbMovieKeyword':
        return this.page(await this.tmdb((c) => c.discover('movie', { page, withKeywords: data })), { title: row.title ?? '' });
      case 'tmdbTvKeyword':
        return this.page(await this.tmdb((c) => c.discover('tv', { page, withKeywords: data })), { title: row.title ?? '' });
      case 'tmdbMovieGenre':
        return this.page(await this.tmdb((c) => c.discover('movie', { page, withGenres: data })), { title: row.title ?? '' });
      case 'tmdbTvGenre':
        return this.page(await this.tmdb((c) => c.discover('tv', { page, withGenres: data })), { title: row.title ?? '' });
      case 'tmdbSearch':
        return this.page(await this.tmdb((c) => c.searchMulti(data, { page })), { title: row.title ?? '' });
      case 'tmdbStudio':
        return this.page(await this.tmdb((c) => c.discover('movie', { page, withCompanies: data })), { title: row.title ?? '' });
      case 'tmdbNetwork':
        return this.page(await this.tmdb((c) => c.discover('tv', { page, withNetworks: data })), { title: row.title ?? '' });
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
      merged.map(({ type, row }) =>
        type === 'movie'
          ? {
              mediaType: 'movie' as const,
              tmdbId: row.tmdbId,
              title: row.title,
              originalTitle: row.title,
              year: row.year,
              overview: row.overview,
              originalLanguage: row.originalLanguage,
              images: { ...(imageOf(row.images, 'poster') ? { poster: imageOf(row.images, 'poster')! } : {}), ...(imageOf(row.images, 'fanart') ? { backdrop: imageOf(row.images, 'fanart')! } : {}) },
              ratings: { tmdb: { value: row.ratings['tmdb']?.value ?? 0, votes: row.ratings['tmdb']?.votes ?? 0 } },
            }
          : {
              mediaType: 'series' as const,
              tmdbId: row.tmdbId,
              title: row.title,
              originalTitle: row.title,
              year: row.year,
              overview: row.overview,
              originalLanguage: row.originalLanguage,
              images: { ...(imageOf(row.images, 'poster') ? { poster: imageOf(row.images, 'poster')! } : {}), ...(imageOf(row.images, 'fanart') ? { backdrop: imageOf(row.images, 'fanart')! } : {}) },
              ratings: { tmdb: { value: row.ratings['tmdb']?.value ?? 0, votes: row.ratings['tmdb']?.votes ?? 0 } },
            },
      ),
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
