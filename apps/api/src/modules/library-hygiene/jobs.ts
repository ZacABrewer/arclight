import type { Scheduler } from '../../scheduler.js';
import type { LibraryHygieneService } from './service.js';

export const ORPHAN_SCAN_JOB = 'OrphanScan';

export function runOrphanScan(service: LibraryHygieneService) {
  return async ({ signal }: { signal: AbortSignal }) => {
    const s = await service.scan({ signal });
    const skipped = s.skippedRootFolders.length ? ` (${s.skippedRootFolders.length} root folders unavailable)` : '';
    return `${s.filesScanned} files in ${s.rootFolders} root folders: ${s.orphans} orphans, ${s.duplicates} duplicates, ${s.emptyFolders} empty folders${skipped}`;
  };
}

/** OrphanScan: weekly (Monday 02:00) and on demand through POST /library/hygiene/scan. */
export function registerHygieneJobs(scheduler: Scheduler, service: LibraryHygieneService): void {
  scheduler.register({ name: ORPHAN_SCAN_JOB, cron: '0 2 * * 1', handler: runOrphanScan(service) });
}
