import type { Scheduler } from '../../scheduler.js';
import type { ReleasesService } from './service.js';

export const PROCESS_PENDING_RELEASES_JOB = 'ProcessPendingReleases';
export const MISSING_EPISODE_SEARCH_JOB = 'MissingEpisodeSearch';
export const MISSING_MOVIE_SEARCH_JOB = 'MissingMovieSearch';
export const CUTOFF_UNMET_SEARCH_JOB = 'CutoffUnmetSearch';
/** Music: monitored, released albums without (all) their track files. No-op while music is off. */
export const MISSING_ALBUM_SEARCH_JOB = 'MissingAlbumSearch';
/** Music: albums whose lowest track quality is below the artist's profile cutoff. No-op while music is off. */
export const CUTOFF_UNMET_AUDIO_SEARCH_JOB = 'CutoffUnmetAudioSearch';
/** Audiobooks: monitored, released books without a file. No-op while audiobooks are off. */
export const MISSING_BOOK_SEARCH_JOB = 'MissingBookSearch';
export const DECISION_LOG_CLEANUP_JOB = 'DecisionLogCleanup';
const DEFAULT_DECISION_LOG_DAYS = 14;

/** Default schedules of the scheduled searches (the search status estimates fall back to them). */
export const SEARCH_JOB_CRONS = {
  [MISSING_EPISODE_SEARCH_JOB]: '0 3 * * *',
  [MISSING_MOVIE_SEARCH_JOB]: '20 3 * * *',
  [CUTOFF_UNMET_SEARCH_JOB]: '40 3 * * *',
  [MISSING_ALBUM_SEARCH_JOB]: '10 4 * * *',
  [CUTOFF_UNMET_AUDIO_SEARCH_JOB]: '30 4 * * *',
  [MISSING_BOOK_SEARCH_JOB]: '20 4 * * *',
} as const;

export function registerReleaseJobs(
  scheduler: Scheduler,
  service: ReleasesService,
  opts: { decisionLogDays?: () => number } = {},
): void {
  scheduler.register({ name: PROCESS_PENDING_RELEASES_JOB, cron: '* * * * *', handler: async () => service.processPending() });
  scheduler.register({
    name: MISSING_EPISODE_SEARCH_JOB,
    cron: SEARCH_JOB_CRONS[MISSING_EPISODE_SEARCH_JOB],
    handler: async ({ signal }) => service.missingEpisodeSearch(signal),
  });
  scheduler.register({
    name: MISSING_MOVIE_SEARCH_JOB,
    cron: SEARCH_JOB_CRONS[MISSING_MOVIE_SEARCH_JOB],
    handler: async ({ signal }) => service.missingMovieSearch(signal),
  });
  scheduler.register({
    name: CUTOFF_UNMET_SEARCH_JOB,
    cron: SEARCH_JOB_CRONS[CUTOFF_UNMET_SEARCH_JOB],
    handler: async ({ signal }) => service.cutoffUnmetSearch(signal),
  });
  scheduler.register({
    name: MISSING_ALBUM_SEARCH_JOB,
    cron: SEARCH_JOB_CRONS[MISSING_ALBUM_SEARCH_JOB],
    handler: async ({ signal }) => service.missingAlbumSearch(signal),
  });
  scheduler.register({
    name: MISSING_BOOK_SEARCH_JOB,
    cron: SEARCH_JOB_CRONS[MISSING_BOOK_SEARCH_JOB],
    handler: async ({ signal }) => service.missingBookSearch(signal),
  });
  scheduler.register({
    name: CUTOFF_UNMET_AUDIO_SEARCH_JOB,
    cron: SEARCH_JOB_CRONS[CUTOFF_UNMET_AUDIO_SEARCH_JOB],
    handler: async ({ signal }) => service.cutoffUnmetAudioSearch(signal),
  });
  scheduler.register({
    name: DECISION_LOG_CLEANUP_JOB,
    cron: '50 4 * * *',
    handler: async () => service.cleanupDecisionLog(opts.decisionLogDays?.() ?? DEFAULT_DECISION_LOG_DAYS),
  });
  // Search status estimates read the live schedule (rescheduled, on demand only, or switched off).
  service.setJobSchedules((name) => scheduler.jobSchedule(name));
}
