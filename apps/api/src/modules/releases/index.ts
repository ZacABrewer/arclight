import type { AppContext, AppModule } from '../../app.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { indexersServiceFor } from '../indexers/index.js';
import type { ReleasesDeps } from './deps.js';
import { registerReleaseJobs } from './jobs.js';
import { releasesRoutes } from './routes.js';
import { ReleasesService } from './service.js';

export * from './deps.js';
export * from './schema.js';
export {
  ReleasesService,
  ReleasesError,
  type DownloadPort,
  type IndexerPort,
  type SearchSummary,
  type SearchTarget,
} from './service.js';
export {
  CUTOFF_UNMET_SEARCH_JOB,
  MISSING_EPISODE_SEARCH_JOB,
  MISSING_MOVIE_SEARCH_JOB,
  PROCESS_PENDING_RELEASES_JOB,
} from './jobs.js';
export { cleanTitle, matchRelease, type LibrarySnapshot, type MatchResult } from './matcher.js';
export { cutoffNotMet, isUpgradable, isUpgradeAllowed, prioritize, specifications } from './engine.js';

// One service per app context so other modules (e.g. library "search on add") can reach it.
const services = new WeakMap<AppContext, ReleasesService>();

export function releasesServiceFor(ctx: AppContext, deps: ReleasesDeps = {}): ReleasesService {
  let service = services.get(ctx);
  if (!service) {
    service = new ReleasesService({
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'releases' }),
      indexers: indexersServiceFor(ctx),
      downloads: getDownloadClientsService(ctx),
      deps,
    });
    services.set(ctx, service);
  }
  return service;
}

/** The module with real history / blocklist / settings hooks wired in. */
export const releasesModuleWith =
  (deps: ReleasesDeps): AppModule =>
  (ctx) =>
  async (app) => {
    const service = releasesServiceFor(ctx, deps);
    service.attach();
    await app.register(releasesRoutes(service));
    registerReleaseJobs(ctx.scheduler, service);
  };

/** Stand-alone variant: no history, nothing blocklisted, propers `preferAndUpgrade`. */
export const releasesModule: AppModule = releasesModuleWith({});
