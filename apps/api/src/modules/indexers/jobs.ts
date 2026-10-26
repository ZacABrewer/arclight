import type { Scheduler } from '../../scheduler.js';
import type { IndexersService } from './service.js';

export const RSS_SYNC_JOB = 'RssSync';
export const INDEXER_STATUS_CHECK_JOB = 'IndexerStatusCheck';

export interface IndexerJobOptions {
  /** Cron for RSS sync; every 15 minutes by default. */
  rssCron?: string;
  /** Cron for the status check; hourly by default. */
  statusCron?: string;
}

export function registerIndexerJobs(scheduler: Scheduler, service: IndexersService, opts: IndexerJobOptions = {}): void {
  scheduler.register({
    name: RSS_SYNC_JOB,
    cron: opts.rssCron ?? '*/15 * * * *',
    handler: async ({ signal }) => {
      const releases = await service.rss({ signal });
      await service.dispatchReleases(releases);
      return `${releases.length} new releases`;
    },
  });

  scheduler.register({
    name: INDEXER_STATUS_CHECK_JOB,
    cron: opts.statusCron ?? '0 * * * *',
    handler: async ({ signal }) => service.statusCheck(signal),
  });
}
