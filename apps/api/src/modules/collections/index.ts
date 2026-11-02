import { isMediaBrowserKind, type MediaServerConfig } from '@arclight/shared';
import { MediaBrowserServerClient } from '@arclight/media-servers';
import type { AppContext, AppModule } from '../../app.js';
import { jellyfinPluginServiceFor } from '../jellyfin-plugin/index.js';
import { mediaServersServiceFor } from '../media-servers/index.js';
import { requestsServicesFor } from '../requests/index.js';
import { registerCollectionsJobs } from './jobs.js';
import { collectionsRoutes } from './routes.js';
import { CollectionsService, type ListSource } from './service.js';

export * from './schema.js';
export { CollectionsService, CollectionsError, LEAVING_SOON_KEY, type ListSource } from './service.js';
export { COLLECTIONS_SYNC_JOB } from './jobs.js';

// Leaving Soon and rule-based smart collections, kept in sync as collections on Jellyfin/Emby
// through their REST API (no plugin needed), plus the plugin's /jellyfin/leaving-soon row.

/** Pages of a TMDB list a smart collection looks at (20 titles each). */
const LIST_PAGES = 5;

const instances = new WeakMap<AppContext, CollectionsService>();

export function collectionsServiceFor(ctx: AppContext): CollectionsService {
  let found = instances.get(ctx);
  if (found) return found;
  const media = mediaServersServiceFor(ctx);
  const lists: ListSource = async (list, kind) => {
    const discover = requestsServicesFor(ctx).discover;
    const ids: number[] = [];
    for (let page = 1; page <= LIST_PAGES; page++) {
      const res =
        list === 'trending'
          ? await discover.trending({ mediaType: kind, timeWindow: 'week', page })
          : await discover.list(list === 'popular' ? (kind === 'movie' ? 'popularMovies' : 'popularTv') : kind === 'movie' ? 'topRatedMovies' : 'topRatedTv', { page });
      ids.push(...res.results.filter((r) => r.mediaType === (kind === 'movie' ? 'movie' : 'series')).map((r) => r.tmdbId));
      if (page >= res.totalPages) break;
    }
    return ids;
  };
  found = new CollectionsService({
    db: ctx.db,
    servers: () => media.stored(),
    client: (config: MediaServerConfig) => {
      if (!isMediaBrowserKind(config.kind)) throw new Error(`${config.name} is not a Jellyfin or Emby server`);
      const client = media.clientFor(config);
      if (!(client instanceof MediaBrowserServerClient)) throw new Error(`${config.name} does not support collections`);
      return client;
    },
    lists,
  });
  instances.set(ctx, found);
  return found;
}

export const collectionsModule: AppModule = (ctx) => async (app) => {
  const service = collectionsServiceFor(ctx);
  const syncNow = registerCollectionsJobs(ctx.scheduler, service);
  await app.register(
    collectionsRoutes({
      db: ctx.db,
      service,
      syncNow,
      pluginUser: (header) => jellyfinPluginServiceFor(ctx).resolveUser(header),
    }),
  );
};
