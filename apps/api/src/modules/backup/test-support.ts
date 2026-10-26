import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { AppConfig } from '../../config.js';
import { openDatabase, type Db } from '../../db/index.js';
import { BackupService, type BackupServiceOptions } from './service.js';

// Test helpers; not used by production code.

export const silentLog = pino({ level: 'silent' });

export interface Harness {
  dir: string;
  config: AppConfig;
  db: Db;
  service: BackupService;
  clock: { now: Date };
  restored: string[];
  cleanup: () => void;
}

/** A real on-disk config dir + migrated database, so VACUUM INTO and the restore swap run for real. */
export function harness(over: Partial<BackupServiceOptions> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'mt-backup-'));
  const config: AppConfig = {
    configDir: dir,
    dbPath: join(dir, 'media-tron.db'),
    logDir: join(dir, 'logs'),
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    isDocker: false,
    webDist: null,
  };
  mkdirSync(config.logDir, { recursive: true });
  writeFileSync(join(config.logDir, 'media-tron.log'), 'log line\n');
  writeFileSync(join(dir, 'wg0.conf'), '[Interface]\nPrivateKey = abc\n');
  mkdirSync(join(dir, 'custom'), { recursive: true });
  writeFileSync(join(dir, 'custom', 'notes.txt'), 'hello');
  const db = openDatabase(config.dbPath);
  const clock = { now: new Date('2026-10-25T04:00:00Z') };
  const restored: string[] = [];
  const service = new BackupService({
    db,
    config,
    log: silentLog,
    version: '9.9.9-test',
    now: () => clock.now,
    onRestored: (r) => restored.push(r),
    ...over,
  });
  return {
    dir,
    config,
    db,
    service,
    clock,
    restored,
    cleanup: () => {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
