import type { AppContext, AppModule } from '../../app.js';
import { registerDownloadClientJobs } from './jobs.js';
import { downloadClientsRoutes } from './routes.js';
import { DownloadClientsService } from './service.js';

export {
  DownloadClientsService,
  DownloadClientsError,
  STATUS_TEXT,
  type BlocklistHook,
  type GrabRequest,
  type PickedClient,
  type RefreshSummary,
  type TrackedDownload,
  type TrackedDownloadHook,
  type TrackingInfo,
} from './service.js';
export { REFRESH_QUEUE_JOB } from './jobs.js';
export * from './schema.js';

// One service per app context, so the pipeline module can reach the same instance (and its
// hooks) regardless of registration order.
const services = new WeakMap<AppContext, DownloadClientsService>();

export function getDownloadClientsService(ctx: AppContext): DownloadClientsService {
  let service = services.get(ctx);
  if (!service) {
    service = new DownloadClientsService({ db: ctx.db, log: ctx.log.child({ module: 'download-clients' }) });
    services.set(ctx, service);
  }
  return service;
}

export const downloadClientsModule: AppModule = (ctx) => async (app) => {
  const service = getDownloadClientsService(ctx);
  await app.register(downloadClientsRoutes(service));
  registerDownloadClientJobs(ctx.scheduler, service);
};
