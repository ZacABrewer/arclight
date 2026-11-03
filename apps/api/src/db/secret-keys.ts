import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Logger } from 'pino';
import { PRIVATE_FILE_MODE } from '../file-modes.js';
import { isSecretKey } from '../modules/config-export/secrets.js';
import type { Db } from './index.js';
import * as schema from './schema.js';
import {
  generateSecretKey,
  isSealed,
  keyId,
  onUnreadableSecret,
  openString,
  openTree,
  registerSecretKey,
  sealedJsonToDriver,
  sealedTextToDriver,
  sealString,
  sealTree,
  setSealing,
  treeHasSealed,
} from './secret-box.js';

// The key file behind secret-box.ts and the startup steps around it: load or create the key,
// then bring every stored secret to the wanted state (sealed, or opened again when encryption at
// rest is turned off with ARCLIGHT_SECRETS_AT_REST=0, e.g. before a downgrade).
//
// `secrets.key` lives in the config directory (mode 0600). It is a small JSON keyring so a restore
// can merge the archive's key in without losing the current one: every key ever used stays
// readable, the `active` one seals new values.

export const SECRET_KEY_FILE = 'secrets.key';
const FORMAT = 'arclight-secret-keys';

export interface KeyFile {
  active: string;
  keys: Map<string, Buffer>;
}

export function secretKeyPath(configDir: string): string {
  return join(configDir, SECRET_KEY_FILE);
}

/** Parses a key file; throws on anything that is not a well-formed one. */
export function parseKeyFile(text: string): KeyFile {
  const data = JSON.parse(text) as { format?: unknown; version?: unknown; active?: unknown; keys?: unknown };
  if (data.format !== FORMAT || data.version !== 1) throw new Error('not an Arclight key file');
  if (typeof data.keys !== 'object' || data.keys === null || Array.isArray(data.keys)) throw new Error('key file has no keys');
  const keys = new Map<string, Buffer>();
  for (const [kid, value] of Object.entries(data.keys as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error('bad key entry');
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || keyId(key) !== kid) throw new Error(`key ${kid} does not match its id`);
    keys.set(kid, key);
  }
  if (typeof data.active !== 'string' || !keys.has(data.active)) throw new Error('key file has no active key');
  return { active: data.active, keys };
}

export function serializeKeyFile(file: KeyFile): string {
  const keys = Object.fromEntries([...file.keys].map(([kid, key]) => [kid, key.toString('base64')]));
  return `${JSON.stringify({ format: FORMAT, version: 1, active: file.active, keys }, null, 2)}\n`;
}

/** Atomic write with mode 0600 (the temp file is created with that mode, never readable by others). */
export function writeKeyFile(path: string, file: KeyFile): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, serializeKeyFile(file), { mode: PRIVATE_FILE_MODE });
  if (process.platform !== 'win32') chmodSync(tmp, PRIVATE_FILE_MODE);
  renameSync(tmp, path);
}

export function readKeyFile(path: string): KeyFile | null {
  if (!existsSync(path)) return null;
  return parseKeyFile(readFileSync(path, 'utf8'));
}

/**
 * Loads `<configDir>/secrets.key` into the process keyring, creating it on first start. A damaged
 * file is moved aside (never overwritten) and a new key is made; values sealed with the old key
 * then read as unset and the log says so.
 */
export function loadSecretKeys(configDir: string, log?: Logger): KeyFile {
  const path = secretKeyPath(configDir);
  let file: KeyFile | null = null;
  try {
    file = readKeyFile(path);
  } catch (err) {
    const aside = `${path}.damaged-${Date.now()}`;
    renameSync(path, aside);
    log?.error({ err, movedTo: aside }, 'secret key file is damaged; created a new one. Secrets sealed with the old key must be entered again');
  }
  if (!file) {
    const key = generateSecretKey();
    file = { active: keyId(key), keys: new Map([[keyId(key), key]]) };
    writeKeyFile(path, file);
    log?.info({ file: path }, 'created the secret key file');
  }
  for (const key of file.keys.values()) registerSecretKey(key);
  return file;
}

/**
 * A restore brings the archive's key file: add its keys to ours (file and process keyring) so the
 * restored database can be read right away. Our active key stays active; with no key file of our
 * own yet, the archive's becomes ours. Returns how many keys were new.
 */
export function mergeKeyFile(configDir: string, incomingText: string): number {
  const incoming = parseKeyFile(incomingText);
  const path = secretKeyPath(configDir);
  let current: KeyFile | null = null;
  try {
    current = readKeyFile(path);
  } catch {
    current = null;
  }
  const merged: KeyFile = current ?? { active: incoming.active, keys: new Map() };
  let added = 0;
  for (const [kid, key] of incoming.keys) {
    if (!merged.keys.has(kid)) added++;
    merged.keys.set(kid, key);
  }
  writeKeyFile(path, merged);
  for (const key of merged.keys.values()) registerSecretKey(key);
  return added;
}

interface SealedColumn {
  table: string;
  column: string;
  kind: 'json' | 'text';
}

/** Every column declared with sealedJson / sealedText in the Drizzle schema. */
export function sealedColumns(): SealedColumn[] {
  const out: SealedColumn[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    for (const col of Object.values(getTableColumns(value))) {
      const mapTo = (col as { mapTo?: unknown }).mapTo;
      if (mapTo === sealedJsonToDriver) out.push({ table: getTableName(value), column: col.name, kind: 'json' });
      else if (mapTo === sealedTextToDriver) out.push({ table: getTableName(value), column: col.name, kind: 'text' });
    }
  }
  return out;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Brings every stored secret to the wanted state, idempotently: `seal` seals what is still plain
 * (values from before 0.24, or written while sealing was off), `open` writes sealed values back in
 * the clear (values whose key is missing are left as they are). Settings rows whose value is a
 * single string under a secret-looking key (the calendar ICS token) are sealed whole. Returns the
 * number of rows rewritten.
 */
export function backfillSecrets(db: Db, mode: 'seal' | 'open'): number {
  const sqlite = db.$client;
  let changed = 0;
  const run = sqlite.transaction(() => {
    for (const { table, column, kind } of sealedColumns()) {
      const isSettings = table === 'settings';
      const rows = sqlite
        .prepare(`SELECT rowid AS rid, ${quoteIdent(column)} AS v${isSettings ? ', key AS k' : ''} FROM ${quoteIdent(table)}`)
        .all() as Array<{ rid: number; v: string | null; k?: string }>;
      const update = sqlite.prepare(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ? WHERE rowid = ?`);
      for (const row of rows) {
        if (row.v === null || row.v === '') continue;
        let next: string | null = null;
        if (kind === 'text') {
          if (mode === 'seal' && !isSealed(row.v)) next = sealString(row.v);
          else if (mode === 'open' && isSealed(row.v)) next = openString(row.v) ?? null;
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.v);
          } catch {
            continue;
          }
          if (mode === 'seal') {
            next = JSON.stringify(sealTree(parsed, isSettings && row.k !== undefined && isSecretKey(row.k)));
          } else if (treeHasSealed(parsed)) {
            const opened = openTree(parsed);
            // Something could not be opened (key missing): keep the row rather than lose the value.
            next = JSON.stringify(opened) === JSON.stringify(parsed) || !readableTree(parsed) ? null : JSON.stringify(opened);
          }
        }
        if (next !== null && next !== row.v) {
          update.run(next, row.rid);
          changed++;
        }
      }
    }
  });
  run();
  return changed;
}

function readableTree(value: unknown): boolean {
  if (isSealed(value)) return openString(value) !== undefined;
  if (Array.isArray(value)) return value.every(readableTree);
  if (typeof value === 'object' && value !== null) return Object.values(value).every(readableTree);
  return true;
}

export interface SecretsAtRestResult {
  enabled: boolean;
  activeKey: string | null;
  rewritten: number;
}

/**
 * Startup: load the key file, turn sealing on (or off with ARCLIGHT_SECRETS_AT_REST=0) and run the
 * backfill. Call after the database is open and migrated, before modules read settings.
 */
export function initSecretsAtRest(opts: { configDir: string; db: Db; log: Logger; env?: NodeJS.ProcessEnv }): SecretsAtRestResult {
  const env = opts.env ?? process.env;
  const enabled = env['ARCLIGHT_SECRETS_AT_REST'] !== '0';
  onUnreadableSecret((kid) =>
    opts.log.warn({ key: kid }, `a stored secret was sealed with a key that is not in ${SECRET_KEY_FILE}; it reads as unset. Enter it again, or restore the key file`),
  );
  const file = loadSecretKeys(opts.configDir, opts.log);
  setSealing(enabled ? file.active : null);
  const rewritten = backfillSecrets(opts.db, enabled ? 'seal' : 'open');
  if (rewritten > 0) {
    opts.log.info({ rows: rewritten }, enabled ? 'sealed stored secrets (encryption at rest)' : 'stored secrets written back in the clear (ARCLIGHT_SECRETS_AT_REST=0)');
  }
  return { enabled, activeKey: enabled ? file.active : null, rewritten };
}
