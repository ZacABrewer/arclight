import type { Scheduler } from '../../scheduler.js';
import type { BackupService } from './service.js';

export const BACKUP_JOB = 'Backup';

/**
 * Hourly tick; a run only creates a backup when the `backup` settings say one is due (by
 * default daily at 04:00 local time), so schedule changes need no restart. Retention is
 * applied after every automatic backup.
 */
export function registerBackupJobs(scheduler: Scheduler, service: BackupService, cron = '0 * * * *'): void {
  scheduler.register({
    name: BACKUP_JOB,
    cron,
    handler: async () => service.runScheduled(),
  });
}
