import type { Scheduler } from '../../scheduler.js';
import type { TagSyncService } from './service.js';

export const TAG_SYNC_JOB = 'MediaServerTagSync';

/** MediaServerTagSync, nightly at 03:50: a full pass that catches anything the change events missed. */
export function registerTagSyncJobs(scheduler: Scheduler, service: TagSyncService): void {
  scheduler.register({
    name: TAG_SYNC_JOB,
    cron: '50 3 * * *',
    handler: async () => {
      const r = await service.runAll();
      if (r.servers === 0) return 'no media server syncs tags';
      const summary = `${r.servers} servers, ${r.changed} items changed`;
      // A failed server shows the job as failed in System > Tasks.
      if (r.errors.length) throw new Error(`${summary}; ${r.errors.slice(0, 3).join('; ')}`);
      return summary;
    },
  });
}
