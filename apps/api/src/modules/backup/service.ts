import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Backup, BackupSettings, BackupType } from '@arclight/shared';
import { DB_FILE_NAME, type AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import { settings as settingsTable } from '../../db/schema.js';
import { settingsService } from '../settings/index.js';
import { isSafeEntryName, writeZip, ZipError, ZipReader, type ZipInput } from './zip.js';

// Backup archives: `arclight_<type>_<YYYY.MM.DD_HH.mm.ss>[_n].zip` in the backup folder,
// containing manifest.json, arclight.db (a VACUUM INTO snapshot), settings.json (export of
// the settings table) and config/** (the config directory's non-log files). The file name is
// the id; nothing about backups is stored in the database, so a restore cannot lose the list.

/** Default archive entry for the database; the actual name is the live file name, recorded in the manifest. */
export const DB_ENTRY = DB_FILE_NAME;
export const MANIFEST_ENTRY = 'manifest.json';
export const SETTINGS_ENTRY = 'settings.json';
export const CONFIG_PREFIX = 'config/';

// Pre-rename (Media-Tron) archives stay listable and restorable: file prefix, manifest appName.
const LEGACY_APP_NAME = 'Media-Tron';
const NAME_RE = /^(?:arclight|media-tron)_(scheduled|manual|update)_(\d{4})\.(\d{2})\.(\d{2})_(\d{2})\.(\d{2})\.(\d{2})(?:_(\d+))?\.zip$/;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
/** Config files bigger than this are not archived (caches, stray media). */
const MAX_CONFIG_FILE = 100 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export type BackupErrorCode = 'NOT_FOUND' | 'INVALID_BACKUP' | 'BUSY' | 'VALIDATION';

export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface BackupManifest {
  appName: 'Arclight';
  version: string;
  type: BackupType;
  createdAt: string;
  database: string;
  configFiles: string[];
}

export interface BackupServiceOptions {
  db: Db;
  config: AppConfig;
  log: Logger;
  version: string;
  now?: () => Date;
  /** Called after a successful restore (the module raises the restart-required flag). */
  onRestored?: (reason: string) => void;
}

export interface RestoreResult {
  configFiles: number;
}

export function backupFileName(type: BackupType, at: Date, n = 0): string {
  const p = (v: number) => String(v).padStart(2, '0');
  const stamp = `${at.getUTCFullYear()}.${p(at.getUTCMonth() + 1)}.${p(at.getUTCDate())}_${p(at.getUTCHours())}.${p(at.getUTCMinutes())}.${p(at.getUTCSeconds())}`;
  return `arclight_${type}_${stamp}${n > 0 ? `_${n}` : ''}.zip`;
}

/** Parses a backup file name; null for anything that is not one of ours. */
export function parseBackupFileName(name: string): { type: BackupType; time: Date } | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, type, y, mo, d, h, mi, s] = m;
  const time = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  if (Number.isNaN(time.getTime())) return null;
  return { type: type as BackupType, time };
}

/**
 * Which automatic backups retention removes: anything older than `retentionDays`, then
 * everything past the newest `retentionCount`. Manual backups are never pruned.
 */
export function selectForPruning(backups: readonly Backup[], s: Pick<BackupSettings, 'retentionCount' | 'retentionDays'>, now: Date): Backup[] {
  const auto = backups.filter((b) => b.type !== 'manual').sort((a, b) => b.time.localeCompare(a.time));
  const doomed = new Set<Backup>();
  if (s.retentionDays > 0) {
    const cutoff = now.getTime() - s.retentionDays * DAY_MS;
    for (const b of auto) if (new Date(b.time).getTime() < cutoff) doomed.add(b);
  }
  if (s.retentionCount > 0) {
    const kept = auto.filter((b) => !doomed.has(b));
    for (const b of kept.slice(s.retentionCount)) doomed.add(b);
  }
  return auto.filter((b) => doomed.has(b));
}

function sqlQuote(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class BackupService {
  private readonly now: () => Date;
  private busy: string | null = null;

  constructor(private readonly opts: BackupServiceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ settings

  getSettings(): BackupSettings {
    return settingsService.getSection(this.opts.db, 'backup');
  }

  updateSettings(value: BackupSettings): BackupSettings {
    if (value.folder && !isAbsolute(value.folder)) throw new BackupError('VALIDATION', 'backup folder must be an absolute path');
    return settingsService.setSection(this.opts.db, 'backup', value);
  }

  folder(): string {
    const configured = this.getSettings().folder.trim();
    return configured ? resolve(configured) : join(this.opts.config.configDir, 'backups');
  }

  // ------------------------------------------------------------------ list / files

  async list(): Promise<Backup[]> {
    const folder = this.folder();
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: Backup[] = [];
    for (const name of names) {
      const parsed = parseBackupFileName(name);
      if (!parsed) continue;
      const st = await stat(join(folder, name)).catch(() => null);
      if (!st?.isFile()) continue;
      out.push({ id: name, name, type: parsed.type, size: st.size, time: parsed.time.toISOString() });
    }
    // Newest first; same-second names by their numeric suffix (plain code-point order).
    return out.sort((a, b) => (a.time === b.time ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.time < b.time ? 1 : -1));
  }

  /** Absolute path + size of a backup; NOT_FOUND for unknown or foreign names. */
  async resolve(id: string): Promise<{ path: string; size: number; name: string }> {
    if (!parseBackupFileName(id)) throw new BackupError('NOT_FOUND', `backup ${id} not found`);
    const path = join(this.folder(), id);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) throw new BackupError('NOT_FOUND', `backup ${id} not found`);
    return { path, size: st.size, name: id };
  }

  async delete(id: string): Promise<void> {
    const { path } = await this.resolve(id);
    await rm(path);
  }

  // ------------------------------------------------------------------ create

  async create(type: BackupType): Promise<Backup> {
    return this.exclusive(`creating a ${type} backup`, async () => {
      const folder = this.folder();
      await mkdir(folder, { recursive: true });
      const at = this.now();
      let name = backupFileName(type, at);
      for (let n = 2; await exists(join(folder, name)); n++) name = backupFileName(type, at, n);
      const dest = join(folder, name);

      const snapshot = join(folder, `.snapshot-${randomUUID()}.db`);
      try {
        // VACUUM INTO writes a consistent, compacted copy while the app keeps running.
        this.opts.db.$client.exec(`VACUUM INTO ${sqlQuote(snapshot)}`);
        const configFiles = await this.collectConfigFiles(folder);
        const rows = this.opts.db.select().from(settingsTable).all();
        const settingsExport = {
          exportedAt: at.toISOString(),
          version: this.opts.version,
          sections: Object.fromEntries(rows.map((r) => [r.key, r.value])),
        };
        const dbEntry = basename(this.opts.config.dbPath);
        const manifest: BackupManifest = {
          appName: 'Arclight',
          version: this.opts.version,
          type,
          createdAt: at.toISOString(),
          database: dbEntry,
          configFiles: configFiles.map((f) => f.rel),
        };
        const inputs: ZipInput[] = [
          { name: MANIFEST_ENTRY, source: Buffer.from(JSON.stringify(manifest, null, 2)), mtime: at },
          { name: dbEntry, source: { path: snapshot }, mtime: at },
          { name: SETTINGS_ENTRY, source: Buffer.from(JSON.stringify(settingsExport, null, 2)), mtime: at },
          ...configFiles.map((f) => ({ name: CONFIG_PREFIX + f.rel, source: { path: f.abs }, mtime: f.mtime })),
        ];
        await writeZip(dest, inputs);
      } finally {
        await rm(snapshot, { force: true });
      }
      const size = (await stat(dest)).size;
      this.opts.log.info({ backup: name, size }, 'backup created');
      if (type !== 'manual') await this.prune();
      return { id: name, name, type, size, time: at.toISOString() };
    });
  }

  /** Non-log files of the config directory, relative '/'-separated paths. */
  private async collectConfigFiles(backupFolder: string): Promise<Array<{ rel: string; abs: string; mtime: Date }>> {
    const { configDir, logDir, dbPath } = this.opts.config;
    const dbName = basename(dbPath);
    const skipFiles = new Set([dbName, `${dbName}-wal`, `${dbName}-shm`, `${dbName}-journal`, `${dbName}.pre-restore`]);
    const skipDirs = [resolve(logDir), resolve(backupFolder)];
    const out: Array<{ rel: string; abs: string; mtime: Date }> = [];

    const walk = async (dir: string): Promise<void> => {
      const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        const abs = join(dir, item.name);
        if (item.name.startsWith('.')) continue;
        if (item.isDirectory()) {
          if (skipDirs.some((d) => isWithin(d, abs)) || item.name === 'cache') continue;
          await walk(abs);
          continue;
        }
        if (!item.isFile()) continue;
        if (dir === resolve(configDir) && skipFiles.has(item.name)) continue;
        if (/\.(log|tmp|partial)$/i.test(item.name) || /\.log\.\d+$/i.test(item.name)) continue;
        const st = await stat(abs).catch(() => null);
        if (!st) continue;
        if (st.size > MAX_CONFIG_FILE) {
          this.opts.log.warn({ file: abs, size: st.size }, 'config file too large for backup; skipped');
          continue;
        }
        const rel = relative(configDir, abs).split(sep).join('/');
        if (isSafeEntryName(CONFIG_PREFIX + rel)) out.push({ rel, abs, mtime: st.mtime });
      }
    };
    await walk(resolve(configDir));
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  // ------------------------------------------------------------------ retention / schedule

  /** Applies retention to automatic backups; returns the deleted ids. */
  async prune(): Promise<string[]> {
    const doomed = selectForPruning(await this.list(), this.getSettings(), this.now());
    for (const b of doomed) await rm(join(this.folder(), b.id), { force: true });
    if (doomed.length) this.opts.log.info({ deleted: doomed.map((b) => b.id) }, 'old backups pruned');
    return doomed.map((b) => b.id);
  }

  /**
   * The scheduled job's hourly tick: backs up when scheduled backups are on, the local hour
   * matches the setting and the last scheduled backup is at least `intervalDays` old (with an
   * hour of slack so a daily backup does not drift).
   */
  async runScheduled(): Promise<string> {
    const s = this.getSettings();
    if (s.intervalDays === 0) return 'scheduled backups disabled';
    const now = this.now();
    if (now.getHours() !== s.hour) return 'not due';
    const last = (await this.list()).find((b) => b.type === 'scheduled');
    if (last && now.getTime() - new Date(last.time).getTime() < s.intervalDays * DAY_MS - 60 * 60 * 1000) return 'not due';
    const b = await this.create('scheduled');
    return `created ${b.name}`;
  }

  // ------------------------------------------------------------------ restore

  async restoreFromId(id: string): Promise<RestoreResult> {
    const { path } = await this.resolve(id);
    return this.restoreFromFile(path);
  }

  /**
   * Validates the archive, then replaces the live database's contents with the archived one
   * and writes back the archived config files. The swap uses SQLite's online backup API into
   * the live database file: it is one transaction (all or nothing), it keeps every open
   * connection valid, and it works on Windows where an open file cannot be renamed over.
   * In-memory state built from the old database is stale afterwards, so a restart is required.
   */
  async restoreFromFile(archive: string): Promise<RestoreResult> {
    return this.exclusive('restoring a backup', async () => {
      const { configDir, dbPath } = this.opts.config;
      const staging = join(configDir, `.restore-${randomUUID()}`);
      await mkdir(staging, { recursive: true });
      let zip: ZipReader | null = null;
      try {
        try {
          zip = await ZipReader.open(archive);
        } catch (err) {
          throw invalid(err);
        }
        const manifest = await readManifest(zip);
        const stagedDb = join(staging, 'database.db');
        try {
          await zip.extract(manifest.database, stagedDb);
        } catch (err) {
          throw invalid(err);
        }
        this.validateDatabase(stagedDb);

        // Directory entries (trailing '/') carry no data; folders are created as needed.
        const configEntries = zip.entries.filter(
          (e) => e.name.startsWith(CONFIG_PREFIX) && e.name.length > CONFIG_PREFIX.length && !e.name.endsWith('/'),
        );
        const stagedConfig: Array<{ staged: string; target: string }> = [];
        for (const [i, e] of configEntries.entries()) {
          const rel = e.name.slice(CONFIG_PREFIX.length);
          const target = resolve(configDir, ...rel.split('/'));
          if (!isSafeEntryName(e.name) || !isWithin(configDir, target)) throw new BackupError('INVALID_BACKUP', `unsafe path in backup: ${e.name}`);
          if (dirname(target) === resolve(configDir) && basename(target).startsWith(basename(dbPath))) continue;
          const staged = join(staging, `config-${i}`);
          try {
            await zip.extract(e.name, staged);
          } catch (err) {
            throw invalid(err);
          }
          stagedConfig.push({ staged, target });
        }

        // Everything validated; keep a copy of the current database, then swap.
        const safety = `${dbPath}.pre-restore`;
        await rm(safety, { force: true });
        this.opts.db.$client.exec(`VACUUM INTO ${sqlQuote(safety)}`);
        const source = new Database(stagedDb, { readonly: true, fileMustExist: true });
        try {
          await source.backup(dbPath);
        } finally {
          source.close();
        }
        for (const f of stagedConfig) {
          await mkdir(dirname(f.target), { recursive: true });
          await rename(f.staged, f.target);
        }
        this.opts.log.warn({ archive: basename(archive), from: manifest.version, configFiles: stagedConfig.length }, 'backup restored');
        this.opts.onRestored?.(`Restored backup ${basename(archive)}`);
        return { configFiles: stagedConfig.length };
      } finally {
        await zip?.close();
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  /** The archived database must be an intact SQLite file with our schema, not newer than ours. */
  private validateDatabase(path: string): void {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, header, 0, header.length, 0);
    } finally {
      closeSync(fd);
    }
    if (!header.equals(SQLITE_HEADER)) throw new BackupError('INVALID_BACKUP', 'backup database is not a SQLite database');
    let candidate: Database.Database;
    try {
      candidate = new Database(path, { readonly: true, fileMustExist: true });
    } catch (err) {
      throw invalid(err);
    }
    try {
      const check = candidate.prepare('PRAGMA quick_check').pluck().get();
      if (check !== 'ok') throw new BackupError('INVALID_BACKUP', `database integrity check failed: ${String(check)}`);
      const hasTable = (db: Database.Database, name: string) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
      if (!hasTable(candidate, 'settings')) throw new BackupError('INVALID_BACKUP', 'backup database is not an Arclight database');
      const live = this.opts.db.$client;
      const migrations = '__drizzle_migrations';
      if (hasTable(candidate, migrations) && hasTable(live, migrations)) {
        const count = (db: Database.Database) => Number(db.prepare(`SELECT count(*) FROM ${migrations}`).pluck().get());
        if (count(candidate) > count(live)) {
          throw new BackupError('INVALID_BACKUP', 'backup is from a newer Arclight version; update before restoring it');
        }
      }
    } catch (err) {
      throw err instanceof BackupError ? err : invalid(err);
    } finally {
      candidate.close();
    }
  }

  private async exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new BackupError('BUSY', `busy ${this.busy}`);
    this.busy = what;
    try {
      return await fn();
    } finally {
      this.busy = null;
    }
  }
}

async function readManifest(zip: ZipReader): Promise<BackupManifest> {
  if (!zip.get(MANIFEST_ENTRY)) throw new BackupError('INVALID_BACKUP', 'not an Arclight backup (no manifest.json)');
  let manifest: unknown;
  try {
    manifest = JSON.parse((await zip.readBuffer(MANIFEST_ENTRY)).toString('utf8'));
  } catch (err) {
    throw invalid(err);
  }
  const appName = typeof manifest === 'object' && manifest !== null ? (manifest as { appName?: unknown }).appName : undefined;
  if (appName !== 'Arclight' && appName !== LEGACY_APP_NAME) {
    throw new BackupError('INVALID_BACKUP', 'not an Arclight backup (bad manifest)');
  }
  const recorded = (manifest as { database?: unknown }).database;
  const database = typeof recorded === 'string' && /^[w.-]+.db$/.test(recorded) ? recorded : DB_ENTRY;
  if (!zip.get(database)) throw new BackupError('INVALID_BACKUP', `backup has no ${database}`);
  return { ...(manifest as BackupManifest), database };
}

function invalid(err: unknown): BackupError {
  if (err instanceof BackupError) return err;
  const detail = err instanceof ZipError || err instanceof Error ? err.message : String(err);
  return new BackupError('INVALID_BACKUP', `invalid backup: ${detail}`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
