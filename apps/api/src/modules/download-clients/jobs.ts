import type { Scheduler } from '../../scheduler.js';
import type { DownloadClientsService } from './service.js';

export const REFRESH_QUEUE_JOB = 'RefreshQueue';
/** Daily: drops download timeline entries older than 30 days. */
export const DOWNLOAD_EVENTS_CLEANUP_JOB = 'DownloadEventsCleanup';

// Runs every minute but returns immediately unless something is active, a refresh was
// requested (grab, client change), or five idle minutes have passed.
export function registerDownloadClientJobs(scheduler: Scheduler, service: DownloadClientsService): void {
  scheduler.register({
    name: REFRESH_QUEUE_JOB,
    cron: '* * * * *',
    handler: async () => {
      if (!service.shouldRefresh()) return 'idle';
      const s = await service.refreshQueue();
      return `${s.items} items from ${s.clients - s.failedClients}/${s.clients} clients; ${s.completed} completed, ${s.failed} failed, ${s.removed} removed`;
    },
  });
  scheduler.register({
    name: DOWNLOAD_EVENTS_CLEANUP_JOB,
    cron: '41 3 * * *',
    handler: async () => {
      const removed = service.pruneTimeline();
      return removed > 0 ? `removed ${removed} download timeline entries` : 'nothing to remove';
    },
  });
}
