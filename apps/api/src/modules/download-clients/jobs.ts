import type { Scheduler } from '../../scheduler.js';
import type { DownloadClientsService } from './service.js';

export const REFRESH_QUEUE_JOB = 'RefreshQueue';

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
}
