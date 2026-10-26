import type { Scheduler } from '../../scheduler.js';
import type { TransferMetricsService } from './service.js';

/** Hourly: folds finished hours of 1-minute transfer points into hourly roll-ups. */
export const TRANSFER_METRICS_ROLLUP_JOB = 'TransferMetricsRollup';
/** Daily: drops 1-minute points after 7 days, hourly points and VPN events after 90. */
export const TRANSFER_METRICS_PRUNE_JOB = 'TransferMetricsPrune';

export function registerTransferMetricsJobs(scheduler: Scheduler, service: TransferMetricsService): void {
  scheduler.register({
    name: TRANSFER_METRICS_ROLLUP_JOB,
    cron: '2 * * * *',
    handler: async () => `${service.rollup()} hourly points written`,
  });
  scheduler.register({
    name: TRANSFER_METRICS_PRUNE_JOB,
    cron: '53 3 * * *',
    handler: async () => {
      const r = service.prune();
      return `removed ${r.minutes} minute points, ${r.hours} hourly points, ${r.events} VPN events`;
    },
  });
}
