import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { settingsService } from '../modules/settings/index.js';
import { hardenConfigDir } from '../file-modes.js';
import { openDatabase, type Db } from './index.js';
import {
  generateSecretKey,
  isSealed,
  openString,
  openTree,
  registerSecretKey,
  resetSecretKeys,
  sealString,
  sealTree,
  setSealing,
  SEALED_PREFIX,
} from './secret-box.js';
import { initSecretsAtRest, SECRET_KEY_FILE, sealedColumns } from './secret-keys.js';

// DATA-16: secrets sealed at rest with a key file in the config dir; plaintext from before 0.24
// keeps reading and is migrated in place.

const log = pino({ level: 'silent' });
const POSIX = process.platform !== 'win32';
const dirs: string[] = [];
const dbs: Db[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mt-secrets-'));
  dirs.push(d);
  return d;
}
function db(dir: string): Db {
  const d = openDatabase(join(dir, 'arclight.db'));
  dbs.push(d);
  return d;
}
function raw(d: Db, key: string): string {
  return d.$client.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string;
}
afterEach(() => {
  for (const d of dbs.splice(0)) d.$client.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetSecretKeys();
});

describe('secret box', () => {
  it('passes values through while no key is active', () => {
    expect(sealString('plain')).toBe('plain');
    expect(sealTree({ apiKey: 'x' })).toEqual({ apiKey: 'x' });
  });

  it('seals and opens strings, and reads plaintext as is', () => {
    setSealing(registerSecretKey(generateSecretKey(), { active: true }));
    const sealed = sealString('hunter22');
    expect(sealed.startsWith(SEALED_PREFIX)).toBe(true);
    expect(sealed).not.toContain('hunter22');
    expect(sealString('hunter22')).not.toBe(sealed); // random IV
    expect(openString(sealed)).toBe('hunter22');
    expect(openString('legacy plaintext')).toBe('legacy plaintext');
    expect(sealString(sealed)).toBe(sealed); // never double-sealed
  });

  it('seals only secret-looking keys of a settings tree', () => {
    setSealing(registerSecretKey(generateSecretKey(), { active: true }));
    const tree = sealTree({ host: 'qbit', password: 'pw', nested: { botToken: 't', list: ['a'] }, apiKeys: ['k1'] }) as Record<string, unknown>;
    expect(tree['host']).toBe('qbit');
    expect(isSealed(tree['password'])).toBe(true);
    expect(isSealed((tree['nested'] as Record<string, unknown>)['botToken'])).toBe(true);
    expect((tree['nested'] as Record<string, unknown>)['list']).toEqual(['a']);
    expect(openTree(tree)).toEqual({ host: 'qbit', password: 'pw', nested: { botToken: 't', list: ['a'] }, apiKeys: ['k1'] });
  });

  it('drops values sealed with an unknown key and never touches the prototype', () => {
    setSealing(registerSecretKey(generateSecretKey(), { active: true }));
    const sealed = sealString('gone');
    resetSecretKeys();
    setSealing(registerSecretKey(generateSecretKey(), { active: true }));
    expect(openString(sealed)).toBeUndefined();
    // Dropped, so the schema default applies (a new API key, not a reset security section).
    expect(openTree({ apiKey: sealed, setupComplete: true })).toEqual({ setupComplete: true });
    const opened = openTree(JSON.parse('{"__proto__": {"polluted": true}, "a": 1}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(opened)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('secrets at rest', () => {
  it('seals plaintext secrets from before the upgrade, idempotently, and keeps them working', () => {
    const dir = tempDir();
    const d = db(dir);
    // Written before 0.24: no key yet, so stored in the clear.
    settingsService.setSection(d, 'metadata', { tmdbApiKey: 'tmdb-plain-1', language: 'en-US', region: 'US' });
    expect(raw(d, 'metadata')).toContain('tmdb-plain-1');

    const first = initSecretsAtRest({ configDir: dir, db: d, log, env: {} });
    expect(first).toMatchObject({ enabled: true, rewritten: 1 });
    expect(raw(d, 'metadata')).not.toContain('tmdb-plain-1');
    expect(raw(d, 'metadata')).toContain(SEALED_PREFIX);
    expect(settingsService.getSection(d, 'metadata').tmdbApiKey).toBe('tmdb-plain-1');
    if (POSIX) expect(statSync(join(dir, SECRET_KEY_FILE)).mode & 0o777).toBe(0o600);

    // A second start (same key file) has nothing to do.
    resetSecretKeys();
    expect(initSecretsAtRest({ configDir: dir, db: d, log, env: {} }).rewritten).toBe(0);
    expect(settingsService.getSection(d, 'metadata').tmdbApiKey).toBe('tmdb-plain-1');

    // New writes are sealed too.
    settingsService.setSection(d, 'metadata', { tmdbApiKey: 'tmdb-new-2', language: 'en-US', region: 'US' });
    expect(raw(d, 'metadata')).not.toContain('tmdb-new-2');
  });

  it('covers the settings store and the per-module secret columns', () => {
    const cols = sealedColumns().map((c) => `${c.table}.${c.column}`);
    for (const c of [
      'settings.value',
      'download_clients.settings',
      'indexers.settings',
      'indexer_proxies.password',
      'notifications.settings',
      'import_lists.settings',
      'user_two_factor.totp_secret',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('writes secrets back in the clear with ARCLIGHT_SECRETS_AT_REST=0 (downgrade path)', () => {
    const dir = tempDir();
    const d = db(dir);
    initSecretsAtRest({ configDir: dir, db: d, log, env: {} });
    settingsService.setSection(d, 'metadata', { tmdbApiKey: 'tmdb-3', language: 'en-US', region: 'US' });
    expect(raw(d, 'metadata')).not.toContain('tmdb-3');
    resetSecretKeys();
    const off = initSecretsAtRest({ configDir: dir, db: d, log, env: { ARCLIGHT_SECRETS_AT_REST: '0' } });
    expect(off).toMatchObject({ enabled: false, rewritten: 1 });
    expect(raw(d, 'metadata')).toContain('tmdb-3');
    settingsService.setSection(d, 'metadata', { tmdbApiKey: 'tmdb-4', language: 'en-US', region: 'US' });
    expect(raw(d, 'metadata')).toContain('tmdb-4');
  });

  it('keeps a security section usable when the key file is lost', () => {
    const dir = tempDir();
    const d = db(dir);
    initSecretsAtRest({ configDir: dir, db: d, log, env: {} });
    const security = settingsService.getSection(d, 'security');
    settingsService.setSection(d, 'security', { ...security, apiKey: 'a'.repeat(32), setupComplete: true } as typeof security);
    resetSecretKeys();
    rmSync(join(dir, SECRET_KEY_FILE));
    initSecretsAtRest({ configDir: dir, db: d, log, env: {} });
    const after = settingsService.getSection(d, 'security') as Record<string, unknown>;
    expect(after['apiKey']).not.toBe('a'.repeat(32));
    expect(after['setupComplete']).toBe(true);
  });

  it('replaces a damaged key file instead of failing to start', () => {
    const dir = tempDir();
    const d = db(dir);
    writeFileSync(join(dir, SECRET_KEY_FILE), 'not json');
    expect(initSecretsAtRest({ configDir: dir, db: d, log, env: {} }).enabled).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, SECRET_KEY_FILE), 'utf8'))).toMatchObject({ format: 'arclight-secret-keys', version: 1 });
  });
});

describe.skipIf(!POSIX)('hardenConfigDir', () => {
  it('makes Arclight files owner-only and leaves other files alone', () => {
    const dir = tempDir();
    const logs = join(dir, 'logs');
    const backups = join(dir, 'backups');
    mkdirSync(logs, { mode: 0o755 });
    mkdirSync(backups, { mode: 0o755 });
    for (const f of ['arclight.db', 'arclight.db-wal', 'arclight.db.pre-restore', SECRET_KEY_FILE, 'wg0.conf']) writeFileSync(join(dir, f), 'x');
    writeFileSync(join(logs, 'arclight.log'), 'x');
    writeFileSync(join(backups, 'arclight_manual_2026.10.25_04.00.00.zip'), 'x');
    chmodSync(dir, 0o755);
    for (const p of [join(dir, 'arclight.db'), join(dir, 'wg0.conf'), join(logs, 'arclight.log')]) chmodSync(p, 0o644);
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(hardenConfigDir({ configDir: dir, logDir: logs, dbPath: join(dir, 'arclight.db'), backupDir: backups, log })).toBeGreaterThan(0);
    expect(mode(dir)).toBe(0o700);
    expect(mode(logs)).toBe(0o700);
    expect(mode(backups)).toBe(0o700);
    for (const f of ['arclight.db', 'arclight.db-wal', 'arclight.db.pre-restore', SECRET_KEY_FILE]) expect(mode(join(dir, f))).toBe(0o600);
    expect(mode(join(logs, 'arclight.log'))).toBe(0o600);
    expect(mode(join(backups, 'arclight_manual_2026.10.25_04.00.00.zip'))).toBe(0o600);
    expect(mode(join(dir, 'wg0.conf'))).toBe(0o644);
    expect(hardenConfigDir({ configDir: dir, logDir: logs, dbPath: join(dir, 'arclight.db'), backupDir: backups, log })).toBe(0);
  });
});
