import type { AppContext, AppModule } from '../../app.js';
import { registerDownloadClientJobs } from './jobs.js';
import { downloadClientsRoutes } from './routes.js';
import { DownloadClientsService, type DownloadClientsServiceOptions } from './service.js';

export {
  DownloadClientsService,
  DownloadClientsError,
  STATUS_TEXT,
  type ActiveDownloadInfo,
  type BlocklistHook,
  type DownloadClientsServiceOptions,
  type EngineInsights,
  type EngineLive,
  type GrabRequest,
  type PickedClient,
  type RefreshSummary,
  type TrackedDownload,
  type TrackedDownloadHook,
  type TrackingInfo,
} from './service.js';
export { DOWNLOAD_EVENTS_CLEANUP_JOB, REFRESH_QUEUE_JOB } from './jobs.js';
export { deriveState, type StateInput, type StateReason } from './state-reason.js';
export { DownloadTimelineStore, DEFAULT_EVENT_RETENTION_DAYS } from './timeline.js';
export * from './schema.js';

// One service per app context, so the pipeline module can reach the same instance (and its
// hooks) regardless of registration order.
const services = new WeakMap<AppContext, DownloadClientsService>();

/**
 * `overrides` apply only when this call creates the instance (tests inject a fake client
 * factory before the app's modules are registered); later calls return the existing one.
 */
export function getDownloadClientsService(
  ctx: AppContext,
  overrides: Partial<Omit<DownloadClientsServiceOptions, 'db'>> = {},
): DownloadClientsService {
  let service = services.get(ctx);
  if (!service) {
    service = new DownloadClientsService({
      db: ctx.db,
      log: ctx.log.child({ module: 'download-clients' }),
      bus: ctx.bus,
      ...overrides,
    });
    services.set(ctx, service);
  }
  return service;
}

export const downloadClientsModule: AppModule = (ctx) => async (app) => {
  const service = getDownloadClientsService(ctx);
  await app.register(downloadClientsRoutes(service));
  registerDownloadClientJobs(ctx.scheduler, service);
};
