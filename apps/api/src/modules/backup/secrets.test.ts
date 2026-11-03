import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@arclight/shared';
import { resetSecretKeys } from '../../db/secret-box.js';
import { initSecretsAtRest, SECRET_KEY_FILE } from '../../db/secret-keys.js';
import { settingsService } from '../settings/index.js';
import { ENC_MAGIC } from './crypto.js';
import { harness, silentLog, type Harness } from './test-support.js';
import { writeZip, ZipReader } from './zip.js';

// DATA-16 / DATA-48 / DATA-49: file modes, snapshot placement, encrypted backups, sealed secrets
// across backup and restore, and what a restore accepts.

const CHEAP_SCRYPT = { log2N: 12, r: 8, p: 1 };
const POSIX = process.platform !== 'win32';
const meta = { tmdbApiKey: 'tmdb-secret-1', language: 'en-US', region: 'US' };

const open: Harness[] = [];
function setup(): Harness {
  const h = harness({ scrypt: CHEAP_SCRYPT });
  open.push(h);
  return h;
}
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
  resetSecretKeys();
});

function sealAtRest(h: Harness): void {
  initSecretsAtRest({ configDir: h.dir, db: h.db, log: silentLog, env: {} });
}

function rawSetting(h: Harness, key: string): string {
  return h.db.$client.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string;
}

describe('backup files (DATA-16)', () => {
  it.skipIf(!POSIX)('creates archives with mode 0600', async () => {
    const h = setup();
    const b = await h.service.create('manual');
    expect(statSync(join(h.dir, 'backups', b.id)).mode & 0o777).toBe(0o600);
    h.service.updateSettings({ ...h.service.getSettings(), encryptionPassphrase: 'correct horse battery' });
    const e = await h.service.create('manual');
    expect(statSync(join(h.dir, 'backups', e.id)).mode & 0o777).toBe(0o600);
  });

  it('writes the unscrubbed snapshot in the config dir, never in the backup folder', async () => {
    const h = setup();
    const folder = join(h.dir, 'share');
    h.service.updateSettings({ ...h.service.getSettings(), folder });
    const targets: string[] = [];
    const client = h.db.$client;
    const exec = client.exec.bind(client);
    client.exec = ((sql: string) => {
      const m = /^VACUUM INTO '(.*)'$/.exec(sql);
      if (m) {
        targets.push(m[1]!.replaceAll("''", "'"));
        // While the snapshot exists, the backup folder holds no snapshot.
        const r = exec(sql);
        expect(readdirSync(folder).filter((n) => n.includes('snapshot'))).toEqual([]);
        return r;
      }
      return exec(sql);
    }) as typeof client.exec;
    const b = await h.service.create('manual');
    expect(targets).toHaveLength(1);
    expect(targets[0]!.startsWith(join(h.dir, '.snapshot-'))).toBe(true);
    expect(readdirSync(folder)).toEqual([b.id]);
    expect(readdirSync(h.dir).filter((n) => n.startsWith('.snapshot-') || n.startsWith('.backup-'))).toEqual([]);
  });

  it('flags a backup folder outside the config dir', () => {
    const h = setup();
    expect(h.service.folderOutsideConfig()).toBe(false);
    h.service.updateSettings({ ...h.service.getSettings(), folder: join(h.dir, 'inside') });
    expect(h.service.folderOutsideConfig()).toBe(false);
    h.service.updateSettings({ ...h.service.getSettings(), folder: join(h.dir, '..', 'outside-backups') });
    expect(h.service.folderOutsideConfig()).toBe(true);
  });
});

describe('encrypted backups (DATA-16)', () => {
  it('round-trips with the passphrase and fails cleanly with a wrong or missing one', async () => {
    const h = setup();
    settingsService.setSection(h.db, 'metadata', meta);
    const saved = h.service.updateSettings({ ...h.service.getSettings(), encryptionPassphrase: 'correct horse battery' });
    expect(saved.encryptionPassphrase).toBe(SECRET_MASK);
    // The mask keeps the stored passphrase; too short ones are refused.
    h.service.updateSettings({ ...saved });
    expect(h.service.getSettings().encryptionPassphrase).toBe('correct horse battery');
    expect(() => h.service.updateSettings({ ...saved, encryptionPassphrase: 'short' })).toThrow(/at least 8/);

    const b = await h.service.create('manual');
    expect(b).toMatchObject({ encrypted: true, name: 'arclight_manual_2026.10.25_04.00.00.zip.enc' });
    expect((await h.service.list())[0]).toMatchObject({ id: b.id, encrypted: true });
    const bytes = readFileSync(join(h.dir, 'backups', b.id));
    expect(bytes.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)).toBe(true);
    expect(bytes.includes(Buffer.from('tmdb-secret-1'))).toBe(false);
    expect(bytes.includes(Buffer.from('PrivateKey'))).toBe(false);

    settingsService.setSection(h.db, 'metadata', { ...meta, tmdbApiKey: 'changed' });
    await expect(h.service.restoreFromId(b.id, { passphrase: 'wrong passphrase' })).rejects.toMatchObject({ code: 'BAD_PASSPHRASE' });
    expect(settingsService.getSection(h.db, 'metadata').tmdbApiKey).toBe('changed');
    expect(existsSync(`${h.config.dbPath}.pre-restore`)).toBe(false);
    expect(readdirSync(h.dir).filter((n) => n.startsWith('.restore-'))).toEqual([]);

    // Passphrase turned off: the archive asks for one.
    h.service.updateSettings({ ...h.service.getSettings(), encryptionPassphrase: '' });
    await expect(h.service.restoreFromId(b.id)).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });
    // A different stored passphrase is not a typo either.
    h.service.updateSettings({ ...h.service.getSettings(), encryptionPassphrase: 'another passphrase' });
    await expect(h.service.restoreFromId(b.id)).rejects.toMatchObject({ code: 'PASSPHRASE_REQUIRED' });

    await expect(h.service.restoreFromId(b.id, { passphrase: 'correct horse battery' })).resolves.toEqual({ configFiles: 2 });
    expect(settingsService.getSection(h.db, 'metadata').tmdbApiKey).toBe('tmdb-secret-1');
  });

  it('uses the stored passphrase for its own backups', async () => {
    const h = setup();
    settingsService.setSection(h.db, 'metadata', meta);
    h.service.updateSettings({ ...h.service.getSettings(), encryptionPassphrase: 'correct horse battery' });
    const b = await h.service.create('manual');
    settingsService.setSection(h.db, 'metadata', { ...meta, tmdbApiKey: 'changed' });
    await h.service.restoreFromId(b.id);
    expect(settingsService.getSection(h.db, 'metadata').tmdbApiKey).toBe('tmdb-secret-1');
  });

  it('rejects a tampered encrypted archive', async () => {
    const h = setup();
    h.service.updateSettings({ ...h.service.getSettings(), encryptionPassphrase: 'correct horse battery' });
    const b = await h.service.create('manual');
    const path = join(h.dir, 'backups', b.id);
    const bytes = readFileSync(path);
    bytes[200] = bytes[200]! ^ 0xff;
    writeFileSync(path, bytes);
    await expect(h.service.restoreFromId(b.id)).rejects.toMatchObject({ code: 'INVALID_BACKUP', message: expect.stringMatching(/damaged/) });
  });
});

describe('sealed secrets and restore (DATA-16)', () => {
  it('keeps secrets sealed inside the backup and restores them on the same install', async () => {
    const h = setup();
    sealAtRest(h);
    settingsService.setSection(h.db, 'metadata', meta);
    expect(rawSetting(h, 'metadata')).not.toContain('tmdb-secret-1');
    const b = await h.service.create('manual');
    const zip = await ZipReader.open(join(h.dir, 'backups', b.id));
    try {
      expect(zip.entries.map((e) => e.name)).toContain(`config/${SECRET_KEY_FILE}`);
      expect((await zip.readBuffer('settings.json')).includes(Buffer.from('tmdb-secret-1'))).toBe(false);
    } finally {
      await zip.close();
    }
    settingsService.setSection(h.db, 'metadata', { ...meta, tmdbApiKey: 'changed' });
    await h.service.restoreFromId(b.id);
    expect(settingsService.getSection(h.db, 'metadata').tmdbApiKey).toBe('tmdb-secret-1');
  });

  it('restores onto a fresh install with another key: the archived key is merged in', async () => {
    const a = setup();
    sealAtRest(a);
    settingsService.setSection(a.db, 'metadata', meta);
    const b = await a.service.create('manual');
    const archive = join(a.dir, 'backups', b.id);

    resetSecretKeys();
    const fresh = setup();
    sealAtRest(fresh);
    const before = JSON.parse(readFileSync(join(fresh.dir, SECRET_KEY_FILE), 'utf8')) as { active: string; keys: Record<string, string> };
    await fresh.service.restoreFromFile(archive);
    expect(settingsService.getSection(fresh.db, 'metadata').tmdbApiKey).toBe('tmdb-secret-1');
    const after = JSON.parse(readFileSync(join(fresh.dir, SECRET_KEY_FILE), 'utf8')) as { active: string; keys: Record<string, string> };
    // Our key stays active; the backup's is added.
    expect(after.active).toBe(before.active);
    expect(Object.keys(after.keys)).toHaveLength(2);
    if (POSIX) expect(statSync(join(fresh.dir, SECRET_KEY_FILE)).mode & 0o777).toBe(0o600);
  });

  it('still restores a plaintext backup from before encryption at rest', async () => {
    const old = setup();
    settingsService.setSection(old.db, 'metadata', meta);
    const b = await old.service.create('manual');
    const zip = await ZipReader.open(join(old.dir, 'backups', b.id));
    try {
      expect((await zip.readBuffer('settings.json')).includes(Buffer.from('tmdb-secret-1'))).toBe(true);
    } finally {
      await zip.close();
    }

    const h = setup();
    sealAtRest(h);
    await h.service.restoreFromFile(join(old.dir, 'backups', b.id));
    expect(settingsService.getSection(h.db, 'metadata').tmdbApiKey).toBe('tmdb-secret-1');
  });
});

describe('restore validation (DATA-48, DATA-49)', () => {
  async function archiveWith(h: Harness, mutate: (db: Database.Database) => void, manifestExtra: Record<string, unknown> = {}, dbName = 'arclight.db') {
    const copy = join(h.dir, `crafted-${Math.random().toString(36).slice(2)}.db`);
    h.db.$client.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    const c = new Database(copy);
    mutate(c);
    c.close();
    const zip = join(h.dir, `crafted-${Math.random().toString(36).slice(2)}.zip`);
    const manifest = { appName: 'Arclight', version: '1', type: 'manual', database: dbName, ...manifestExtra };
    await writeZip(zip, [
      { name: 'manifest.json', source: Buffer.from(JSON.stringify(manifest)) },
      { name: dbName, source: { path: copy } },
    ]);
    return zip;
  }

  it('rejects a database with a trigger, a view or an unknown table', async () => {
    const h = setup();
    settingsService.setSection(h.db, 'metadata', meta);
    const trigger = await archiveWith(h, (d) =>
      d.exec("CREATE TRIGGER evil AFTER INSERT ON settings BEGIN UPDATE settings SET value = '{}'; END"),
    );
    await expect(h.service.restoreFromFile(trigger)).rejects.toMatchObject({ code: 'INVALID_BACKUP', message: expect.stringMatching(/trigger/) });
    const view = await archiveWith(h, (d) => d.exec('CREATE VIEW v AS SELECT * FROM settings'));
    await expect(h.service.restoreFromFile(view)).rejects.toMatchObject({ code: 'INVALID_BACKUP', message: expect.stringMatching(/view/) });
    const table = await archiveWith(h, (d) => d.exec('CREATE TABLE stowaway (x TEXT)'));
    await expect(h.service.restoreFromFile(table)).rejects.toMatchObject({ code: 'INVALID_BACKUP', message: expect.stringMatching(/stowaway/) });
    expect(settingsService.getSection(h.db, 'metadata').tmdbApiKey).toBe('tmdb-secret-1');
    // A table a migration created (even one the live schema no longer has) is fine.
    const ok = await archiveWith(h, () => undefined);
    await expect(h.service.restoreFromFile(ok)).resolves.toEqual({ configFiles: 0 });
  });

  it('uses the database entry the manifest names', async () => {
    const h = setup();
    const zip = await archiveWith(h, () => undefined, {}, 'media-tron.db');
    await expect(h.service.restoreFromFile(zip)).resolves.toEqual({ configFiles: 0 });
  });
});
