import type { AppContext, AppModule } from '../../app.js';
import { healthServiceFor } from '../health/index.js';
import { registerMediaAnalysisJobs } from './jobs.js';
import { mediaAnalysisRoutes } from './routes.js';
import { FfprobeRunner, type MediaProber } from './runner.js';
import { MediaAnalysisQueue } from './service.js';
import { ffprobeMissingCheck } from './health.js';

export { MediaAnalysisQueue, MediaAnalysisError, defaultConcurrency, type AnalyzeTarget, type ProcessResult } from './service.js';
export { FfprobeRunner, FfprobeError, locateFfprobe, nodeExec, createAnalysisProbe, toProbeResult, type ExecFn, type MediaProber } from './runner.js';
export { parseFfprobeOutput, detectDynamicRange, FfprobeParseError } from './parse.js';
export { MEDIA_ANALYSIS_JOB } from './jobs.js';
export { ffprobeMissingCheck } from './health.js';
export * from './schema.js';

// Media analysis: ffprobe -> MediaInfo on media_files, through a persisted queue.

const queues = new WeakMap<AppContext, MediaAnalysisQueue>();
const runners = new WeakMap<AppContext, FfprobeRunner>();

/** The ffprobe runner of this context (wiring uses it for the imports probe / probeDuration). */
export function ffprobeRunnerFor(ctx: AppContext): FfprobeRunner {
  let runner = runners.get(ctx);
  if (!runner) {
    runner = new FfprobeRunner();
    runners.set(ctx, runner);
  }
  return runner;
}

/** The analysis queue of this context; `prober` replaces ffprobe (tests) on first use only. */
export function mediaAnalysisFor(ctx: AppContext, prober?: MediaProber): MediaAnalysisQueue {
  let queue = queues.get(ctx);
  if (!queue) {
    queue = new MediaAnalysisQueue({
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'media-analysis' }),
      prober: prober ?? ffprobeRunnerFor(ctx),
    });
    queues.set(ctx, queue);
  }
  return queue;
}

/** Duration (seconds) of a file through ffprobe; null when unreadable or ffprobe is missing. */
export function probeDurationFor(ctx: AppContext): (path: string) => Promise<number | null> {
  return (path) => ffprobeRunnerFor(ctx).probeDuration(path);
}

export interface MediaAnalysisModuleOptions {
  prober?: MediaProber;
}

export const mediaAnalysisModuleWith =
  (opts: MediaAnalysisModuleOptions = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const queue = mediaAnalysisFor(ctx, opts.prober);
    queue.recoverInterrupted();
    await app.register(mediaAnalysisRoutes(queue));
    registerMediaAnalysisJobs(ctx.scheduler, queue);
    const unregisterCheck = healthServiceFor(ctx).register(ffprobeMissingCheck(queue.prober));
    // Any new library file without media info (imports, rescans, manual imports) is queued.
    const unsubscribe = ctx.bus.subscribe((event) => {
      if (event.type === 'library' && event.action === 'fileAdded') {
        try {
          queue.enqueueMissingFor(event.mediaType, event.id);
        } catch (err) {
          ctx.log.warn({ err }, 'could not queue media analysis');
        }
      }
    });
    app.addHook('onClose', async () => {
      unsubscribe();
      unregisterCheck();
      queue.setKicker(null);
    });
  };

export const mediaAnalysisModule: AppModule = mediaAnalysisModuleWith();
