import { z } from 'zod';

// Backups: zip archives of a consistent database snapshot, a settings export and the config
// directory's non-log files. Files live in the backup folder; the file name is the id.

export const BackupType = z.enum(['scheduled', 'manual', 'update']);
export type BackupType = z.infer<typeof BackupType>;

/** One archive in the backup folder (GET /api/v1/system/backup). */
export const Backup = z.object({
  /** File name; used as the id in URLs. */
  id: z.string(),
  name: z.string(),
  type: BackupType,
  /** Bytes. */
  size: z.number().int().nonnegative(),
  time: z.string().datetime(),
});
export type Backup = z.infer<typeof Backup>;

/** Stored form of the `backup` settings section (GET/PUT /api/v1/settings/backup). */
export const BackupSettings = z.object({
  /** Absolute folder for archives; empty means `<config>/backups`. */
  folder: z.string().default(''),
  /** Days between scheduled backups; 0 disables scheduled backups. */
  intervalDays: z.number().int().min(0).max(365).default(1),
  /** Local hour of day (0-23) at which a due scheduled backup runs. */
  hour: z.number().int().min(0).max(23).default(4),
  /** Keep at most this many automatic (scheduled/update) backups; 0 = no count limit. */
  retentionCount: z.number().int().min(0).max(1000).default(7),
  /** Delete automatic backups older than this many days; 0 = no age limit. */
  retentionDays: z.number().int().min(0).max(3650).default(28),
});
export type BackupSettings = z.infer<typeof BackupSettings>;
export type BackupSettingsInput = z.input<typeof BackupSettings>;

/** POST /api/v1/system/backup/restore/:id and /restore/upload. */
export const BackupRestoreResponse = z.object({
  restored: z.literal(true),
  /** Config files written back besides the database. */
  configFiles: z.number().int().nonnegative(),
  restartRequired: z.literal(true),
});
export type BackupRestoreResponse = z.infer<typeof BackupRestoreResponse>;

/** POST /api/v1/system/restart. */
export const RestartResponse = z.object({ restarting: z.literal(true) });
export type RestartResponse = z.infer<typeof RestartResponse>;

export const BackupErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type BackupErrorResponse = z.infer<typeof BackupErrorResponse>;
