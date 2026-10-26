import { eq } from 'drizzle-orm';
import type { FileTranscodedEvent } from '@arclight/notifications';
import type { AppContext, AppModule } from '../../app.js';
import { episodes } from '../../db/schema.js';
import { mediaAnalysisFor } from '../media-analysis/index.js';
import { EventTranslator, notificationsServiceFor, toEpisodeInfo, toFileInfo } from '../notifications/index.js';
import { registerTranscodeJobs } from './jobs.js';
import { transcodeRoutes } from './routes.js';
import { FfmpegRunner, type TranscodeRunner } from './runner.js';
import { TranscodeService, type TranscodedNotice, type TranscodeServiceOptions } from './service.js';

export { TranscodeService, TranscodeError, formatSize, toRule, type TranscodedNotice, type WorkerResult, type TranscodeServiceOptions } from './service.js';
export { FfmpegRunner, FfmpegError, locateFfmpeg, parseHwaccels, backendsFor, type TranscodeRunner, type RunningProcess, type ProcessResult } from './runner.js';
export { buildFfmpegArgs, formatCommand, planStreams, videoEncoder, qualityArgs, presetArgs, TranscodeBuildError, VAAPI_DEVICE } from './ffmpeg.js';
export { FfmpegProgressParser, parseProgressOutput, progressFromBlock, durationMsOf } from './progress.js';
export { ruleMatches, whenMatches, inWindow } from './match.js';
export { TRANSCODE_WORKER_JOB, TRANSCODE_WORKER_CRON } from './jobs.js';
export * from './schema.js';

// Transcode / remux policies: rules, a persisted job queue and the TranscodeWorker that runs
// ffmpeg one file at a time, replaces the library file, re-runs media analysis, writes a
// `fileTranscoded` history row and sends a `fileTranscoded` notification.

/** FileTranscodedEvent for the notification agents; null when the series/movie is gone. */
export function transcodeNotification(ctx: Pick<AppContext, 'db' | 'log'>, translator: EventTranslator, notice: TranscodedNotice): FileTranscodedEvent | null {
  const { file } = notice;
  const parentId = file.mediaType === 'series' ? file.seriesId : file.movieId;
  if (parentId == null) return null;
  const media = translator.media(file.mediaType, parentId);
  if (!media) return null;
  const eps =
    file.mediaType === 'series'
      ? ctx.db.select().from(episodes).where(eq(episodes.episodeFileId, file.id)).orderBy(episodes.seasonNumber, episodes.episodeNumber).all().map(toEpisodeInfo)
      : [];
  return {
    type: 'fileTranscoded',
    instanceName: 'Arclight',
    timestamp: new Date().toISOString(),
    media,
    ...(eps.length > 0 ? { episodes: eps } : {}),
    file: toFileInfo(file),
    previousPath: notice.previousPath,
    action: notice.rule.action,
    rule: notice.rule.name,
    sizeBefore: notice.sizeBefore,
    sizeAfter: notice.sizeAfter,
  };
}

/** Test seams; production passes none. */
export type TranscodeModuleOptions = Partial<Pick<TranscodeServiceOptions, 'notify' | 'reanalyze' | 'recycleBin' | 'now'>> & {
  runner?: TranscodeRunner;
};

export const transcodeModuleWith =
  (opts: TranscodeModuleOptions = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const log = ctx.log.child({ module: 'transcode' });
    const translator = new EventTranslator({ db: ctx.db, log });
    const notifications = notificationsServiceFor(ctx);
    const service = new TranscodeService({
      db: ctx.db,
      runner: opts.runner ?? new FfmpegRunner(),
      bus: ctx.bus,
      log,
      reanalyze: opts.reanalyze ?? ((id) => void mediaAnalysisFor(ctx).enqueue([id])),
      notify:
        opts.notify ??
        (async (notice) => {
          const event = transcodeNotification(ctx, translator, notice);
          if (event) await notifications.dispatch(event);
        }),
      ...(opts.recycleBin ? { recycleBin: opts.recycleBin } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    service.recoverInterrupted();
    await app.register(transcodeRoutes(service));
    registerTranscodeJobs(ctx.scheduler, service);
    // runAfterImport: check each import; files still without media info wait for analysis,
    // which ends with a `library updated` event for the item.
    const unsubscribe = ctx.bus.subscribe((event) => {
      try {
        if (event.type === 'import' && event.action === 'imported' && event.mediaType && event.mediaId) {
          service.onImported(event.mediaType, event.mediaId);
        } else if (event.type === 'library' && event.action === 'updated') {
          service.onAnalyzed(event.mediaType, event.id);
        }
      } catch (err) {
        log.warn({ err }, 'could not queue transcode after import');
      }
    });
    app.addHook('onClose', async () => {
      unsubscribe();
      service.setKicker(null);
    });
  };

export const transcodeModule: AppModule = transcodeModuleWith();
