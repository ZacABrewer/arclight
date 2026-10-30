import type { Job, HealthScanRequest } from '@arclight/shared';
import type { Scheduler } from '../../scheduler.js';
import { scheduleCron } from './checks.js';
import type { HealthScanService, ScanResult } from './service.js';

/** The whole-library scan (scheduled, and POST /library/health/scan with `all`). */
export const HEALTH_SCAN_JOB = 'HealthScan';
/** Checks of chosen items or files ("Check now", re-check, the library selection). */
export const HEALTH_CHECK_JOB = 'HealthCheck';

export function scanMessage(r: ScanResult, stopReason?: string): string {
  const parts = [`${r.checked} files checked`];
  if (r.skipped) parts.push(`${r.skipped} unchanged`);
  parts.push(`${r.newFindings} new problem${r.newFindings === 1 ? '' : 's'}`);
  if (r.fixed) parts.push(`${r.fixed} fixed`);
  const left = r.files - r.checked - r.skipped;
  if (r.stoppedEarly && left > 0) parts.push(`${stopReason ?? 'stopped'}; ${left} left for the next run`);
  return parts.join(', ');
}

/**
 * HealthScan: weekly by default (Sunday 03:00, or the window start when a window is set); the
 * schedule follows the `healthScan` settings (`off` leaves it on demand only).
 */
export function registerHealthScanJobs(scheduler: Scheduler, service: HealthScanService): void {
  const cron = scheduleCron(service.settings());
  scheduler.register({
    name: HEALTH_SCAN_JOB,
    ...(cron ? { cron } : {}),
    handler: async ({ signal }) => {
      const r = await service.scan({ all: true }, { signal, scheduled: true });
      return scanMessage(r, 'stopped at the end of the time window');
    },
  });
}

/** Follow a settings change: new cron (or none). */
export function applySchedule(scheduler: Scheduler, service: HealthScanService): void {
  scheduler.update(HEALTH_SCAN_JOB, scheduleCron(service.settings()));
}

/** Starts a scan as a job and answers its initial row. */
export function startScan(scheduler: Scheduler, service: HealthScanService, req: HealthScanRequest): Job {
  if (req.all) {
    return scheduler.runTask(
      HEALTH_SCAN_JOB,
      'manual',
      async ({ signal }) => scanMessage(await service.scan(req, { signal }), 'cancelled'),
      { key: HEALTH_SCAN_JOB },
    ).job;
  }
  const key = `${HEALTH_CHECK_JOB}:${JSON.stringify(req)}`;
  return scheduler.runTask(HEALTH_CHECK_JOB, 'manual', async ({ signal }) => scanMessage(await service.scan(req, { signal }), 'cancelled'), { key }).job;
}
