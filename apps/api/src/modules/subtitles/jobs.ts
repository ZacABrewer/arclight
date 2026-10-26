import type { Scheduler } from '../../scheduler.js';
import type { SubtitlesService } from './service.js';
import { WHISPER_AUTODETECT_CRON, WHISPER_AUTODETECT_JOB } from './whisper.js';

export const SUBTITLE_JOBS = {
  searchWanted: 'SubtitleSearchWanted',
  upgrade: 'SubtitleUpgrade',
  scan: 'SubtitleScan',
  syncCheck: 'SubtitleSyncCheck',
  whisperAutoDetect: WHISPER_AUTODETECT_JOB,
} as const;

export function registerSubtitleJobs(scheduler: Scheduler, service: SubtitlesService): void {
  // Wanted search every 15 minutes, bounded by settings.search.batchSize; the adaptive gate
  // keeps old items from being searched every run.
  scheduler.register({ name: SUBTITLE_JOBS.searchWanted, cron: '*/15 * * * *', handler: ({ signal }) => service.searchWanted(signal) });
  scheduler.register({
    name: SUBTITLE_JOBS.upgrade,
    cron: '30 3 * * *',
    handler: async ({ signal }) => {
      const r = await service.upgrade(signal);
      return `Upgraded ${r.upgraded} of ${r.candidates} candidate(s)`;
    },
  });
  scheduler.register({ name: SUBTITLE_JOBS.scan, cron: '0 4 * * 0', handler: ({ signal }) => service.scanAll(signal) });
  // Scores subtitles never checked (only while sync.autoCheck is on), applying the auto actions.
  scheduler.register({ name: SUBTITLE_JOBS.syncCheck, cron: '20 * * * *', handler: ({ signal }) => service.syncCheckBatch(signal) });
  scheduler.register({ name: SUBTITLE_JOBS.whisperAutoDetect, cron: WHISPER_AUTODETECT_CRON, handler: () => service.whisperAutoDetect() });
}
