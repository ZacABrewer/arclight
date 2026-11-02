import type { Scheduler } from '../../scheduler.js';
import type { Db } from '../../db/index.js';
import { getSection } from '../settings/service.js';
import type { Newsletter } from './newsletter.js';
import type { WrappedShares } from './shares.js';

export const NEWSLETTER_JOB = 'WatchStatsNewsletter';

const SIX_DAYS_MS = 6 * 24 * 60 * 60_000;

/** True when the weekly newsletter is due at `now` (its weekday and hour, not sent this week). */
export function newsletterDue(now: Date, s: { enabled: boolean; weekday: number; hour: number }, lastSentAt: string | null): boolean {
  if (!s.enabled || now.getDay() !== s.weekday || now.getHours() !== s.hour) return false;
  return lastSentAt === null || now.getTime() - Date.parse(lastSentAt) >= SIX_DAYS_MS;
}

/**
 * WatchStatsNewsletter, hourly: sends the newsletter in its configured hour (server local time)
 * and prunes expired Wrapped share links.
 */
export function registerWatchStatsJobs(scheduler: Scheduler, deps: { db: Db; newsletter: Newsletter; shares: WrappedShares; now: () => Date }): void {
  scheduler.register({
    name: NEWSLETTER_JOB,
    cron: '5 * * * *',
    handler: async () => {
      const pruned = deps.shares.prune();
      const settings = getSection(deps.db, 'watchStats').newsletter;
      const parts = pruned ? [`pruned ${pruned} expired share links`] : [];
      if (newsletterDue(deps.now(), settings, deps.newsletter.lastScheduled())) {
        const run = await deps.newsletter.send(settings, 'scheduled');
        parts.push(`newsletter sent to ${run.recipients} recipients (${run.items} titles)`);
      }
      return parts.join('; ') || 'nothing due';
    },
  });
}
