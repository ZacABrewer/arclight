import type { Scheduler } from '../../scheduler.js';
import type { TorrentService } from './service.js';

/** Every five minutes: pause or remove finished torrents that reached their seeding rule. */
export const APPLY_SEEDING_RULES_JOB = 'ApplySeedingRules';

export function registerTorrentJobs(scheduler: Scheduler, service: TorrentService): void {
  scheduler.register({
    name: APPLY_SEEDING_RULES_JOB,
    cron: '*/5 * * * *',
    handler: async () => {
      const r = await service.applySeedingRules();
      if (!r) return 'engine not running';
      if (r.checked === 0) return 'no finished torrents';
      return `${r.checked} finished torrents: ${r.paused.length} paused, ${r.removed.length} removed, ${r.held.length} held back`;
    },
  });
}
