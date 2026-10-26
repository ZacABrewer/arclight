import type { NotificationEvent } from '@arclight/notifications';
import type { AppContext, AppModule } from '../../app.js';
import { metadata, activeMetadataService, MetadataNotConfiguredError } from '../metadata/index.js';
import { notificationsServiceFor } from '../notifications/index.js';
import { releasesServiceFor, type SearchTarget } from '../releases/index.js';
import { DiscoverService } from './discover.js';
import { IssuesService } from './issues.js';
import { registerRequestsJobs } from './jobs.js';
import { MediaServerAccounts } from './accounts.js';
import { mediaServersServiceFor } from '../media-servers/index.js';
import { mediaServerAvailability, mediaServerConnections, toServerConn, type FetchLike, type MediaServerAvailability } from './media-server.js';
import { authServiceFor } from '../auth/index.js';
import { getSection } from '../settings/service.js';
import { RequestNotifier, type AgentFactory } from './notify.js';
import { mediaServerRoutes } from './media-server-routes.js';
import { requestsRoutes } from './routes.js';
import { RequestsService, type SizeEstimator, type TitleSource } from './service.js';
import { libraryService } from '../library/index.js';
import { DEFAULT_PORTAL_RATE_LIMIT, TokenBuckets, type MediaServerLoginOption, type RateLimitOptions } from './portal.js';
import { WatchlistService, type WatchlistProvider } from './watchlist.js';

export * from './schema.js';
export { RequestsService, ANIME_KEYWORD, type TitleSource, type CreateOutcome, type TitleStatus, type SizeEstimator } from './service.js';
export { CertificationGuard, restrictionReason, movieRating, tvRating, restrictionsOfSettings } from './certification.js';
export { evaluatePolicy, windowActive, nextOpening, GB, type PolicyResult, type PolicyDecision } from './policy.js';
export { TokenBuckets, publicPortal, type RateLimitOptions } from './portal.js';
export { userRow, findUserRow, userPermissions, patchUserSettings, approvalPolicyOf, type UserRow } from './users.js';
export { actorOf, discoverActorOf } from './routes.js';
export { IssuesService } from './issues.js';
export { DiscoverService } from './discover.js';
export { WatchlistService, plexWatchlistProvider, mediaBrowserWatchlistProvider, type WatchlistProvider, type WatchlistProviderItem } from './watchlist.js';
export { MediaServerAccounts, deviceIdFor, localUsernameFrom } from './accounts.js';
export { RequestNotifier, type AgentFactory, type Delivery } from './notify.js';
export {
  libraryOnlyAvailability,
  jellyfinAvailability,
  mediaServerAvailability,
  configuredServer,
  type MediaServerAvailability,
  type MediaServerLookup,
  type AvailabilityQuery,
} from './media-server.js';
export { RequestsError, REQUESTS_ERROR_STATUS } from './errors.js';
export { REQUESTS_STATUS_SYNC_JOB, WATCHLIST_SYNC_JOB, REQUESTS_DIGEST_JOB, REQUESTS_POLICY_SWEEP_JOB } from './jobs.js';
export * from './permissions.js';

export interface RequestsModuleOptions {
  /** TMDB access; defaults to the metadata module's service. */
  titles?: TitleSource;
  /** Indexer search after approval; defaults to the releases module (resolved at call time). */
  search?: (target: SearchTarget) => Promise<unknown>;
  agentFactory?: AgentFactory;
  /** System-wide notification connections; defaults to the notifications module's dispatcher. */
  systemDispatch?: (event: NotificationEvent) => Promise<unknown>;
  watchlistProviders?: WatchlistProvider[];
  /** Used when settings.useMediaServerAvailability is on; defaults to Settings > Media server (then the Jellyfin/Emby connections). */
  mediaServer?: MediaServerAvailability;
  /** HTTP for media-server and plex.tv calls (tests pass a fake). */
  fetch?: FetchLike;
  /** plex.tv base URL (tests). */
  plexTvUrl?: string;
  /** Release-size estimate for approval policies; defaults to a quick interactive search of library titles. */
  estimateSize?: SizeEstimator;
  /** Anonymous discover limit per IP (public portal). */
  portalRateLimit?: RateLimitOptions;
  now?: () => Date;
}

export interface RequestsServices {
  requests: RequestsService;
  issues: IssuesService;
  discover: DiscoverService;
  watchlist: WatchlistService;
  notifier: RequestNotifier;
  accounts: MediaServerAccounts;
  portalLimiter: TokenBuckets;
}

const ESTIMATE_TIMEOUT_MS = 20_000;

/**
 * Size of the best approved release of a title already in the library, by a quick interactive
 * search (series: the sum over the requested seasons). Titles not in the library, searches
 * without an approved release, and failures give null: size policies are skipped then.
 */
export function interactiveSearchEstimator(ctx: AppContext): SizeEstimator {
  return async ({ type, tmdbId, seasons }) => {
    const releases = releasesServiceFor(ctx);
    const best = async (query: { movieId?: number; seriesId?: number; seasonNumber?: number }): Promise<number | null> => {
      const decisions = await releases.interactiveSearch(query, AbortSignal.timeout(ESTIMATE_TIMEOUT_MS));
      return decisions.find((d) => d.approved)?.size ?? null;
    };
    if (type === 'movie') {
      const movie = libraryService.findMovieByTmdbId(ctx.db, tmdbId);
      return movie ? best({ movieId: movie.id }) : null;
    }
    const show = libraryService.findSeriesByTmdbId(ctx.db, tmdbId);
    if (!show || seasons.length === 0) return null;
    let total = 0;
    for (const seasonNumber of seasons) {
      const size = await best({ seriesId: show.id, seasonNumber });
      if (size === null) return null;
      total += size;
    }
    return total;
  };
}

/** The media-server sign-in the login page offers: the first enabled server with loginEnabled. */
export function mediaServerLoginOf(ctx: AppContext): MediaServerLoginOption {
  const server = mediaServersServiceFor(ctx)
    .stored()
    .find((s) => s.enabled && s.loginEnabled);
  return server ? { kind: server.kind, name: server.name } : null;
}

/** TMDB through the running metadata module, resolved per call so a saved key applies at once. */
export const metadataTitles: TitleSource = {
  client: () => {
    const service = activeMetadataService();
    if (!service) throw new MetadataNotConfiguredError();
    return service.client();
  },
  lookupSeries: (tmdbId) => metadata.series(tmdbId),
  lookupMovie: (tmdbId) => metadata.movie(tmdbId),
};

// One set of services per app context so routes, jobs and other modules share them.
const services = new WeakMap<AppContext, RequestsServices>();

export function requestsServicesFor(ctx: AppContext, opts: RequestsModuleOptions = {}): RequestsServices {
  let found = services.get(ctx);
  if (found) return found;
  const log = ctx.log.child({ module: 'requests' });
  const now = opts.now;
  const notifier = new RequestNotifier({
    db: ctx.db,
    log,
    ...(opts.agentFactory ? { agentFactory: opts.agentFactory } : {}),
    systemDispatch: opts.systemDispatch ?? ((event) => notificationsServiceFor(ctx).dispatch(event)),
    applicationUrl: () => getSection(ctx.db, 'requests').applicationUrl || undefined,
    ...(now ? { now } : {}),
  });
  const titles = opts.titles ?? metadataTitles;
  const requests = new RequestsService({
    db: ctx.db,
    bus: ctx.bus,
    log,
    titles,
    notifier,
    search: opts.search ?? ((target) => releasesServiceFor(ctx).searchFor(target)),
    // Availability asks the servers of Settings > Media servers flagged usedForAvailability
    // (falling back to the Jellyfin/Emby notification connections when there are none).
    mediaServer:
      opts.mediaServer ??
      mediaServerAvailability(ctx.db, opts.fetch, {
        servers: (db) => {
          const listed = mediaServersServiceFor(ctx).clients('availability').map((c) => toServerConn(c.config));
          return listed.length > 0 ? listed : mediaServerConnections(db);
        },
      }),
    estimateSize: opts.estimateSize ?? interactiveSearchEstimator(ctx),
    ...(now ? { now } : {}),
  });
  const issues = new IssuesService({ db: ctx.db, bus: ctx.bus, log, titles, notifier, ...(now ? { now } : {}) });
  const watchlist = new WatchlistService({
    db: ctx.db,
    log,
    requests,
    ...(opts.watchlistProviders ? { providers: opts.watchlistProviders } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const discover = new DiscoverService({ db: ctx.db, bus: ctx.bus, requests, issues, watchlist });
  const accounts = new MediaServerAccounts({
    db: ctx.db,
    log,
    requests,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.plexTvUrl ? { plexTvUrl: opts.plexTvUrl } : {}),
    ...(now ? { now } : {}),
  });
  // Jellyfin/Emby sign-in on POST /auth/login goes through the media-server settings owned here.
  const auth = authServiceFor(ctx);
  auth.externalLogin = accounts;
  // GET /auth/status tells the login page which media-server sign-in to offer.
  auth.mediaServerLogin = () => mediaServerLoginOf(ctx);
  const portalLimiter = new TokenBuckets(opts.portalRateLimit ?? DEFAULT_PORTAL_RATE_LIMIT);
  found = { requests, issues, discover, watchlist, notifier, accounts, portalLimiter };
  services.set(ctx, found);
  return found;
}

/** Requests, discover, issues, override rules, watchlists, per-user quotas and permissions. */
export const requestsModuleWith =
  (opts: RequestsModuleOptions): AppModule =>
  (ctx) =>
  async (app) => {
    const s = requestsServicesFor(ctx, opts);
    s.discover.ensureDefaultSliders();
    await app.register(
      requestsRoutes({
        ...s,
        runWatchlistSync: () => s.watchlist.sync(),
        mediaServerLogin: () => mediaServerLoginOf(ctx),
      }),
    );
    registerRequestsJobs(ctx.scheduler, s.requests, s.watchlist);
    await app.register(mediaServerRoutes(ctx, s.accounts, s.requests));
  };

export const requestsModule: AppModule = requestsModuleWith({});
