import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { MediaBrowserServerClient, mediaBrowserProviderIds } from '@arclight/media-servers';
import {
  isMediaBrowserKind,
  JellyfinIssueInput,
  JellyfinLanguageRequestInput,
  JellyfinRequestInput,
  JellyfinSearchQuery,
  JellyfinStatusRequest,
  JellyfinWatchlistAdd,
  JellyfinWatchlistDeleteQuery,
  JellyfinDiscoverQuery,
  JellyfinProvidersQuery,
  JellyfinRequestDeleteQuery,
  JellyfinRequestsQuery,
  JellyfinUpcomingQuery,
  type CalendarItem,
  type DiscoverItem,
  type DiscoverPage,
  type JellyfinMyRequest,
  type JellyfinMyRequests,
  type JellyfinProvider,
  type JellyfinProviders,
  type JellyfinRequestBlockReason,
  type JellyfinUpcoming,
  type JellyfinUpcomingItem,
  type MediaImage,
  type QuotaStatus,
  type RequestsSettings,
  type JellyfinItemStatus,
  type JellyfinSearchItem,
  type JellyfinSearchPage,
  type JellyfinTitle,
  type JellyfinTitleStatus,
  type JellyfinWatchlist,
  type JellyfinWatchlistItem,
  type WatchlistItem,
  type MediaServerConfig,
  type MediaStatus,
  type MediaType,
  type QueueSummaryItem,
  type RequestStatus,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, movies, qualityProfiles, seasons, series, watchlistItems } from '../../db/schema.js';
import { CalendarService } from '../calendar/index.js';
import type { MediaServersService } from '../media-servers/index.js';
import type { RequestsServices } from '../requests/index.js';
import { canRequest, canRequestAdvanced, canViewAllRequests, effectivePermissions, requestTypeAllowed, type Actor } from '../requests/permissions.js';
import { restrictionReason } from '../requests/certification.js';
import { quotaFor } from '../requests/quota.js';
import { requestUsers, userRow, type UserRow } from '../requests/users.js';
import { getSection } from '../settings/service.js';
import { LibraryResolver, linkedUsers, mediaServerUsers, normaliseExternalId, type AccountsPort, type WatchStore } from '../watch-history/index.js';

// The Jellyfin plugin's per-user API. Every call runs as the Arclight user linked to the Jellyfin
// account in X-Arclight-Jellyfin-User, through the same services (and so the same permissions,
// request types, quotas and content caps) as the request portal. Nothing here writes to Jellyfin.

export class PluginError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

export interface PluginUser {
  row: UserRow;
  actor: Actor;
}

export interface JellyfinPluginServiceOptions {
  db: Db;
  servers: MediaServersService;
  requests: () => RequestsServices;
  store: WatchStore;
  accounts: () => AccountsPort;
  /** Active downloads (download-clients queue); empty when unavailable. */
  queue: () => QueueSummaryItem[];
  now?: () => Date;
}

/** Library status of a title in the plugin's words. */
export function titleStatus(status: MediaStatus, requestStatus?: RequestStatus | null): JellyfinTitleStatus {
  switch (status) {
    case 'available':
      return 'available';
    case 'partiallyAvailable':
      return 'partial';
    case 'processing':
      return 'processing';
    case 'pending':
      return 'requested';
    default:
      return requestStatus === 'pending' || requestStatus === 'approved' ? 'requested' : 'none';
  }
}

export class JellyfinPluginService {
  private readonly db: Db;
  private readonly servers: MediaServersService;
  private readonly requests: () => RequestsServices;
  private readonly store: WatchStore;
  private readonly accounts: () => AccountsPort;
  private readonly queue: () => QueueSummaryItem[];
  private readonly now: () => Date;

  constructor(opts: JellyfinPluginServiceOptions) {
    this.db = opts.db;
    this.servers = opts.servers;
    this.requests = opts.requests;
    this.store = opts.store;
    this.accounts = opts.accounts;
    this.queue = opts.queue;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- who is calling --------------------------------------------------------------------

  /** Users linked to a Jellyfin/Emby account. */
  linkedCount(): number {
    return linkedUsers(this.db).size;
  }

  /**
   * The Arclight user behind a Jellyfin user id. An unlinked account is imported (linked user
   * created) when the sign-in server allows creating users on login and the sign-in policy admits
   * new users automatically; otherwise 403 `not_linked`.
   */
  async resolveUser(header: string | undefined): Promise<PluginUser> {
    if (!header?.trim()) throw new PluginError(400, 'missing_user', 'X-Arclight-Jellyfin-User is required for this route');
    const id = normaliseExternalId(header);
    const links = linkedUsers(this.db);
    const linked = links.get(`jellyfin:${id}`) ?? links.get(`emby:${id}`);
    if (linked) {
      this.assertAccountActive(id);
      return this.asUser(linked.id);
    }

    const notLinked = new PluginError(403, 'not_linked', 'this Jellyfin user is not linked to an Arclight user');
    const server = this.servers.stored().find((s) => s.enabled && s.loginEnabled && isMediaBrowserKind(s.kind));
    if (!server || !server.createUsersOnLogin) throw notLinked;
    const kind = server.kind as 'jellyfin' | 'emby';
    const policy = getSection(this.db, 'signIn');
    if (!policy[kind] || policy.newUsers !== 'automatic') throw notLinked;
    let account;
    try {
      account = (await this.servers.clientFor(server).users()).find((u) => normaliseExternalId(u.id) === id);
    } catch {
      throw notLinked;
    }
    if (!account || account.isDisabled) throw notLinked;
    const row = await this.accounts().createLinkedUser(
      { id: account.id, username: account.name, isAdmin: account.isAdmin, isDisabled: false },
      { kind, externalId: account.id, username: account.name, linkedAt: this.now().toISOString() },
    );
    this.store.ensureAccount(server.id, account.id, account.name);
    return this.asUser(row.id);
  }

  /** A linked account that Jellyfin disabled or deleted acts for nobody (403 `account_disabled`). */
  private assertAccountActive(externalId: string): void {
    const rows = this.db
      .select({ disabled: mediaServerUsers.disabled, deleted: mediaServerUsers.deleted })
      .from(mediaServerUsers)
      .where(sql`lower(replace(${mediaServerUsers.externalId}, '-', '')) = ${externalId}`)
      .all();
    if (rows.some((r) => r.disabled || r.deleted)) {
      throw new PluginError(403, 'account_disabled', 'this Jellyfin account is disabled or deleted on the media server');
    }
  }

  private asUser(userId: number): PluginUser {
    const row = userRow(this.db, userId);
    return { row, actor: { userId: row.id, permissions: effectivePermissions(row) } };
  }

  // ---- status badges ---------------------------------------------------------------------

  /** GET /jellyfin/status: looks the ids up on the Jellyfin server first (provider ids, series). */
  async statusByIds(user: PluginUser, ids: string[]): Promise<JellyfinItemStatus[]> {
    const unique = [...new Set(ids.map((i) => i.trim()).filter(Boolean))];
    if (unique.length === 0) return [];
    if (unique.length > 100) throw new PluginError(400, 'VALIDATION', 'at most 100 items per call');
    const server = this.lookupServer();
    if (!server) throw new PluginError(503, 'NOT_CONFIGURED', 'no enabled Jellyfin/Emby server is configured');
    const client = this.servers.clientFor(server);
    if (!(client instanceof MediaBrowserServerClient)) throw new PluginError(503, 'NOT_CONFIGURED', 'not a Jellyfin/Emby server');
    let found;
    try {
      found = await client.itemsByIds(unique);
      const seriesIds = [...new Set(found.flatMap((i) => (i.seriesId && (i.type === 'Episode' || i.type === 'Season') ? [i.seriesId] : [])))];
      const seriesItems = new Map((seriesIds.length > 0 ? await client.itemsByIds(seriesIds) : []).map((s) => [s.id, s]));
      const byId = new Map(found.map((i) => [i.id, i]));
      return await this.status(user, {
        items: unique.map((id) => {
          const i = byId.get(id);
          if (!i) return { id, type: 'Unknown', providerIds: {} };
          const s = i.seriesId ? seriesItems.get(i.seriesId) : undefined;
          return {
            id,
            type: i.type,
            providerIds: idsToRecord(i.ids),
            ...(s ? { seriesProviderIds: idsToRecord(s.ids) } : {}),
            ...(i.seasonNumber !== null ? { seasonNumber: i.seasonNumber } : {}),
            ...(i.episodeNumber !== null ? { episodeNumber: i.episodeNumber } : {}),
          };
        }),
      });
    } catch (err) {
      if (err instanceof PluginError) throw err;
      throw new PluginError(502, 'UPSTREAM', `the Jellyfin server could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The server status lookups ask: the first enabled Jellyfin/Emby server whose id is known, else the first. */
  private lookupServer(): MediaServerConfig | undefined {
    const candidates = this.servers.stored().filter((s) => s.enabled && isMediaBrowserKind(s.kind));
    return candidates.find((s) => s.remoteId) ?? candidates[0];
  }

  /** POST /jellyfin/status. Titles not in the library and above the account's caps answer only `{id, inLibrary: false}`. */
  async status(user: PluginUser, raw: unknown): Promise<JellyfinItemStatus[]> {
    const body = JellyfinStatusRequest.parse(raw);
    const statuses = this.statusSync(user, body);
    const caps = this.guard().restrictionsFor(user.actor);
    if (!caps) return statuses.map((x) => x.status);
    return Promise.all(
      statuses.map(async ({ status, type, tmdbId }) => {
        if (status.inLibrary || !tmdbId || !type) return status;
        return (await this.restriction(user, type, tmdbId)) ? { id: status.id, inLibrary: false } : status;
      }),
    );
  }

  private statusSync(user: PluginUser, body: ReturnType<typeof JellyfinStatusRequest.parse>): { status: JellyfinItemStatus; type: MediaType | null; tmdbId: number | null }[] {
    const resolver = new LibraryResolver(this.db);
    let queue: QueueSummaryItem[] | null = null;
    const downloads = () => (queue ??= safe(this.queue, []));
    const nowIso = this.now().toISOString();
    const canSeeAll = canViewAllRequests(user.actor.permissions);
    const requests = this.requests().requests;

    return body.items.map((item) => {
      const one = this.statusOne(item, user, { resolver, downloads, nowIso, canSeeAll, requests });
      return one;
    });
  }

  private statusOne(
    item: ReturnType<typeof JellyfinStatusRequest.parse>['items'][number],
    user: PluginUser,
    c: { resolver: LibraryResolver; downloads: () => QueueSummaryItem[]; nowIso: string; canSeeAll: boolean; requests: RequestsServices['requests'] },
  ): { status: JellyfinItemStatus; type: MediaType | null; tmdbId: number | null } {
    const { resolver, downloads, nowIso, canSeeAll, requests } = c;
    {
      const ids = mediaBrowserProviderIds(item.providerIds);
      const seriesIds = item.seriesProviderIds ? mediaBrowserProviderIds(item.seriesProviderIds) : null;
      const requestOf = (type: MediaType, tmdbId: number | null): JellyfinItemStatus['request'] => {
        if (!tmdbId) return undefined;
        const st = requests.titleStatuses(type, [tmdbId]).get(tmdbId);
        const req = st?.request ?? st?.request4k ?? null;
        if (!req) return undefined;
        const own = req.requestedById === user.row.id;
        // Other users' requests are only shown to accounts that may view all requests.
        if (!own && !canSeeAll) return undefined;
        const who = requestUsers(this.db, [req.requestedById]).get(req.requestedById);
        const by = who ? (who.displayName ?? who.username) : '';
        return { id: req.id, status: req.status, requestedBy: by, requestedAt: req.createdAt, is4k: req.is4k };
      };
      const downloadOf = (match: (q: QueueSummaryItem) => boolean): JellyfinItemStatus['download'] => {
        const q = downloads().find(match);
        if (!q) return undefined;
        return { progress: Math.min(1, Math.max(0, q.progress)), ...(q.eta !== undefined ? { etaSeconds: Math.round(q.eta / 1000) } : {}), status: q.status };
      };

      if (item.type === 'Movie') {
        const found = resolver.movie(ids);
        const movie = found ? this.db.select().from(movies).where(eq(movies.id, found.id)).get() : undefined;
        const tmdbId = movie?.tmdbId ?? ids.tmdbId;
        const out: JellyfinItemStatus = { id: item.id, inLibrary: movie !== undefined };
        if (movie) out.monitored = movie.monitored;
        const request = requestOf('movie', tmdbId);
        if (request) out.request = request;
        if (movie) {
          const download = downloadOf((q) => q.movieId === movie.id);
          if (download) out.download = download;
          if (!movie.hasFile) {
            const next = [movie.inCinemas, movie.digitalRelease, movie.physicalRelease].filter((d): d is string => !!d && d > nowIso).sort()[0];
            if (next) out.upcoming = { releaseDate: next };
          }
        }
        return { status: out, type: 'movie', tmdbId: tmdbId ?? null };
      }
      if (item.type === 'Series' || item.type === 'Season' || item.type === 'Episode') {
        const showIds = item.type === 'Series' ? ids : seriesIds;
        const found = showIds ? resolver.series(showIds) : null;
        const show = found ? this.db.select().from(series).where(eq(series.id, found.id)).get() : undefined;
        const tmdbId = show?.tmdbId ?? (item.type === 'Series' ? ids.tmdbId : (seriesIds?.tmdbId ?? null));
        const out: JellyfinItemStatus = { id: item.id, inLibrary: show !== undefined };
        const request = requestOf('series', tmdbId);
        if (request) out.request = request;
        const wrap = (status: JellyfinItemStatus) => ({ status, type: 'series' as const, tmdbId: tmdbId ?? null });
        if (!show) return wrap(out);
        const season = item.seasonNumber ?? null;
        if (item.type === 'Episode') {
          const ep =
            season !== null && item.episodeNumber !== undefined
              ? this.db
                  .select()
                  .from(episodes)
                  .where(and(eq(episodes.seriesId, show.id), eq(episodes.seasonNumber, season), eq(episodes.episodeNumber, item.episodeNumber)))
                  .get()
              : undefined;
          out.monitored = ep?.monitored ?? show.monitored;
          const download = ep ? downloadOf((q) => q.seriesId === show.id && (q.episodeIds ?? []).includes(ep.id)) : undefined;
          if (download) out.download = download;
          if (ep && !ep.hasFile && ep.airDateUtc && ep.airDateUtc > nowIso) out.upcoming = { releaseDate: ep.airDateUtc };
          return wrap(out);
        }
        const inScope = item.type === 'Season' && season !== null ? and(eq(episodes.seriesId, show.id), eq(episodes.seasonNumber, season)) : eq(episodes.seriesId, show.id);
        if (item.type === 'Season' && season !== null) {
          out.monitored = this.db.select().from(seasons).where(and(eq(seasons.seriesId, show.id), eq(seasons.seasonNumber, season))).get()?.monitored ?? show.monitored;
        } else out.monitored = show.monitored;
        const scoped = this.db.select({ id: episodes.id }).from(episodes).where(inScope).all();
        const scopedIds = new Set(scoped.map((e) => e.id));
        const download = downloadOf((q) => q.seriesId === show.id && (item.type === 'Series' || (q.episodeIds ?? []).some((e) => scopedIds.has(e))));
        if (download) out.download = download;
        out.missingEpisodes = this.db
          .select({ id: episodes.id })
          .from(episodes)
          .where(and(inScope, eq(episodes.monitored, true), eq(episodes.hasFile, false), lte(episodes.airDateUtc, nowIso)))
          .all().length;
        const next = this.db
          .select({ at: episodes.airDateUtc })
          .from(episodes)
          .where(and(inScope, gt(episodes.airDateUtc, nowIso)))
          .orderBy(asc(episodes.airDateUtc))
          .limit(1)
          .get();
        if (next?.at) out.upcoming = { releaseDate: next.at };
        return wrap(out);
      }
      return { status: { id: item.id, inLibrary: false }, type: null, tmdbId: null };
    }
  }

  // ---- discover --------------------------------------------------------------------------

  private guard() {
    return this.requests().requests.certifications;
  }

  /** Why the account's content caps hide a title (null: allowed). Same rule as the request portal. */
  private async restriction(user: PluginUser, type: MediaType, tmdbId: number): Promise<string | null> {
    const caps = this.guard().restrictionsFor(user.actor);
    if (!caps) return null;
    return restrictionReason(caps, type, await this.guard().rating(type, tmdbId));
  }

  /** Title pages and watch providers: a capped title does not exist for this account (404). */
  private async assertVisible(user: PluginUser, type: MediaType, tmdbId: number): Promise<void> {
    const reason = await this.restriction(user, type, tmdbId);
    if (reason) throw new PluginError(404, 'content_restricted', `this title is not available: ${reason}`);
  }

  /** Requests, language requests and issues on a capped title: 403 `content_restricted`. */
  private async assertActionAllowed(user: PluginUser, type: MediaType, tmdbId: number): Promise<void> {
    const reason = await this.restriction(user, type, tmdbId);
    if (reason) throw new PluginError(403, 'content_restricted', `this title is not available: ${reason}`);
  }

  /** What request decisions need once per call: settings (4K switches) and the account's quota. */
  private requestContext(user: PluginUser): { settings: RequestsSettings; quota: QuotaStatus } {
    const settings = this.requests().requests.settings();
    const quota = quotaFor(this.db, { id: user.row.id, permissions: user.actor.permissions, settings: user.row.settings }, settings.defaultQuotas, this.now()).status;
    return { settings, quota };
  }

  /**
   * Why this account cannot request the title (null: it can). Mirrors RequestsService.create:
   * permission bits, the 4K switches, the account's request type filter, library state, quota.
   */
  blockReason(
    user: PluginUser,
    ctx: { settings: RequestsSettings; quota: QuotaStatus },
    type: MediaType,
    is4k: boolean,
    status: MediaStatus,
  ): JellyfinRequestBlockReason | null {
    if (!canRequest(user.actor.permissions, type, is4k)) return 'permission';
    if (is4k && !(type === 'movie' ? ctx.settings.movie4k.enabled : ctx.settings.series4k.enabled)) return 'permission';
    if (!requestTypeAllowed({ permissions: user.actor.permissions, settings: user.row.settings }, type)) return 'request_type';
    // Series stay requestable while partly available (missing seasons).
    if (!(status === 'unknown' || (type === 'series' && status === 'partiallyAvailable'))) return status === 'available' ? 'available' : 'requested';
    if (type === 'movie' && ctx.quota.movie.restricted) return 'quota';
    if (type === 'series' && ctx.quota.series.remaining !== null && ctx.quota.series.remaining <= 0) return 'quota';
    return null;
  }

  private toSearchItem(user: PluginUser, ctx: { settings: RequestsSettings; quota: QuotaStatus }, d: DiscoverItem): JellyfinSearchItem {
    const reason = this.blockReason(user, ctx, d.mediaType, false, d.mediaStatus);
    return {
      tmdbId: d.tmdbId,
      mediaType: d.mediaType,
      title: d.title,
      year: d.year ?? null,
      posterUrl: d.posterUrl ?? null,
      overview: d.overview,
      status: titleStatus(d.mediaStatus, d.requestStatus),
      canRequest: reason === null,
      canRequest4k: this.blockReason(user, ctx, d.mediaType, true, d.mediaStatus4k) === null,
      requestBlockedReason: reason,
    };
  }

  /** A discover page as plugin items, without titles above the account's caps. */
  private async toPage(user: PluginUser, page: DiscoverPage): Promise<JellyfinSearchPage> {
    const ctx = this.requestContext(user);
    const visible = await this.guard().filter(
      user.actor,
      page.results.filter((d) => d.mediaType === 'movie' || d.mediaType === 'series'),
    );
    return { page: page.page, totalPages: page.totalPages, totalResults: page.totalResults, results: visible.map((d) => this.toSearchItem(user, ctx, d)) };
  }

  async search(user: PluginUser, raw: unknown): Promise<JellyfinSearchPage> {
    const q = JellyfinSearchQuery.parse(raw);
    const s = this.requests();
    const page = await s.discover.search({ query: q.q, page: q.page, mediaType: q.type === 'series' ? 'tv' : q.type });
    return this.toPage(user, page);
  }

  /** GET /jellyfin/discover: trending, popular and upcoming rows, filtered by the account's caps. */
  async discover(user: PluginUser, raw: unknown): Promise<JellyfinSearchPage> {
    const q = JellyfinDiscoverQuery.parse(raw);
    const d = this.requests().discover;
    const page =
      q.category === 'trending'
        ? await d.trending({ page: q.page, mediaType: 'all', timeWindow: 'week' })
        : await d.list(
            ({ popularMovies: 'popularMovies', popularSeries: 'popularTv', upcomingMovies: 'upcomingMovies', upcomingSeries: 'upcomingTv' } as const)[q.category],
            { page: q.page },
          );
    return this.toPage(user, page);
  }

  async title(user: PluginUser, mediaType: MediaType, tmdbId: number): Promise<JellyfinTitle> {
    const s = this.requests();
    await this.assertVisible(user, mediaType, tmdbId);
    const detail = await s.discover.title(user.actor, mediaType, tmdbId);
    const ctx = this.requestContext(user);
    const reason = detail.canRequest ? this.blockReason(user, ctx, mediaType, false, detail.mediaStatus) : (this.blockReason(user, ctx, mediaType, false, detail.mediaStatus) ?? 'requested');
    const advanced = canRequestAdvanced(user.actor.permissions) && detail.canRequestAdvanced;
    const options = s.languages.options(user.actor, { mediaType, tmdbId });
    const canSubtitles = options.canRequest && options.canRequestSubtitles;
    const canAudio = options.canRequest && options.canRequestAudio;
    let languages: JellyfinTitle['languages'] = [];
    if (canSubtitles || canAudio) {
      try {
        languages = s.languages.languages();
      } catch {
        languages = [];
      }
    }
    return {
      tmdbId: detail.tmdbId,
      mediaType: detail.mediaType,
      title: detail.title,
      year: detail.year ?? null,
      overview: detail.overview,
      posterUrl: detail.posterUrl ?? null,
      backdropUrl: detail.backdropUrl ?? null,
      status: titleStatus(detail.mediaStatus, detail.requestStatus),
      status4k: titleStatus(detail.mediaStatus4k),
      canRequest: reason === null,
      canRequest4k: detail.canRequest4k && this.blockReason(user, ctx, mediaType, true, detail.mediaStatus4k) === null,
      requestBlockedReason: reason,
      // Arclight has no "future seasons" request option: new seasons follow the series' monitoring.
      canRequestFutureSeasons: false,
      canRequestAdvanced: advanced,
      qualityProfiles: advanced
        ? this.db
            .select({ id: qualityProfiles.id, name: qualityProfiles.name })
            .from(qualityProfiles)
            .where(eq(qualityProfiles.mediaDomain, 'video'))
            .orderBy(asc(qualityProfiles.id))
            .all()
        : [],
      seasons: detail.seasons.map((x) => ({
        seasonNumber: x.seasonNumber,
        name: x.name ?? null,
        episodeCount: x.episodeCount,
        airDate: x.airDate ?? null,
        status: titleStatus(x.status, x.requestStatus),
        status4k: titleStatus(x.status4k, x.requestStatus4k),
      })),
      // Other users' requests only for accounts that may view all requests.
      requests: canViewAllRequests(user.actor.permissions) ? detail.requests : detail.requests.filter((r) => r.requestedBy.id === user.row.id),
      onWatchlist: detail.onWatchlist,
      canRequestSubtitles: canSubtitles,
      canRequestAudio: canAudio,
      languages,
      languageOptions: options,
    };
  }

  // ---- actions ---------------------------------------------------------------------------

  async request(user: PluginUser, raw: unknown) {
    const body = JellyfinRequestInput.parse(raw);
    await this.assertActionAllowed(user, body.mediaType, body.tmdbId);
    const advanced = canRequestAdvanced(user.actor.permissions);
    return this.requests().requests.create(user.actor, {
      mediaType: body.mediaType,
      tmdbId: body.tmdbId,
      is4k: body.is4k,
      ...(body.mediaType === 'series' ? { seasons: body.seasons ?? 'all' } : {}),
      ...(advanced && (body.qualityProfileId ?? body.profileId) !== undefined ? { qualityProfileId: (body.qualityProfileId ?? body.profileId)! } : {}),
    });
  }

  async languageRequest(user: PluginUser, raw: unknown) {
    const body = JellyfinLanguageRequestInput.parse(raw);
    await this.assertActionAllowed(user, body.mediaType, body.tmdbId);
    const { userId: _ignored, ...own } = body;
    return this.requests().languages.create(user.actor, own);
  }

  async issue(user: PluginUser, raw: unknown) {
    const body = JellyfinIssueInput.parse(raw);
    await this.assertActionAllowed(user, body.mediaType, body.tmdbId);
    return this.requests().issues.create(user.actor, {
      type: body.type,
      mediaType: body.mediaType,
      tmdbId: body.tmdbId,
      message: body.message,
      problemSeason: body.seasonNumber ?? 0,
      problemEpisode: body.episodeNumber ?? 0,
    });
  }

  watchlist(user: PluginUser): JellyfinWatchlist {
    return { items: this.requests().watchlist.list(user.actor).map(toPluginItem) };
  }

  async addToWatchlist(user: PluginUser, raw: unknown): Promise<JellyfinWatchlistItem> {
    const body = JellyfinWatchlistAdd.parse(raw);
    return toPluginItem(await this.requests().watchlist.add(user.actor, { mediaType: body.mediaType, tmdbId: body.tmdbId }, 'jellyfin'));
  }

  /** Removes one of the user's own watchlist items, by id or by title; only manual and plugin-added items. */
  removeFromWatchlist(user: PluginUser, raw: unknown): void {
    const q = JellyfinWatchlistDeleteQuery.parse(raw);
    const where =
      q.id !== undefined
        ? and(eq(watchlistItems.id, q.id), eq(watchlistItems.userId, user.row.id))
        : q.mediaType && q.tmdbId
          ? and(eq(watchlistItems.userId, user.row.id), eq(watchlistItems.mediaType, q.mediaType), eq(watchlistItems.tmdbId, q.tmdbId))
          : null;
    if (!where) throw new PluginError(400, 'VALIDATION', 'pass id, or mediaType and tmdbId');
    const row = this.db.select().from(watchlistItems).where(where).get();
    if (!row) throw new PluginError(404, 'NOT_FOUND', 'not on your watchlist');
    if (row.source !== 'manual' && row.source !== 'jellyfin') {
      throw new PluginError(409, 'CONFLICT', `this item is mirrored from ${row.source}; remove it there`);
    }
    if (row.source === 'jellyfin' && row.externalId !== null) {
      throw new PluginError(409, 'CONFLICT', 'this item is a Jellyfin favourite; unfavourite it in Jellyfin');
    }
    this.requests().watchlist.remove(user.actor, row.id);
  }

  // ---- upcoming, providers, my requests --------------------------------------------------

  /**
   * GET /jellyfin/upcoming: monitored movies and episodes releasing in the next `days` days, from
   * Arclight's calendar (so library titles only), without titles above the account's caps.
   */
  async upcoming(user: PluginUser, raw: unknown): Promise<JellyfinUpcoming> {
    const q = JellyfinUpcomingQuery.parse(raw);
    const now = this.now();
    const end = new Date(now.getTime() + q.days * 86_400_000);
    const items = new CalendarService(this.db, () => now).list({
      start: now.toISOString(),
      end: end.toISOString(),
      unmonitored: false,
      includeSeries: true,
      includeEpisodeFile: false,
      tags: [],
      mediaType: 'all',
    });
    const mapped = items.flatMap((i) => (i.type === 'movie' || i.type === 'episode' ? [toUpcoming(i)] : [])).slice(0, 300);
    const caps = this.guard().restrictionsFor(user.actor);
    if (!caps) return { days: q.days, items: mapped.map((m) => m.item) };
    const ratings = new Map<string, string | null>();
    const rating = async (m: { item: JellyfinUpcomingItem; certification: string | null }) => {
      if (m.item.mediaType === 'movie' && m.certification) return m.certification;
      if (!m.item.tmdbId) return null;
      const key = `${m.item.mediaType}:${m.item.tmdbId}`;
      if (!ratings.has(key)) ratings.set(key, await this.guard().rating(m.item.mediaType, m.item.tmdbId));
      return ratings.get(key) ?? null;
    };
    const out: JellyfinUpcomingItem[] = [];
    for (const m of mapped) {
      if (restrictionReason(caps, m.item.mediaType, await rating(m)) === null) out.push(m.item);
    }
    return { days: q.days, items: out };
  }

  /** GET /jellyfin/providers/:mediaType/:tmdbId: where else the title streams (TMDB, data from JustWatch). */
  async providers(user: PluginUser, mediaType: MediaType, tmdbId: number, raw: unknown): Promise<JellyfinProviders> {
    const q = JellyfinProvidersQuery.parse(raw);
    await this.assertVisible(user, mediaType, tmdbId);
    const found = await this.requests().discover.titleProviders(mediaType, tmdbId, q.region);
    const map = (list: { tmdbId: number; name: string; logo?: string }[]): JellyfinProvider[] => list.map((p) => ({ id: p.tmdbId, name: p.name, logoUrl: p.logo ?? null }));
    return { region: q.region, link: found.link, flatrate: map(found.flatrate), rent: map(found.rent), buy: map(found.buy), attribution: 'Data from JustWatch' };
  }

  /** GET /jellyfin/requests: the caller's own media and language requests, newest first. */
  myRequests(user: PluginUser, raw: unknown): JellyfinMyRequests {
    const q = JellyfinRequestsQuery.parse(raw);
    const s = this.requests();
    const own = { take: 500, skip: 0, requestedBy: user.row.id };
    const media = s.requests.list(user.actor, own).results.filter((r) => r.requestedBy.id === user.row.id);
    const langs = s.languages.list(user.actor, own).results.filter((r) => r.requestedBy.id === user.row.id);
    let queue: QueueSummaryItem[] | null = null;
    const downloads = () => (queue ??= safe(this.queue, []));
    const progressOf = (type: MediaType, libraryId: number | null | undefined): number | null => {
      if (!libraryId) return null;
      const q2 = downloads().find((d) => (type === 'movie' ? d.movieId === libraryId : d.seriesId === libraryId));
      return q2 ? Math.min(1, Math.max(0, q2.progress)) : null;
    };
    const items: JellyfinMyRequest[] = [
      ...media.map(
        (r): JellyfinMyRequest => ({
          kind: 'media',
          id: r.id,
          mediaType: r.type,
          tmdbId: r.mediaTmdbId,
          title: r.mediaTitle,
          year: r.mediaYear ?? null,
          posterUrl: r.mediaPoster ?? null,
          status: r.status,
          is4k: r.is4k,
          seasons: r.seasons.map((x) => x.seasonNumber),
          language: null,
          createdAt: r.createdAt,
          progress: progressOf(r.type, r.libraryId),
          canCancel: r.status === 'pending' && r.canRemove,
        }),
      ),
      ...langs.map(
        (r): JellyfinMyRequest => ({
          kind: 'language',
          id: r.id,
          mediaType: r.mediaType,
          tmdbId: r.tmdbId,
          title: r.title,
          year: r.year ?? null,
          posterUrl: r.poster ?? null,
          status: r.status,
          is4k: false,
          seasons: r.seasonNumber !== null ? [r.seasonNumber] : [],
          language: { kind: r.kind, language: r.languageName || r.language },
          createdAt: r.createdAt,
          progress: null,
          canCancel: r.status === 'pending',
        }),
      ),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
    return { total: items.length, items: items.slice(q.skip, q.skip + q.take) };
  }

  /** DELETE /jellyfin/requests/:id: cancel one of the caller's own pending requests (the portal's rule). */
  cancelRequest(user: PluginUser, id: number, raw: unknown): void {
    const q = JellyfinRequestDeleteQuery.parse(raw);
    const s = this.requests();
    let row: { requestedById: number; status: string };
    try {
      row = q.kind === 'media' ? s.requests.row(id) : s.languages.row(id);
    } catch {
      throw new PluginError(404, 'NOT_FOUND', 'request not found');
    }
    // Other users' requests do not exist for the plugin, even for accounts that manage requests.
    if (row.requestedById !== user.row.id) throw new PluginError(404, 'NOT_FOUND', 'request not found');
    if (row.status !== 'pending') throw new PluginError(403, 'FORBIDDEN', 'only pending requests can be cancelled');
    if (q.kind === 'media') s.requests.remove(user.actor, id);
    else s.languages.remove(user.actor, id);
  }
}

function posterOf(images: readonly MediaImage[]): string | null {
  const poster = images.find((i) => i.coverType === 'poster');
  if (!poster) return null;
  if (poster.remoteUrl) return poster.remoteUrl;
  return /^https?:\/\//.test(poster.url) ? poster.url : null;
}

function toUpcoming(i: Extract<CalendarItem, { type: 'movie' | 'episode' }>): { item: JellyfinUpcomingItem; certification: string | null } {
  if (i.type === 'movie') {
    return {
      certification: i.movie.certification ?? null,
      item: {
        date: i.date,
        kind: 'movie',
        releaseType: i.releaseKind,
        mediaType: 'movie',
        tmdbId: i.movie.tmdbId,
        title: i.movie.title,
        year: i.movie.year,
        posterUrl: posterOf(i.movie.images),
        seasonNumber: null,
        episodeNumber: null,
        episodeTitle: null,
        hasFile: i.movie.hasFile,
      },
    };
  }
  return {
    certification: null,
    item: {
      date: i.date,
      kind: 'episode',
      releaseType: null,
      mediaType: 'series',
      tmdbId: i.series?.tmdbId ?? null,
      title: i.seriesTitle,
      year: i.series?.year ?? null,
      posterUrl: i.series ? posterOf(i.series.images) : null,
      seasonNumber: i.episode.seasonNumber,
      episodeNumber: i.episode.episodeNumber,
      episodeTitle: i.episode.title,
      hasFile: i.episode.hasFile,
    },
  };
}

function toPluginItem(w: WatchlistItem): JellyfinWatchlistItem {
  return { id: w.id, mediaType: w.mediaType, tmdbId: w.tmdbId, title: w.title, year: w.year ?? null, posterUrl: w.posterUrl ?? null, source: w.source, addedAt: w.createdAt };
}

function idsToRecord(ids: { tmdbId: number | null; tvdbId: number | null; imdbId: string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  if (ids.tmdbId) out['Tmdb'] = String(ids.tmdbId);
  if (ids.tvdbId) out['Tvdb'] = String(ids.tvdbId);
  if (ids.imdbId) out['Imdb'] = ids.imdbId;
  return out;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
