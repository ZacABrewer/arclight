import type { Scheduler } from '../../scheduler.js';
import type { TranscodeService } from './service.js';

export const TRANSCODE_WORKER_JOB = 'TranscodeWorker';
/** Every 5 minutes: queued jobs whose rule window just opened start within 5 minutes. */
export const TRANSCODE_WORKER_CRON = '*/5 * * * *';

/**
 * TranscodeWorker drains the transcode queue one file at a time (the scheduler never runs two
 * instances of a job, and the service shares one drain between callers). It also starts on
 * demand whenever a job is queued while it is idle.
 */
export function registerTranscodeJobs(scheduler: Scheduler, service: TranscodeService): void {
  scheduler.register({
    name: TRANSCODE_WORKER_JOB,
    cron: TRANSCODE_WORKER_CRON,
    handler: async ({ signal }) => {
      const r = await service.process({ signal });
      if (r.skipped) return 'ffmpeg not found; jobs stay queued';
      const parts: string[] = [];
      if (r.completed) parts.push(`${r.completed} transcoded`);
      if (r.failed) parts.push(`${r.failed} failed`);
      if (r.cancelled) parts.push(`${r.cancelled} cancelled`);
      if (r.waiting) parts.push(`${r.waiting} waiting for their window`);
      return parts.length ? parts.join(', ') : 'idle';
    },
  });
  service.setKicker(() => {
    if (!service.processing) void scheduler.run(TRANSCODE_WORKER_JOB, 'system');
  });
}
