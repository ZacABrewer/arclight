import type { MediaServerConfig } from '@arclight/shared';
import { MediaBrowserServerClient, PlexServerClient } from '@arclight/media-servers';
import type { AppContext, AppModule } from '../../app.js';
import { mediaServersServiceFor } from '../media-servers/index.js';
import { registerTagSyncJobs } from './jobs.js';
import { tagSyncRoutes } from './routes.js';
import { isTagSyncKind, TagSyncError, TagSyncService, type TagSyncTarget } from './service.js';

export * from './schema.js';
export { TagSyncService, TagSyncError, TokenBucket, wantedLabels, tagSyncSettings, isTagSyncKind, type TagSyncTarget, type EntityKey } from './service.js';
export { TAG_SYNC_JOB } from './jobs.js';

// Arclight's tags onto the matching movies and series of Jellyfin/Emby (item Tags) and Plex
// (labels, best-effort), owning only what it wrote.

/** The tag reads and writes of a stored server's client. */
export function tagSyncTargetFor(ctx: AppContext, config: MediaServerConfig): TagSyncTarget {
  if (!isTagSyncKind(config.kind)) throw new TagSyncError('VALIDATION', `${config.name} does not support tags`);
  const client = mediaServersServiceFor(ctx).clientFor(config);
  if (client instanceof MediaBrowserServerClient) {
    return {
      listItems: (kind) => client.listItems(kind),
      readTags: (ids) => client.itemTags(ids),
      writeTags: async (item, add, remove, opts) => {
        const { lockAdded } = await client.updateItemTags(item.id, add, remove, opts);
        return { lockAdded };
      },
      requestsPerWrite: 2,
    };
  }
  if (client instanceof PlexServerClient) {
    return {
      listItems: (kind) => client.listItems(kind),
      readTags: (ids) => client.itemLabels(ids),
      writeTags: async (item, add, remove, opts) => {
        if (!item.libraryId) throw new Error(`no library section for Plex item ${item.id}`);
        await client.setItemLabels(item.libraryId, item.id, item.mediaType, add, remove, opts);
      },
      requestsPerWrite: 2,
    };
  }
  throw new TagSyncError('VALIDATION', `${config.name} does not support tags`);
}

const instances = new WeakMap<AppContext, TagSyncService>();

export function tagSyncServiceFor(ctx: AppContext): TagSyncService {
  let found = instances.get(ctx);
  if (found) return found;
  const media = mediaServersServiceFor(ctx);
  found = new TagSyncService({
    db: ctx.db,
    servers: () => media.stored(),
    target: (config) => tagSyncTargetFor(ctx, config),
    log: ctx.log.child({ module: 'tag-sync' }),
  });
  instances.set(ctx, found);
  return found;
}

export const tagSyncModule: AppModule = (ctx) => async (app) => {
  const service = tagSyncServiceFor(ctx);
  registerTagSyncJobs(ctx.scheduler, service);
  // Manual edits and tag rules publish library updates; a renamed or deleted tag publishes a
  // tags settings event, which can touch every title. Saving a media server's settings gives
  // each server with sync on a full pass.
  const unsubscribe = ctx.bus.subscribe((event) => {
    if (event.type === 'library' && (event.action === 'added' || event.action === 'updated' || event.action === 'deleted')) {
      service.markDirty({ type: event.mediaType, id: event.id });
    } else if (event.type === 'settings' && event.section === 'tags') {
      service.markDirty('all');
    } else if (event.type === 'settings' && event.section === 'mediaServers') {
      service.markSyncingServersDirty();
    }
  });
  app.addHook('onClose', async () => {
    unsubscribe();
    service.dispose();
  });
  await app.register(tagSyncRoutes(service));
};
