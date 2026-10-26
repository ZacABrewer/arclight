import type { Scheduler } from '../../scheduler.js';
import type { ReleasesService } from './service.js';

export const PROCESS_PENDING_RELEASES_JOB = 'ProcessPendingReleases';
export const MISSING_EPISODE_SEARCH_JOB = 'MissingEpisodeSearch';
export const MISSING_MOVIE_SEARCH_JOB = 'MissingMovieSearch';
export const CUTOFF_UNMET_SEARCH_JOB = 'CutoffUnmetSearch';

export function registerReleaseJobs(scheduler: Scheduler, service: ReleasesService): void {
  scheduler.register({ name: PROCESS_PENDING_RELEASES_JOB, cron: '* * * * *', handler: async () => service.processPending() });
  scheduler.register({ name: MISSING_EPISODE_SEARCH_JOB, cron: '0 3 * * *', handler: async ({ signal }) => service.missingEpisodeSearch(signal) });
  scheduler.register({ name: MISSING_MOVIE_SEARCH_JOB, cron: '20 3 * * *', handler: async ({ signal }) => service.missingMovieSearch(signal) });
  scheduler.register({ name: CUTOFF_UNMET_SEARCH_JOB, cron: '40 3 * * *', handler: async ({ signal }) => service.cutoffUnmetSearch(signal) });
}
