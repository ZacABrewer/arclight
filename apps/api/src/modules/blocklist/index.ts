import type { AppContext, AppModule } from '../../app.js';
import { historyServiceFor } from '../history/index.js';
import { blocklistRoutes } from './routes.js';
import { BlocklistService } from './service.js';

export {
  BlocklistService,
  BlocklistError,
  blocklistHttpStatus,
  matchesBlocklistEntry,
  PUBLISH_DATE_TOLERANCE_MS,
  SIZE_TOLERANCE_BYTES,
  type BlocklistScope,
  type BlocklistCandidate,
  type TrackedBlocklistItem,
  type PendingBlocklistRelease,
  type BlocklistServiceOptions,
} from './service.js';
export * from './schema.js';

export const BLOCKLIST_CLEANUP_JOB = 'BlocklistCleanup';

// One service per app context. Creating it also subscribes it to the history service's
// download-failed pipeline, so every failed download is blocklisted (spec 2.2.1) no matter
// which module triggers the failure.
const services = new WeakMap<AppContext, BlocklistService>();

export function blocklistServiceFor(ctx: AppContext): BlocklistService {
  let service = services.get(ctx);
  if (!service) {
    const created = new BlocklistService({ db: ctx.db, log: ctx.log.child({ module: 'blocklist' }) });
    historyServiceFor(ctx).onDownloadFailed((event) => {
      created.addFromFailed(event);
    });
    services.set(ctx, created);
    service = created;
  }
  return service;
}

export const blocklistModule: AppModule = (ctx) => async (app) => {
  const service = blocklistServiceFor(ctx);
  await app.register(blocklistRoutes(service));
  ctx.scheduler.register({
    name: BLOCKLIST_CLEANUP_JOB,
    cron: '45 3 * * *',
    handler: async () => `removed ${service.cleanup()} orphaned blocklist entries`,
  });
  const unsubscribe = ctx.bus.subscribe((event) => {
    if (event.type === 'library' && event.action === 'deleted') service.deleteForParent(event.mediaType, event.id);
  });
  app.addHook('onClose', async () => unsubscribe());
};
