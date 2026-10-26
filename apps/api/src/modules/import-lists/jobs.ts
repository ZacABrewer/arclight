import type { Scheduler } from '../../scheduler.js';
import type { ImportListsService } from './service.js';

export const IMPORT_LIST_SYNC_JOB = 'ImportListSync';

/**
 * Hourly tick; each run only fetches lists whose last sync is older than the
 * `importLists.syncIntervalHours` setting (6 h by default), so changing the interval needs no
 * restart. POST /importlist/sync forces every enabled list.
 */
export function registerImportListJobs(scheduler: Scheduler, service: ImportListsService, cron = '0 * * * *'): void {
  scheduler.register({
    name: IMPORT_LIST_SYNC_JOB,
    cron,
    handler: async ({ signal }) => {
      const r = await service.sync({ signal });
      if (r.lists === 0) return 'no lists due';
      const parts = [`${r.lists} lists`, `${r.fetched} items`, `${r.added} added`];
      if (r.failed) parts.push(`${r.failed} failed`);
      if (r.cleaned) parts.push(`${r.cleaned} cleaned`);
      if (r.errors.length) parts.push(`${r.errors.length} list errors`);
      return parts.join(', ');
    },
  });
}
