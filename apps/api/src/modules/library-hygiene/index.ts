import type { AppContext, AppModule } from '../../app.js';
import { finding, healthServiceFor, type HealthCheckDef } from '../health/index.js';
import { getImportsService } from '../imports/index.js';
import { ORPHAN_SCAN_JOB, registerHygieneJobs, runOrphanScan } from './jobs.js';
import { libraryHygieneRoutes } from './routes.js';
import { LibraryHygieneService, type ManualImporter } from './service.js';

export { LibraryHygieneService, HygieneError, titleSimilarity, type ManualImporter } from './service.js';
export { walkRoot, hashPrefix, isFolderEmpty } from './walk.js';
export * from './schema.js';
export { ORPHAN_SCAN_JOB, registerHygieneJobs } from './jobs.js';

// Library hygiene: orphan files, duplicates and empty folders across the root folders.

/** Orphan count from which OrphanFilesFound is raised (HealthStatus has no info level). */
export const ORPHAN_WARNING_THRESHOLD = 25;

const services = new WeakMap<AppContext, LibraryHygieneService>();

export function libraryHygieneFor(ctx: AppContext, importer?: () => ManualImporter): LibraryHygieneService {
  let service = services.get(ctx);
  if (!service) {
    service = new LibraryHygieneService({
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log.child({ module: 'library-hygiene' }),
      // Resolved per call: the imports module may be wired after this one.
      importer: importer ?? (() => getImportsService(ctx)),
    });
    services.set(ctx, service);
  }
  return service;
}

/** OrphanFilesFound: warning once the last scan found `threshold` or more orphans. */
export function orphanFilesCheck(service: Pick<LibraryHygieneService, 'orphanCount'>, threshold = ORPHAN_WARNING_THRESHOLD): HealthCheckDef {
  return {
    id: 'OrphanFilesFound',
    run: async () => {
      const n = service.orphanCount();
      if (n < threshold) return [];
      return [
        finding(
          'OrphanFilesFound',
          'warning',
          `${n} video files in your root folders are not in the library. Review them under Library → Hygiene.`,
          'orphan-files-found',
        ),
      ];
    },
  };
}

export interface LibraryHygieneModuleOptions {
  importer?: () => ManualImporter;
  orphanWarningThreshold?: number;
}

export const libraryHygieneModuleWith =
  (opts: LibraryHygieneModuleOptions = {}): AppModule =>
  (ctx) =>
  async (app) => {
    const service = libraryHygieneFor(ctx, opts.importer);
    await app.register(
      libraryHygieneRoutes(service, {
        // Same key as the registered job, so a manual scan and the weekly one never overlap.
        startScan: () => ctx.scheduler.runTask(ORPHAN_SCAN_JOB, 'manual', runOrphanScan(service), { key: ORPHAN_SCAN_JOB }).job,
      }),
    );
    registerHygieneJobs(ctx.scheduler, service);
    const unregister = healthServiceFor(ctx).register(orphanFilesCheck(service, opts.orphanWarningThreshold));
    app.addHook('onClose', async () => unregister());
  };

export const libraryHygieneModule: AppModule = libraryHygieneModuleWith();
