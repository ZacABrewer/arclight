import type { GuidesSettings } from '@arclight/shared';
import { hourlyCron } from '../../feeds.js';
import type { Scheduler } from '../../scheduler.js';
import type { GuidesService } from './service.js';

export const GUIDES_SYNC_JOB = 'GuidesSync';

/** Cron for the guides sync (minute 17 so it does not pile onto the hour), null when disabled. */
export function guidesCronFor(settings: Pick<GuidesSettings, 'enabled' | 'syncIntervalHours'>): string | null {
  return settings.enabled ? hourlyCron(settings.syncIntervalHours, 17) : null;
}

export function registerGuidesJobs(scheduler: Scheduler, service: GuidesService): void {
  const cron = guidesCronFor(service.settings());
  scheduler.register({
    name: GUIDES_SYNC_JOB,
    ...(cron ? { cron } : {}),
    handler: async ({ signal }) => {
      const r = await service.sync({ signal });
      const applied = r.applied ? `, ${r.applied.applied.length} applied` : '';
      return `${r.changes} change(s)${applied}, ${r.pendingCount} pending (${r.fetch.requests} request(s), ${r.fetch.cached} cached)`;
    },
  });
}

/** Apply changed settings to the running scheduler. */
export function rescheduleGuidesSync(scheduler: Scheduler, settings: Pick<GuidesSettings, 'enabled' | 'syncIntervalHours'>): void {
  if (scheduler.has(GUIDES_SYNC_JOB)) scheduler.update(GUIDES_SYNC_JOB, guidesCronFor(settings));
}
