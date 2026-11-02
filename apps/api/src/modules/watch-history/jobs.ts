import type { AppContext } from '../../app.js';
import { getSection } from '../settings/service.js';
import type { WatchHistory } from './index.js';

export const WATCH_SYNC_JOB = 'MediaServerWatchSync';
export const USER_SYNC_JOB = 'MediaServerUserSync';
export const WATCH_CLEANUP_JOB = 'WatchHistoryCleanup';
/** Hourly, at minute 5 (clear of the top-of-the-hour jobs). */
export const USER_SYNC_CRON = '5 * * * *';
/** Daily at 04:45. */
export const WATCH_CLEANUP_CRON = '45 4 * * *';

/** Cron for "every `minutes` minutes" (whole hours past 59). */
export function watchSyncCron(minutes: number): string {
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.min(24, Math.max(1, Math.round(minutes / 60)));
  return hours >= 24 ? '0 0 * * *' : `0 */${hours} * * *`;
}

export function registerWatchHistoryJobs(ctx: AppContext, wh: WatchHistory): void {
  ctx.scheduler.register({
    name: WATCH_SYNC_JOB,
    cron: watchSyncCron(getSection(ctx.db, 'watchHistory').syncIntervalMinutes),
    handler: async ({ signal }) => summarise(await wh.sync.syncWatch({ signal })),
  });
  ctx.scheduler.register({
    name: USER_SYNC_JOB,
    cron: USER_SYNC_CRON,
    handler: async () => {
      const r = await wh.sync.syncUsers();
      if (r.servers.length === 0) return 'no Jellyfin/Emby server';
      return r.servers
        .map((s) => (s.status === 'failed' ? `${s.name}: failed (${s.message ?? ''})` : `${s.name}: ${s.added} new, ${s.renamed} renamed, ${s.disabled} disabled, ${s.deleted} gone, ${s.created} user(s) created`))
        .join('; ');
    },
  });
  ctx.scheduler.register({
    name: WATCH_CLEANUP_JOB,
    cron: WATCH_CLEANUP_CRON,
    handler: async () => `${wh.queries.pruneEvents(getSection(ctx.db, 'watchHistory').eventRetentionDays)} old watch event(s) removed`,
  });
}

export function summarise(r: { servers: Array<{ name: string; status: string; users: number; changed: number; events: number; message?: string | undefined }> }): string {
  if (r.servers.length === 0) return 'no server has watch-history sync on';
  const failed = r.servers.filter((s) => s.status === 'failed');
  const text = r.servers
    .map((s) => (s.status === 'failed' ? `${s.name}: failed (${s.message ?? ''})` : `${s.name}: ${s.users} user(s), ${s.changed} change(s), ${s.events} play(s)`))
    .join('; ');
  // A failed server fails the job so it shows red in System > Tasks; the others were still synced.
  if (failed.length > 0) throw new Error(text);
  return text;
}
