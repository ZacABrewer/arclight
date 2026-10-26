import type { Scheduler } from '../../scheduler.js';
import type { StatsService } from './service.js';

export const STATS_SNAPSHOT_JOB = 'StatsSnapshot';

/** StatsSnapshot: daily storage snapshot per root folder (growth figures of /stats/storage). */
export function registerStatsJobs(scheduler: Scheduler, service: StatsService): void {
  scheduler.register({
    name: STATS_SNAPSHOT_JOB,
    cron: '15 0 * * *',
    handler: async () => {
      const r = await service.snapshot();
      return `snapshot ${r.date} for ${r.rootFolders} root folders`;
    },
  });
}
