import type { Scheduler } from '../../scheduler.js';
import type { IndexersService } from './service.js';

export const RSS_SYNC_JOB = 'RssSync';
export const INDEXER_STATUS_CHECK_JOB = 'IndexerStatusCheck';
export const INDEXER_STATS_CLEANUP_JOB = 'IndexerStatsCleanup';

export const DEFAULT_RSS_SYNC_MINUTES = 15;

export interface IndexerJobOptions {
  /** Cron for RSS sync; overrides `rssIntervalMinutes`. */
  rssCron?: string;
  /** RSS sync interval from Settings → Indexer options; 0 = on demand only. Default 15. */
  rssIntervalMinutes?: number;
  /** Cron for the status check; hourly by default. */
  statusCron?: string;
  /** Cron for pruning stats older than 90 days; nightly by default. */
  statsCleanupCron?: string;
}

/**
 * Cron for an RSS interval in minutes: `*\/N` minutes below an hour, whole hours (rounded)
 * above. null = disabled (0).
 */
export function rssCronFor(minutes: number): string | null {
  if (minutes <= 0) return null;
  if (minutes < 60) return `*/${Math.max(1, Math.round(minutes))} * * * *`;
  const hours = Math.min(24, Math.max(1, Math.round(minutes / 60)));
  return hours >= 24 ? '0 0 * * *' : `0 */${hours} * * *`;
}

export function registerIndexerJobs(scheduler: Scheduler, service: IndexersService, opts: IndexerJobOptions = {}): void {
  const rssCron = opts.rssCron ?? rssCronFor(opts.rssIntervalMinutes ?? DEFAULT_RSS_SYNC_MINUTES);
  scheduler.register({
    name: RSS_SYNC_JOB,
    ...(rssCron ? { cron: rssCron } : {}),
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

  scheduler.register({
    name: INDEXER_STATS_CLEANUP_JOB,
    cron: opts.statsCleanupCron ?? '20 3 * * *',
    handler: async () => `removed ${service.stats.prune()} indexer stat rows older than 90 days`,
  });
}

/** Apply a changed RSS interval to the running scheduler. */
export function rescheduleRssSync(scheduler: Scheduler, minutes: number): void {
  if (scheduler.has(RSS_SYNC_JOB)) scheduler.update(RSS_SYNC_JOB, rssCronFor(minutes));
}
