import type { AppModule } from '../../app.js';
import { mediaServersServiceFor } from '../media-servers/index.js';
import { getSection } from '../settings/service.js';
import { linkedUsers, watchHistoryFor } from '../watch-history/index.js';
import { notificationsServiceFor } from '../notifications/index.js';
import { RetentionActions } from './actions.js';
import { registerRetentionJobs } from './jobs.js';
import { retentionRoutes } from './routes.js';
import { RetentionService, type RetentionServiceOptions } from './service.js';

export { RetentionService, RetentionError, type RetentionServiceOptions, type RetentionWatchSource, type LinkedOwner } from './service.js';
export { RetentionActions, type ApplyAction, type ApplyOutcome } from './actions.js';
export { RETENTION_SWEEP_JOB, RETENTION_SWEEP_CRON } from './jobs.js';
export * from './schema.js';

/** Test seams; production passes none. */
export type RetentionModuleOptions = Partial<Pick<RetentionServiceOptions, 'servers' | 'apply' | 'notify' | 'now' | 'watchSource'>>;

// Watched-based retention: rules, staged candidates, the daily RetentionSweep. Play state comes
// from the servers flagged `usedForRetention` (media-servers module), read from the stored watch
// history (watch-history module) where it is synced and live otherwise; actions run through the
// library service; the admin summary goes out as a `retention` notification.
export const retentionModuleWith =
  (opts: RetentionModuleOptions = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const servers = mediaServersServiceFor(ctx);
    const notifications = notificationsServiceFor(ctx);
    const service = new RetentionService({
      db: ctx.db,
      servers: opts.servers ?? (() => servers.clients('retention')),
      // Stored watch history where it is synced (watch-history module), resolved per sweep.
      watchSource:
        opts.watchSource ??
        (() => {
          const queries = watchHistoryFor(ctx).queries;
          return {
            covered: () => queries.coveredServers(getSection(ctx.db, 'watchHistory')),
            rows: (mediaType, serverIds) => queries.retentionRows(mediaType, serverIds),
            links: () => linkedUsers(ctx.db),
          };
        }),
      apply: opts.apply ?? new RetentionActions(ctx.db, ctx.bus).apply,
      notify: opts.notify ?? ((event) => notifications.dispatch(event)),
      log: ctx.log.child({ module: 'retention' }),
      ...(opts.now ? { now: opts.now } : {}),
    });
    await app.register(retentionRoutes(service));
    registerRetentionJobs(ctx.scheduler, service);
  };

export const retentionModule: AppModule = retentionModuleWith();
