import type { Scheduler } from '../../../scheduler.js';
import type { SoulseekService } from './service.js';

export const SOULSEEK_MONITOR_JOB = 'SoulseekMonitor';
export const SOULSEEK_SEARCH_JOB = 'SoulseekSearch';

/**
 * The monitor follows active transfers every two minutes (a no-op without any); the automatic
 * search runs every 6 hours and only acts when `soulseek.autoSearch` is on.
 */
export function registerSoulseekJobs(scheduler: Scheduler, service: SoulseekService): void {
  if (!scheduler.has(SOULSEEK_MONITOR_JOB)) {
    scheduler.register({ name: SOULSEEK_MONITOR_JOB, cron: '*/2 * * * *', handler: async () => service.monitor() });
  }
  if (!scheduler.has(SOULSEEK_SEARCH_JOB)) {
    scheduler.register({ name: SOULSEEK_SEARCH_JOB, cron: '40 */6 * * *', handler: async ({ signal }) => service.autoSearchWanted(signal) });
  }
}
