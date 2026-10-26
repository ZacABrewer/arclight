import type { AppContext, AppModule } from '../../app.js';
import { VERSION } from '../../version.js';
import { requireAdmin } from '../auth/hook.js';
import { requestRestart } from '../system/index.js';
import { registerBackupJobs } from './jobs.js';
import { backupRoutes } from './routes.js';
import { BackupService } from './service.js';

export { BackupService, BackupError, selectForPruning, backupFileName, parseBackupFileName } from './service.js';
export { BACKUP_JOB } from './jobs.js';
export { writeZip, ZipReader, ZipError } from './zip.js';

const services = new WeakMap<AppContext, BackupService>();

/** One service per context; other modules (e.g. a future updater) create `update` backups through it. */
export function backupServiceFor(ctx: AppContext): BackupService {
  let service = services.get(ctx);
  if (!service) {
    service = new BackupService({
      db: ctx.db,
      config: ctx.config,
      log: ctx.log.child({ module: 'backup' }),
      version: VERSION,
      onRestored: (reason) => requestRestart(ctx, reason),
    });
    services.set(ctx, service);
  }
  return service;
}

/** Zip backups of the database, settings and config files; scheduled, manual and restore. */
export const backupModule: AppModule = (ctx) => async (app) => {
  const service = backupServiceFor(ctx);
  await app.register(backupRoutes(service, { guard: requireAdmin, uploadDir: ctx.config.configDir }));
  registerBackupJobs(ctx.scheduler, service);
};
