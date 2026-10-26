import type { AppContext, AppModule } from '../../app.js';
import { indexersServiceFor } from '../indexers/index.js';
import { createCutoffChecker } from '../library/index.js';
import { ProfilesService } from '../profiles/index.js';
import { registerStatsJobs } from './jobs.js';
import { statsRoutes } from './routes.js';
import { StatsService, type StatsServiceOptions } from './service.js';

export { StatsService, StatsError, nodeDiskUsage, resolutionBucket, type DiskUsage, type DiskUsageFn } from './service.js';
export { STATS_SNAPSHOT_JOB, registerStatsJobs } from './jobs.js';
export * from './schema.js';

// Library analytics: storage, library counts, activity, indexer usage.

const services = new WeakMap<AppContext, StatsService>();

export function statsServiceFor(ctx: AppContext, overrides: Partial<StatsServiceOptions> = {}): StatsService {
  let service = services.get(ctx);
  if (!service) {
    service = new StatsService({
      db: ctx.db,
      // Resolved per call so module order does not matter.
      indexerStats: (days) => indexersServiceFor(ctx).stats.query(days),
      cutoffChecker: () => createCutoffChecker(ctx.db, new ProfilesService({ db: ctx.db })),
      ...overrides,
    });
    services.set(ctx, service);
  }
  return service;
}

export const statsModuleWith =
  (overrides: Partial<StatsServiceOptions> = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const service = statsServiceFor(ctx, overrides);
    await app.register(statsRoutes(service));
    registerStatsJobs(ctx.scheduler, service);
  };

export const statsModule: AppModule = statsModuleWith();
