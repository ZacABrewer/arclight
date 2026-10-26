import type { Scheduler } from '../../scheduler.js';
import type { RetentionService } from './service.js';

export const RETENTION_SWEEP_JOB = 'RetentionSweep';
/** Daily at 03:30 local time, after the nightly backups and before people start watching. */
export const RETENTION_SWEEP_CRON = '30 3 * * *';

export function registerRetentionJobs(scheduler: Scheduler, service: RetentionService): void {
  scheduler.register({
    name: RETENTION_SWEEP_JOB,
    cron: RETENTION_SWEEP_CRON,
    handler: async () => {
      const r = await service.sweep();
      const skipped = r.rulesSkipped.length > 0 ? `, ${r.rulesSkipped.length} rule(s) skipped` : '';
      return `${r.rulesEvaluated} rule(s) evaluated, ${r.staged} staged, ${r.applied} applied, ${r.failed} failed${skipped}`;
    },
  });
}
