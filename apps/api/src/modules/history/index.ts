import type { AppContext, AppModule } from '../../app.js';
import { registerHistoryJobs } from './jobs.js';
import { historyRoutes } from './routes.js';
import { HistoryService } from './service.js';

export {
  HistoryService,
  HistoryError,
  historyHttpStatus,
  normalizeData,
  normalizeDataKey,
  dataValue,
  parseProtocol,
  isoSeconds,
  type HistoryTarget,
  type HistoryItemRef,
  type GrabbedRelease,
  type GrabMapping,
  type DownloadClientRef,
  type ImportHistoryInput,
  type TrackedDownloadInfo,
  type DownloadFailedEvent,
  type DownloadFailedHandler,
  type RedownloadHandler,
  type FileDeletedInput,
  type FileRenamedInput,
  type IgnoredInput,
  type MarkFailedOptions,
  type WasGrabbedQuery,
  type WasGrabbedOptions,
  type CleanupResult,
  type HistoryServiceOptions,
} from './service.js';
export { HISTORY_CLEANUP_JOB } from './jobs.js';
export * from './schema.js';

// One service per app context so the release, import and queue pipelines share the
// download-failed subscribers registered on it.
const services = new WeakMap<AppContext, HistoryService>();

export function historyServiceFor(ctx: AppContext): HistoryService {
  let service = services.get(ctx);
  if (!service) {
    service = new HistoryService({ db: ctx.db, log: ctx.log.child({ module: 'history' }), bus: ctx.bus });
    services.set(ctx, service);
  }
  return service;
}

export const historyModule: AppModule = (ctx) => async (app) => {
  const service = historyServiceFor(ctx);
  await app.register(historyRoutes(service));
  registerHistoryJobs(ctx.scheduler, service);
  // Parent deletion removes its history (spec 1.4.2).
  const unsubscribe = ctx.bus.subscribe((event) => {
    if (event.type === 'library' && event.action === 'deleted') service.deleteForParent(event.mediaType, event.id);
  });
  app.addHook('onClose', async () => unsubscribe());
};
