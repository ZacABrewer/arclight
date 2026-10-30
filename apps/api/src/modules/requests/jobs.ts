import type { Scheduler } from '../../scheduler.js';
import type { AudioRequestsService } from './audio-requests.js';
import type { LanguageRequestsService } from './language-requests.js';
import type { RequestsService } from './service.js';
import type { WatchlistService } from './watchlist.js';

export const REQUESTS_STATUS_SYNC_JOB = 'RequestsStatusSync';
export const WATCHLIST_SYNC_JOB = 'WatchlistSync';
export const REQUESTS_DIGEST_JOB = 'RequestsDigest';
export const REQUESTS_POLICY_SWEEP_JOB = 'RequestsPolicySweep';

export function registerRequestsJobs(
  scheduler: Scheduler,
  requests: RequestsService,
  watchlist: WatchlistService,
  audio?: AudioRequestsService,
  languages?: LanguageRequestsService,
): void {
  scheduler.register({
    name: REQUESTS_STATUS_SYNC_JOB,
    cron: '*/5 * * * *',
    handler: async ({ signal }) => {
      const parts = [await requests.syncStatuses(signal)];
      // Music and audiobook requests, and subtitle/language requests, complete in the same pass.
      if (audio) parts.push(await audio.syncStatuses(signal));
      if (languages) parts.push(await languages.syncStatuses(signal));
      return parts.join('; ');
    },
  });
  scheduler.register({
    name: WATCHLIST_SYNC_JOB,
    cron: '*/15 * * * *',
    handler: async ({ signal }) => {
      const r = await watchlist.sync(signal);
      return `${r.users} watchlists synced, ${r.added} items added, ${r.requested} auto-requested`;
    },
  });
  // Hourly tick; sends once a day at settings.digestHour when settings.digestEnabled.
  scheduler.register({
    name: REQUESTS_DIGEST_JOB,
    cron: '0 * * * *',
    handler: () => requests.digestTick(),
  });
  // Approves requests held by approval windows once a window opens (or a hold window closes).
  scheduler.register({
    name: REQUESTS_POLICY_SWEEP_JOB,
    cron: '0 * * * *',
    handler: () => requests.policySweep(),
  });
}
