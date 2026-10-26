import type { NotificationEvent } from '@media-tron/notifications';
import type { AppContext, AppModule } from '../../app.js';
import { metadata, activeMetadataService, MetadataNotConfiguredError } from '../metadata/index.js';
import { notificationsServiceFor } from '../notifications/index.js';
import { releasesServiceFor, type SearchTarget } from '../releases/index.js';
import { DiscoverService } from './discover.js';
import { IssuesService } from './issues.js';
import { registerRequestsJobs } from './jobs.js';
import { jellyfinAvailability, type MediaServerAvailability } from './media-server.js';
import { RequestNotifier, type AgentFactory } from './notify.js';
import { requestsRoutes } from './routes.js';
import { RequestsService, type TitleSource } from './service.js';
import { WatchlistService, type WatchlistProvider } from './watchlist.js';

export * from './schema.js';
export { RequestsService, ANIME_KEYWORD, type TitleSource, type CreateOutcome, type TitleStatus } from './service.js';
export { IssuesService } from './issues.js';
export { DiscoverService } from './discover.js';
export { WatchlistService, plexWatchlistProvider, jellyfinWatchlistProvider, type WatchlistProvider, type WatchlistProviderItem } from './watchlist.js';
export { RequestNotifier, type AgentFactory, type Delivery } from './notify.js';
export { libraryOnlyAvailability, jellyfinAvailability, type MediaServerAvailability, type AvailabilityQuery } from './media-server.js';
export { RequestsError, REQUESTS_ERROR_STATUS } from './errors.js';
export { REQUESTS_STATUS_SYNC_JOB, WATCHLIST_SYNC_JOB } from './jobs.js';
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
  /** Used when settings.useMediaServerAvailability is on; defaults to the Jellyfin/Emby connections. */
  mediaServer?: MediaServerAvailability;
  now?: () => Date;
}

export interface RequestsServices {
  requests: RequestsService;
  issues: IssuesService;
  discover: DiscoverService;
  watchlist: WatchlistService;
  notifier: RequestNotifier;
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
    mediaServer: opts.mediaServer ?? jellyfinAvailability(ctx.db),
    ...(now ? { now } : {}),
  });
  const issues = new IssuesService({ db: ctx.db, bus: ctx.bus, log, titles, notifier, ...(now ? { now } : {}) });
  const watchlist = new WatchlistService({ db: ctx.db, log, requests, ...(opts.watchlistProviders ? { providers: opts.watchlistProviders } : {}) });
  const discover = new DiscoverService({ db: ctx.db, bus: ctx.bus, requests, issues, watchlist });
  found = { requests, issues, discover, watchlist, notifier };
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
      }),
    );
    registerRequestsJobs(ctx.scheduler, s.requests, s.watchlist);
  };

export const requestsModule: AppModule = requestsModuleWith({});
