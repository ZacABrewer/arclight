import type { Scheduler } from '../../scheduler.js';
import type { ImportsService } from './service.js';

export const IMPORT_JOBS = {
  recycleBinCleanup: 'RecycleBinCleanup',
  rescanAllSeries: 'RescanAllSeries',
  rescanAllMovies: 'RescanAllMovies',
  processPendingImports: 'ProcessPendingImports',
} as const;

export function registerImportJobs(scheduler: Scheduler, service: ImportsService): void {
  scheduler.register({
    name: IMPORT_JOBS.recycleBinCleanup,
    cron: '30 3 * * *',
    handler: async () => {
      const r = await service.cleanupRecycleBin();
      return `${r.deletedFiles} files and ${r.deletedFolders} folders removed from the recycle bin`;
    },
  });
  scheduler.register({
    name: IMPORT_JOBS.rescanAllSeries,
    cron: '0 4 * * 0',
    handler: async () => {
      const r = await service.rescanAll('series');
      return `${r.scanned} files scanned; ${r.added.length} added, ${r.removed.length} removed, ${r.unmapped.length} unmapped`;
    },
  });
  scheduler.register({
    name: IMPORT_JOBS.rescanAllMovies,
    cron: '0 5 * * 0',
    handler: async () => {
      const r = await service.rescanAll('movie');
      return `${r.scanned} files scanned; ${r.added.length} added, ${r.removed.length} removed, ${r.unmapped.length} unmapped`;
    },
  });
  // Downloads whose last attempt failed only on temporary rejections (unpacking, sample undetermined).
  scheduler.register({
    name: IMPORT_JOBS.processPendingImports,
    cron: '*/2 * * * *',
    handler: async () => {
      const n = await service.retryPendingImports();
      return n === 0 ? 'idle' : `${n} pending imports retried`;
    },
  });
}
