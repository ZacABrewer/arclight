import type { AppContext, AppModule } from '../../app.js';
import { authServiceFor } from '../auth/index.js';
import { mediaServersServiceFor } from '../media-servers/index.js';
import { requestsServicesFor } from '../requests/index.js';
import { patchUserSettings } from '../requests/users.js';
import { EventIngest } from './ingest.js';
import { registerWatchHistoryJobs } from './jobs.js';
import { PlexLive } from './plex-live.js';
import { plexWebhookRoutes } from './plex-routes.js';
import { WatchQueries } from './queries.js';
import { watchHistoryRoutes } from './routes.js';
import { WatchStore } from './store.js';
import { WatchSync, type AccountsPort } from './sync.js';

export * from './schema.js';
export { WatchStore, LibraryResolver, resolveItem, linkedUsers, normaliseExternalId, type LinkedUser, type ResolvedItem } from './store.js';
export { WatchSync, type AccountsPort } from './sync.js';
export { EventIngest } from './ingest.js';
export { PlexLive } from './plex-live.js';
export { PLEX_WEBHOOK_PATH } from './plex-routes.js';
export { WatchQueries, NOW_PLAYING_WINDOW_MS, type Viewer } from './queries.js';
export { WATCH_SYNC_JOB, USER_SYNC_JOB, WATCH_CLEANUP_JOB, PLEX_POLL_JOB, watchSyncCron } from './jobs.js';

export interface WatchHistory {
  store: WatchStore;
  sync: WatchSync;
  ingest: EventIngest;
  /** Plex webhooks and session polling. */
  plex: PlexLive;
  queries: WatchQueries;
}

/**
 * Linked-user changes go through the requests module (user creation with the default request
 * settings) and the auth module (sessions). Resolved per call: the requests services must be
 * built by the requests module first, with its own options.
 */
export function accountsPortFor(ctx: AppContext): AccountsPort {
  return {
    createLinkedUser: async (account, link) => requestsServicesFor(ctx).accounts.createLinkedUser(account, link),
    patchUserSettings: (userId, patch) => {
      patchUserSettings(ctx.db, userId, patch, new Date().toISOString());
    },
    revokeSessions: (userId) => authServiceFor(ctx).revokeAllSessions(userId),
  };
}

// One instance per app context (routes, jobs, the Jellyfin plugin module and retention share it).
const instances = new WeakMap<AppContext, WatchHistory>();

export function watchHistoryFor(ctx: AppContext): WatchHistory {
  let found = instances.get(ctx);
  if (found) return found;
  const log = ctx.log.child({ module: 'watch-history' });
  const servers = mediaServersServiceFor(ctx);
  const store = new WatchStore(ctx.db);
  const accounts = () => accountsPortFor(ctx);
  found = {
    store,
    sync: new WatchSync({ store, servers, accounts, log }),
    ingest: new EventIngest(store, accounts, log),
    plex: new PlexLive(store, servers, log),
    queries: new WatchQueries(ctx.db, () => servers.stored()),
  };
  instances.set(ctx, found);
  return found;
}

// Watch history from Jellyfin/Emby/Plex: catch-up sync, account sync, the play timeline and its
// read routes. Registered after the requests module (linked-user creation goes through it).
export const watchHistoryModule: AppModule = (ctx) => async (app) => {
  const wh = watchHistoryFor(ctx);
  await app.register(watchHistoryRoutes(ctx, wh, mediaServersServiceFor(ctx)));
  await app.register(plexWebhookRoutes(mediaServersServiceFor(ctx), wh.plex));
  registerWatchHistoryJobs(ctx, wh);
};
