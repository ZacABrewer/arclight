import { join } from 'node:path';
import type { AppContext, AppModule } from '../../app.js';
import { getIndexerGlobalSettings, getSection, updateIndexerGlobalSettings } from '../settings/service.js';
import { DefinitionStore } from './definitions.js';
import { registerIndexerJobs, rescheduleRssSync } from './jobs.js';
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
  type ReleaseDownload,
  type ReleasesHandler,
  type SearchGrabber,
  type SearchGrabOutcome,
  type SearchMode,
  type SearchOptions,
} from './service.js';
export { DefinitionStore } from './definitions.js';
export {
  RSS_SYNC_JOB,
  INDEXER_STATUS_CHECK_JOB,
  INDEXER_STATS_CLEANUP_JOB,
  rssCronFor,
  rescheduleRssSync,
} from './jobs.js';
export * from './schema.js';

// One service per app context, so the release pipeline (another module) and the routes
// share failure state, rate limiters, definition clients and hooks in-process.
const services = new WeakMap<AppContext, IndexersService>();

export function indexersServiceFor(ctx: AppContext): IndexersService {
  let service = services.get(ctx);
  if (!service) {
    const log = ctx.log.child({ module: 'indexers' });
    const configDir = ctx.config?.configDir;
    const definitions = new DefinitionStore({
      log,
      watch: true,
      ...(configDir ? { customDir: join(configDir, 'definitions') } : {}),
    });
    service = new IndexersService({ db: ctx.db, log, definitions });
    services.set(ctx, service);
  }
  return service;
}

export const indexersModule: AppModule = (ctx) => async (app) => {
  const service = indexersServiceFor(ctx);
  await service.definitions.ready();
  await service.definitions.startWatching();
  app.addHook('onClose', async () => service.definitions.stopWatching());

  await app.register(
    indexersRoutes(service, {
      settings: {
        get: () => getIndexerGlobalSettings(ctx.db),
        update: (value) => {
          const saved = updateIndexerGlobalSettings(ctx.db, value);
          rescheduleRssSync(ctx.scheduler, saved.rssSyncIntervalMinutes);
          return saved;
        },
      },
    }),
  );
  registerIndexerJobs(ctx.scheduler, service, { rssIntervalMinutes: getSection(ctx.db, 'indexers').rssSyncIntervalMinutes });
};
