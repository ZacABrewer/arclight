import type { AppContext, AppModule } from '../../app.js';
import { healthServiceFor } from '../health/index.js';
import { docsUrl } from '../health/types.js';
import { indexersServiceFor } from '../indexers/index.js';
import { torrentServiceFor } from '../torrent/index.js';
import { trackerStatsRoutes } from './routes.js';
import { TrackerStatsService } from './service.js';

export {
  TrackerStatsService,
  TrackerStatsError,
  hostMatches,
  isFreeleech,
  ratioStatusOf,
  ruleOf,
  type InfoHashResolver,
  type ReleaseFilterResult,
  type TrackerIndexersPort,
  type TrackerStatsErrorCode,
  type TrackerStatsServiceOptions,
} from './service.js';
export * from './schema.js';

export const TRACKER_STATS_SYNC_JOB = 'TrackerStatsSync';
export const TRACKER_RATIO_CHECK = 'TrackerRatioLow';

// Private-tracker helpers: per-indexer account settings, engine + account-page statistics,
// the H&R guard rules for the built-in client, a freeleech-only release filter and the
// TrackerRatioLow health check.
//
// Hooks for other modules: `trackerStatsServiceFor(ctx).releaseFilter(indexerId, release)`
// (decision engine) and `.registerInfoHashResolver(fn)` (cross-seed).

const services = new WeakMap<AppContext, TrackerStatsService>();

export function trackerStatsServiceFor(ctx: AppContext): TrackerStatsService {
  let service = services.get(ctx);
  if (!service) {
    service = new TrackerStatsService({
      db: ctx.db,
      // Resolved lazily so module registration order does not matter.
      indexers: {
        list: () => indexersServiceFor(ctx).list(),
        siteHosts: (id) => indexersServiceFor(ctx).siteHosts(id),
        hasAccountPage: (id) => indexersServiceFor(ctx).hasAccountPage(id),
        accountStats: (id, signal) => indexersServiceFor(ctx).accountStats(id, signal),
      },
      session: () => torrentServiceFor(ctx).session,
      log: ctx.log.child({ module: 'tracker-stats' }),
    });
    services.set(ctx, service);
  }
  return service;
}

export const trackerStatsModule: AppModule = (ctx) => async (app) => {
  const service = trackerStatsServiceFor(ctx);
  await app.register(trackerStatsRoutes(service));

  // H&R guard: builtin clients consult these rules before removing a finished torrent.
  torrentServiceFor(ctx).setSeedRuleProvider(service.seedRuleProvider());
  // New grabs change torrent attribution.
  const unsubscribe = ctx.bus.subscribe((event) => {
    if (event.type === 'queue' || event.type === 'settings') service.invalidate();
  });
  app.addHook('onClose', async () => unsubscribe());

  const unregister = healthServiceFor(ctx).register({
    id: TRACKER_RATIO_CHECK,
    run: async () => service.healthFindings().map((f) => ({ ...f, wikiUrl: docsUrl('tracker-ratio-low') })),
  });
  app.addHook('onClose', async () => unregister());

  ctx.scheduler.register({
    name: TRACKER_STATS_SYNC_JOB,
    cron: '*/30 * * * *',
    handler: async ({ signal }) => service.sync(signal),
  });
};
