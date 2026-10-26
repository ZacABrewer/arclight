import type { Scheduler } from '../../scheduler.js';
import type { RequestsService } from './service.js';
import type { WatchlistService } from './watchlist.js';

export const REQUESTS_STATUS_SYNC_JOB = 'RequestsStatusSync';
export const WATCHLIST_SYNC_JOB = 'WatchlistSync';

export function registerRequestsJobs(scheduler: Scheduler, requests: RequestsService, watchlist: WatchlistService): void {
  scheduler.register({
    name: REQUESTS_STATUS_SYNC_JOB,
    cron: '*/5 * * * *',
    handler: ({ signal }) => requests.syncStatuses(signal),
  });
  scheduler.register({
    name: WATCHLIST_SYNC_JOB,
    cron: '*/15 * * * *',
    handler: async ({ signal }) => {
      const r = await watchlist.sync(signal);
      return `${r.users} watchlists synced, ${r.added} items added, ${r.requested} auto-requested`;
    },
  });
}
