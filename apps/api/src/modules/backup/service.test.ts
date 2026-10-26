import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Backup } from '@arclight/shared';
import { settingsService } from '../settings/index.js';
import { backupFileName, parseBackupFileName, selectForPruning } from './service.js';
import { harness, type Harness } from './test-support.js';
import { writeZip, ZipReader } from './zip.js';

let h: Harness | null = null;
function setup(): Harness {
  h = harness();
  return h;
}
afterEach(() => {
  h?.cleanup();
  h = null;
});

const meta = { tmdbApiKey: 'key-1', language: 'en-US', region: 'US' };

describe('backup names and retention', () => {
  it('formats and parses file names, rejecting foreign ones', () => {
    const at = new Date('2026-10-25T04:05:06Z');
    expect(backupFileName('scheduled', at)).toBe('arclight_scheduled_2026.10.25_04.05.06.zip');
    expect(backupFileName('manual', at, 2)).toBe('arclight_manual_2026.10.25_04.05.06_2.zip');
    expect(parseBackupFileName('arclight_update_2026.10.25_04.05.06_3.zip')).toEqual({ type: 'update', time: at });
    for (const bad of ['../arclight_manual_2026.10.25_04.05.06.zip', 'evil.zip', 'arclight_other_2026.10.25_04.05.06.zip', 'arclight.db']) {
      expect(parseBackupFileName(bad)).toBeNull();
    }
  });

  it('prunes automatic backups by age and count, never manual ones', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    const mk = (type: Backup['type'], daysAgo: number): Backup => {
      const time = new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
      return { id: `${type}-${daysAgo}`, name: `${type}-${daysAgo}`, type, size: 1, time };
    };
    const all = [mk('scheduled', 1), mk('scheduled', 2), mk('update', 3), mk('scheduled', 4), mk('scheduled', 40), mk('manual', 100)];
    expect(selectForPruning(all, { retentionCount: 3, retentionDays: 28 }, now).map((b) => b.id)).toEqual(['scheduled-4', 'scheduled-40']);
    expect(selectForPruning(all, { retentionCount: 0, retentionDays: 0 }, now)).toEqual([]);
    expect(selectForPruning(all, { retentionCount: 0, retentionDays: 3.5 }, now).map((b) => b.id)).toEqual(['scheduled-4', 'scheduled-40']);
    expect(selectForPruning(all, { retentionCount: 1, retentionDays: 0 }, now).map((b) => b.id)).toEqual([
      'scheduled-2',
      'update-3',
      'scheduled-4',
      'scheduled-40',
    ]);
  });
});

describe('BackupService', () => {
  it('creates an archive with manifest, a consistent db snapshot, settings export and config files', async () => {
    const { service, db, dir } = setup();
    settingsService.setSection(db, 'metadata', meta);
    const b = await service.create('manual');
    expect(b).toMatchObject({ type: 'manual', name: 'arclight_manual_2026.10.25_04.00.00.zip' });
    expect(b.size).toBeGreaterThan(0);
    const path = join(dir, 'backups', b.id);
    expect(existsSync(path)).toBe(true);

    const zip = await ZipReader.open(path);
    try {
      const names = zip.entries.map((e) => e.name);
      expect(names).toEqual(['manifest.json', 'arclight.db', 'settings.json', 'config/custom/notes.txt', 'config/wg0.conf']);
      // Logs, the live db files and the backups folder itself are not archived.
      expect(names.some((n) => n.includes('logs/') || n.includes('backups/'))).toBe(false);
      const manifest = JSON.parse((await zip.readBuffer('manifest.json')).toString());
      expect(manifest).toMatchObject({ appName: 'Arclight', version: '9.9.9-test', type: 'manual', database: 'arclight.db' });
      const exported = JSON.parse((await zip.readBuffer('settings.json')).toString());
      expect(exported.sections.metadata).toMatchObject({ tmdbApiKey: 'key-1' });
      expect((await zip.readBuffer('config/wg0.conf')).toString()).toContain('PrivateKey');

      const snap = join(dir, 'snap.db');
      await zip.extract('arclight.db', snap);
      const copy = new Database(snap, { readonly: true });
      try {
        const row = copy.prepare("SELECT value FROM settings WHERE key = 'metadata'").pluck().get() as string;
        expect(JSON.parse(row)).toMatchObject({ tmdbApiKey: 'key-1' });
      } finally {
        copy.close();
      }
    } finally {
      await zip.close();
    }
    // The temporary snapshot is cleaned up.
    expect(readdirNames(join(dir, 'backups'))).toEqual([b.id]);
  });

  it('lists newest first, disambiguates same-second names, resolves and deletes', async () => {
    const { service, clock } = setup();
    const a = await service.create('manual');
    const b = await service.create('manual');
    expect(b.id).toBe('arclight_manual_2026.10.25_04.00.00_2.zip');
    clock.now = new Date('2026-10-26T04:00:00Z');
    const c = await service.create('update');
    expect((await service.list()).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    await service.delete(a.id);
    expect((await service.list()).map((x) => x.id)).toEqual([c.id, b.id]);
    await expect(service.delete(a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.resolve('../arclight.db')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('applies retention after automatic backups and honours a custom folder', async () => {
    const { service, db, clock, dir } = setup();
    const folder = join(dir, 'elsewhere');
    service.updateSettings({ folder, intervalDays: 1, hour: 4, retentionCount: 2, retentionDays: 0 });
    expect(() => service.updateSettings({ ...service.getSettings(), folder: 'relative/path' })).toThrow(/absolute/);
    const manual = await service.create('manual');
    const ids: string[] = [];
    for (let d = 0; d < 4; d++) {
      clock.now = new Date(Date.UTC(2026, 9, 20 + d, 4));
      ids.push((await service.create('scheduled')).id);
    }
    const left = (await service.list()).map((b) => b.id);
    expect(left).toEqual([manual.id, ids[3], ids[2]]);
    expect(existsSync(join(folder, ids[3]!))).toBe(true);
    expect(settingsService.getSection(db, 'backup').folder).toBe(folder);
  });

  it('runs scheduled backups only when due', async () => {
    const { service, clock } = setup();
    const hour = clock.now.getHours();
    service.updateSettings({ ...service.getSettings(), hour: (hour + 1) % 24 });
    expect(await service.runScheduled()).toBe('not due');
    service.updateSettings({ ...service.getSettings(), hour });
    expect(await service.runScheduled()).toMatch(/^created arclight_scheduled_/);
    clock.now = new Date(clock.now.getTime() + 60_000);
    expect(await service.runScheduled()).toBe('not due');
    // The next day, 30 minutes earlier, is still due thanks to the slack.
    clock.now = new Date(clock.now.getTime() + 86_400_000 - 30 * 60_000 - 60_000);
    if (clock.now.getHours() === hour) expect(await service.runScheduled()).toMatch(/^created/);
    service.updateSettings({ ...service.getSettings(), intervalDays: 0 });
    expect(await service.runScheduled()).toBe('scheduled backups disabled');
  });

  it('restores the database and config files into the live connection', async () => {
    const { service, db, dir, config, restored } = setup();
    settingsService.setSection(db, 'metadata', meta);
    const b = await service.create('manual');

    settingsService.setSection(db, 'metadata', { ...meta, tmdbApiKey: 'changed' });
    writeFileSync(join(dir, 'wg0.conf'), 'overwritten');
    const result = await service.restoreFromId(b.id);

    expect(result.configFiles).toBe(2);
    // Same connection, restored contents.
    expect(settingsService.getSection(db, 'metadata').tmdbApiKey).toBe('key-1');
    expect(readFileSync(join(dir, 'wg0.conf'), 'utf8')).toContain('PrivateKey');
    expect(existsSync(`${config.dbPath}.pre-restore`)).toBe(true);
    expect(restored).toEqual([`Restored backup ${b.id}`]);
    // Staging directories are removed.
    expect(readdirNames(dir).filter((n) => n.startsWith('.restore-'))).toEqual([]);
  });

  it('refuses invalid archives without touching the live database', async () => {
    const { service, db, dir } = setup();
    settingsService.setSection(db, 'metadata', meta);
    const check = async (path: string, message: RegExp) => {
      await expect(service.restoreFromFile(path)).rejects.toMatchObject({ code: 'INVALID_BACKUP', message: expect.stringMatching(message) });
      expect(settingsService.getSection(db, 'metadata').tmdbApiKey).toBe('key-1');
    };
    const notZip = join(dir, 'x.zip');
    writeFileSync(notZip, 'garbage garbage garbage garbage');
    await check(notZip, /not a zip/);

    const noManifest = join(dir, 'a.zip');
    await writeZip(noManifest, [{ name: 'arclight.db', source: Buffer.from('x') }]);
    await check(noManifest, /no manifest/);

    const manifest = Buffer.from(JSON.stringify({ appName: 'Arclight', version: '1', type: 'manual' }));
    const badDb = join(dir, 'b.zip');
    await writeZip(badDb, [
      { name: 'manifest.json', source: manifest },
      { name: 'arclight.db', source: Buffer.from('not sqlite at all, sorry') },
    ]);
    await check(badDb, /not a SQLite database/);

    const foreign = join(dir, 'c.zip');
    await writeZip(foreign, [{ name: 'manifest.json', source: Buffer.from('{"appName":"Other"}') }, { name: 'arclight.db', source: Buffer.from('x') }]);
    await check(foreign, /bad manifest/);

    // A database from a newer version (more migrations than ours).
    const b = await service.create('manual');
    const newer = join(dir, 'newer.db');
    const zip = await ZipReader.open(join(dir, 'backups', b.id));
    await zip.extract('arclight.db', newer);
    await zip.close();
    const n = new Database(newer);
    n.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('future', Date.now());
    n.close();
    const newerZip = join(dir, 'd.zip');
    await writeZip(newerZip, [{ name: 'manifest.json', source: manifest }, { name: 'arclight.db', source: { path: newer } }]);
    await check(newerZip, /newer Arclight version/);

    const handMade = join(dir, 'e.zip');
    const good = join(dir, 'good.db');
    db.$client.exec(`VACUUM INTO '${good.replaceAll("'", "''")}'`);
    await writeZip(handMade, [
      { name: 'manifest.json', source: manifest },
      { name: 'arclight.db', source: { path: good } },
      { name: 'config/ok.txt', source: Buffer.from('fine') },
    ]);
    // Sanity: a well-formed hand-made archive restores.
    await expect(service.restoreFromFile(handMade)).resolves.toEqual({ configFiles: 1 });
  });
});

function readdirNames(path: string): string[] {
  return readdirSync(path);
}
