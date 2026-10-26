import type { AppContext, AppModule } from '../../app.js';
import { registerIndexerJobs } from './jobs.js';
import { indexersRoutes } from './routes.js';
import { IndexersService } from './service.js';

export {
  IndexersService,
  IndexersError,
  BACKOFF_STEPS_MS,
  CAPS_TTL_MS,
  backoffFor,
  type IndexerStatusChange,
  type IndexerStatusListener,
  type ManualSearchResolver,
  type ReleasesHandler,
  type SearchMode,
  type SearchOptions,
} from './service.js';
export { RSS_SYNC_JOB, INDEXER_STATUS_CHECK_JOB } from './jobs.js';
export * from './schema.js';

// One service per app context, so the release pipeline (another module) and the routes
// share failure state, rate limiters and hooks in-process.
const services = new WeakMap<AppContext, IndexersService>();

export function indexersServiceFor(ctx: AppContext): IndexersService {
  let service = services.get(ctx);
  if (!service) {
    service = new IndexersService({ db: ctx.db, log: ctx.log.child({ module: 'indexers' }) });
    services.set(ctx, service);
  }
  return service;
}

export const indexersModule: AppModule = (ctx) => async (app) => {
  const service = indexersServiceFor(ctx);
  await app.register(indexersRoutes(service));
  registerIndexerJobs(ctx.scheduler, service);
};
