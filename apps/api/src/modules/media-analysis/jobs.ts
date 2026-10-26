import type { Scheduler } from '../../scheduler.js';
import type { MediaAnalysisQueue } from './service.js';

export const MEDIA_ANALYSIS_JOB = 'AnalyzeMedia';

/**
 * AnalyzeMedia drains the queue (N files at a time). It runs every 15 minutes, which also
 * picks up files that never got media info, and is started on demand whenever files are queued
 * while it is idle.
 */
export function registerMediaAnalysisJobs(scheduler: Scheduler, queue: MediaAnalysisQueue): void {
  scheduler.register({
    name: MEDIA_ANALYSIS_JOB,
    cron: '*/15 * * * *',
    handler: async ({ signal }) => {
      queue.enqueueAllMissing();
      const r = await queue.process({ signal });
      if (r.skipped) return 'ffprobe not found; files stay queued';
      if (r.done + r.failed + r.pruned === 0) return 'idle';
      return `${r.done} analyzed, ${r.failed} failed${r.pruned ? `, ${r.pruned} removed` : ''}`;
    },
  });
  // Queued while idle -> run now (the scheduler's one-at-a-time rule absorbs bursts).
  queue.setKicker(() => {
    if (!queue.processing) void scheduler.run(MEDIA_ANALYSIS_JOB, 'system');
  });
}
