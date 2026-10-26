import { join } from 'node:path';
import type { AppContext, AppModule } from '../../app.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { indexersServiceFor } from '../indexers/index.js';
import { torrentServiceFor } from '../torrent/index.js';
import { trackerStatsServiceFor } from '../tracker-stats/index.js';
import { crossSeedRoutes } from './routes.js';
import { CrossSeedService } from './service.js';

export {
  CrossSeedService,
  CrossSeedError,
  cleanName,
  sizeMatches,
  titleMismatch,
  verifyEnds,
  type CrossSeedClient,
  type CrossSeedErrorCode,
  type CrossSeedIndexersPort,
  type CrossSeedServiceOptions,
} from './service.js';
export * from './schema.js';

export const CROSS_SEED_SEARCH_JOB = 'CrossSeedSearch';

// Cross-seeding of library files from other torrent indexers (see service.ts). Registers the
// CrossSeedSearch job (cron from the `crossSeed` settings section), the post-import search and
// the info-hash resolver tracker-stats uses to attribute cross-seeds to their indexer.

const services = new WeakMap<AppContext, CrossSeedService>();

export function crossSeedServiceFor(ctx: AppContext): CrossSeedService {
  let service = services.get(ctx);
  if (!service) {
    service = new CrossSeedService({
      db: ctx.db,
      // Resolved lazily so module registration order does not matter.
      indexers: {
        list: () => indexersServiceFor(ctx).list(),
        search: (request, opts) => indexersServiceFor(ctx).search(request, opts),
        downloadRelease: (indexerId, url) => indexersServiceFor(ctx).downloadRelease(indexerId, url),
      },
      clients: () =>
        getDownloadClientsService(ctx)
          .enabledClients()
          .map(({ config, client }) => ({ id: config.id, name: config.name, implementation: config.implementation, client })),
      session: () => torrentServiceFor(ctx).session,
      defaultLinkDir: () => join(torrentServiceFor(ctx).effectiveDownloadsRoot(), 'cross-seed'),
      log: ctx.log.child({ module: 'cross-seed' }),
      onAdded: () => trackerStatsServiceFor(ctx).invalidate(),
    });
    services.set(ctx, service);
  }
  return service;
}

export const crossSeedModule: AppModule = (ctx) => async (app) => {
  const service = crossSeedServiceFor(ctx);
  ctx.scheduler.register({
    name: CROSS_SEED_SEARCH_JOB,
    cron: service.settings().schedule,
    handler: async ({ signal }) => service.runScheduled(signal),
  });
  await app.register(
    crossSeedRoutes(service, {
      settingsChanged: (s) => ctx.scheduler.update(CROSS_SEED_SEARCH_JOB, s.schedule),
    }),
  );

  const unresolve = trackerStatsServiceFor(ctx).registerInfoHashResolver((h) => service.indexerFor(h));
  const unsubscribe = ctx.bus.subscribe((event) => {
    if (event.type !== 'import' || event.action !== 'imported' || !event.mediaType || event.mediaId === undefined) return;
    void service
      .searchAfterImport(event.mediaType, event.mediaId)
      .catch((err: unknown) => ctx.log.warn({ err }, 'cross-seed search after import failed'));
  });
  app.addHook('onClose', async () => {
    unsubscribe();
    unresolve();
  });
};
