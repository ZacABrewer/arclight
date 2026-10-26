import type { AppContext, AppModule } from '../../app.js';
import { migrateRoutes } from './routes.js';
import { MigrateService } from './service.js';

export { MigrateService, MIGRATE_JOB, AREA_ORDER, AREA_LABELS, sourceInstance, type MigrateServiceOptions } from './service.js';
export { MigrateError } from './errors.js';
export { detectSources } from './sources.js';
export * from './schema.js';

// One service per app context: the in-memory run status must be shared between the job and
// the /migrate/status route.
const services = new WeakMap<AppContext, MigrateService>();

export function migrateServiceFor(ctx: AppContext): MigrateService {
  let service = services.get(ctx);
  if (!service) {
    service = new MigrateService({ db: ctx.db, log: ctx.log.child({ module: 'migrate' }), bus: ctx.bus });
    services.set(ctx, service);
  }
  return service;
}

export const migrateModule: AppModule = (ctx) => async (app) => {
  const service = migrateServiceFor(ctx);
  service.registerJob(ctx.scheduler);
  await app.register(migrateRoutes(service));
};
