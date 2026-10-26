import type { Scheduler } from '../../scheduler.js';
import type { HistoryService } from './service.js';

export const HISTORY_CLEANUP_JOB = 'HistoryCleanup';

export interface HistoryJobOptions {
  /** Cron for the cleanup; daily at 03:30 by default. */
  cleanupCron?: string;
}

export function registerHistoryJobs(scheduler: Scheduler, service: HistoryService, opts: HistoryJobOptions = {}): void {
  scheduler.register({
    name: HISTORY_CLEANUP_JOB,
    cron: opts.cleanupCron ?? '30 3 * * *',
    handler: async () => {
      const { orphaned, expired } = service.cleanup();
      return `removed ${orphaned} orphaned and ${expired} expired history rows`;
    },
  });
}
