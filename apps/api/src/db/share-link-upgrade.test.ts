import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { WrappedShares } from '../modules/watch-stats/shares.js';
import { shareTokenHash } from '../modules/watch-stats/token-hash.js';
import { migrationsFolder, openDatabase, type Db } from './index.js';
import { resetSecretKeys } from './secret-box.js';
import { initSecretsAtRest } from './secret-keys.js';

// A Year in review link created on 0.23 (before wrapped_shares.token_hash existed) must keep
// answering after the upgrade: the 0.24 migration adds the column empty and the startup backfill
// (initSecretsAtRest -> backfillShareTokenHashes) fills it.

const log = pino({ level: 'silent' });
const dirs: string[] = [];
const open: { close(): void }[] = [];
// Test value only (not a real credential).
const SHARE_TOKEN = 'PreUpgradeShareToken0001';
/** The first migration of 0.24; everything before it is the 0.23 schema. */
const FIRST_0_24 = 35;

/** A copy of the shipped migrations with the 0.24 ones removed. */
function migrations023(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mt-migr-023-'));
  dirs.push(dir);
  cpSync(migrationsFolder(), dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
  const dropped = journal.entries.filter((e) => e.idx >= FIRST_0_24).map((e) => e.tag);
  expect(dropped.length).toBeGreaterThan(0);
  journal.entries = journal.entries.filter((e) => e.idx < FIRST_0_24);
  writeFileSync(journalPath, JSON.stringify(journal));
  for (const f of readdirSync(dir)) if (dropped.some((tag) => f === `${tag}.sql`)) rmSync(join(dir, f));
  return dir;
}

afterEach(() => {
  for (const c of open.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetSecretKeys();
});

describe('share links across the 0.24 upgrade', () => {
  it('a link created before the migration still resolves after it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-share-upgrade-'));
    dirs.push(dir);
    const dbPath = join(dir, 'arclight.db');

    // 0.23: schema without token_hash, link stored as plain token.
    const old = new Database(dbPath);
    migrate(drizzle(old), { migrationsFolder: migrations023() });
    const cols = (old.prepare(`PRAGMA table_info(wrapped_shares)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('token');
    expect(cols).not.toContain('token_hash');
    const now = new Date().toISOString();
    old.prepare(`INSERT INTO users (id, username, username_key, password_hash, role, permissions, settings, created_at, updated_at) VALUES (1, 'ann', 'ann', 'x', 'user', 0, '{}', ?, ?)`).run(now, now);
    old.prepare(`INSERT INTO wrapped_shares (token, user_id, year, created_at, expires_at) VALUES (?, 1, 2026, ?, ?)`).run(SHARE_TOKEN, now, new Date(Date.now() + 86_400_000).toISOString());
    old.close();

    // 0.24 start: full migrations, then the startup backfill.
    const d: Db = openDatabase(dbPath);
    open.push(d.$client);
    expect(d.$client.prepare(`SELECT token_hash FROM wrapped_shares`).pluck().get()).toBeNull();
    initSecretsAtRest({ configDir: dir, db: d, log, env: {} });
    expect(d.$client.prepare(`SELECT token_hash FROM wrapped_shares`).pluck().get()).toBe(shareTokenHash(SHARE_TOKEN));

    const shares = new WrappedShares(d, () => new Date(), () => '');
    expect(shares.resolve(SHARE_TOKEN)?.token).toBe(SHARE_TOKEN);

    // Idempotent: a second start changes nothing and the link still answers.
    resetSecretKeys();
    initSecretsAtRest({ configDir: dir, db: d, log, env: {} });
    expect(d.$client.prepare(`SELECT count(*) FROM wrapped_shares WHERE token_hash IS NOT NULL`).pluck().get()).toBe(1);
    expect(shares.resolve(SHARE_TOKEN)?.token).toBe(SHARE_TOKEN);
  });
});
