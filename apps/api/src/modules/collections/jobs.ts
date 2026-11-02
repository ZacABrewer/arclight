import type { CollectionSyncResult } from '@arclight/shared';
import type { Scheduler } from '../../scheduler.js';
import type { CollectionsService } from './service.js';

export const COLLECTIONS_SYNC_JOB = 'CollectionsSync';

export function summarise(r: CollectionSyncResult): string {
  if (r.servers === 0) return 'no Jellyfin/Emby server to sync to';
  const parts = [`${r.collections} collections on ${r.servers} servers`, `+${r.added} -${r.removed} items`];
  if (r.created) parts.push(`${r.created} created`);
  if (r.deleted) parts.push(`${r.deleted} deleted`);
  if (r.errors.length) parts.push(`${r.errors.length} errors: ${r.errors.slice(0, 3).join('; ')}`);
  return parts.join(', ');
}

/** CollectionsSync, hourly: Leaving Soon and the smart collections onto the media servers. */
export function registerCollectionsJobs(scheduler: Scheduler, service: CollectionsService): () => Promise<CollectionSyncResult> {
  let running: Promise<CollectionSyncResult> | null = null;
  const run = () => {
    running ??= service.sync().finally(() => {
      running = null;
    });
    return running;
  };
  scheduler.register({
    name: COLLECTIONS_SYNC_JOB,
    cron: '20 * * * *',
    handler: async () => {
      const r = await run();
      // A failed server or rule shows the job as failed in System > Tasks.
      if (r.errors.length) throw new Error(summarise(r));
      return summarise(r);
    },
  });
  return run;
}
