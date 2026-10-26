import type { AppContext, AppModule } from '../../app.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import type { ImportsDeps } from './deps.js';
import { registerImportJobs } from './jobs.js';
import { importsRoutes } from './routes.js';
import { ImportsService } from './service.js';

export { ImportsService, ImportsError, type ImportRunResult, type ImportOutcome, type DownloadClientsPort } from './service.js';
export { IMPORT_JOBS } from './jobs.js';
export type * from './deps.js';
export { createFfprobeProbe, ffprobeAvailable, noProbe } from './scan.js';
export { deleteEmptyFolders, RecycleBin } from './mover.js';
export * from './schema.js';

// One service per app context so other modules (and app.ts) can reach the same instance.
const services = new WeakMap<AppContext, ImportsService>();

export function getImportsService(ctx: AppContext, deps: ImportsDeps = {}): ImportsService {
  let service = services.get(ctx);
  if (!service) {
    service = new ImportsService({
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'imports' }),
      downloadClients: getDownloadClientsService(ctx),
      deps,
    });
    services.set(ctx, service);
  } else if (Object.keys(deps).length > 0) {
    service.setDeps(deps);
  }
  return service;
}

/** Variant for app.ts: wires history/notifications/blocklist/releases hooks and an optional probe. */
export const importsModuleWith =
  (deps: ImportsDeps): AppModule =>
  (ctx) =>
  async (app) => {
    const service = getImportsService(ctx, deps);
    const downloads = getDownloadClientsService(ctx);
    downloads.onItemCompleted(async (item) => {
      await service.importCompletedDownload(item);
    });
    downloads.onItemFailed((item) => service.handleFailedDownload(item));
    await app.register(importsRoutes(service));
    registerImportJobs(ctx.scheduler, service);
  };

export const importsModule: AppModule = importsModuleWith({});
