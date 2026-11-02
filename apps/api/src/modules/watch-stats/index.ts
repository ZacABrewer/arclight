import type { AppContext, AppModule } from '../../app.js';
import { jellyfinPluginServiceFor } from '../jellyfin-plugin/index.js';
import { getSection } from '../settings/service.js';
import { watchHistoryFor } from '../watch-history/index.js';
import { registerWatchStatsJobs } from './jobs.js';
import { Newsletter } from './newsletter.js';
import { watchStatsRoutes } from './routes.js';
import { WatchStatsService } from './service.js';
import { WrappedShares } from './shares.js';

export * from './schema.js';
export { WatchStatsService, WatchStatsError } from './service.js';
export { buildPlays, type Play, type TimelineRow } from './plays.js';
export { Newsletter } from './newsletter.js';
export { WrappedShares } from './shares.js';
export { NEWSLETTER_JOB, newsletterDue } from './jobs.js';

// Playback stats (Tautulli-style) over the watch history, Year in review with share links, the
// weekly newsletter, and the /jellyfin/stats* and /jellyfin/wrapped* routes of the plugin.

export interface WatchStats {
  service: WatchStatsService;
  shares: WrappedShares;
  newsletter: Newsletter;
}

const instances = new WeakMap<AppContext, WatchStats>();

export function watchStatsFor(ctx: AppContext): WatchStats {
  let found = instances.get(ctx);
  if (found) return found;
  const now = () => new Date();
  found = {
    service: new WatchStatsService({ db: ctx.db, owners: () => watchHistoryFor(ctx).queries.owners(), now }),
    shares: new WrappedShares(ctx.db, now, () => getSection(ctx.db, 'requests').applicationUrl),
    newsletter: new Newsletter({ db: ctx.db, now }),
  };
  instances.set(ctx, found);
  return found;
}

export const watchStatsModule: AppModule = (ctx) => async (app) => {
  const ws = watchStatsFor(ctx);
  await app.register(
    watchStatsRoutes({
      db: ctx.db,
      ...ws,
      pluginUser: (header) => jellyfinPluginServiceFor(ctx).resolveUser(header),
      leavingSoonVisible: () => {
        const s = getSection(ctx.db, 'collections').leavingSoon;
        return s.showInJellyfin;
      },
    }),
  );
  registerWatchStatsJobs(ctx.scheduler, { db: ctx.db, newsletter: ws.newsletter, shares: ws.shares, now: () => new Date() });
};
