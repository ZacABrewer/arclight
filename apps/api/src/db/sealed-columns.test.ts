import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { users } from '../modules/auth/schema.js';
import { MobileService } from '../modules/mobile/service.js';
import { mobileDevices } from '../modules/mobile/schema.js';
import { wrappedShares } from '../modules/watch-stats/schema.js';
import { WrappedShares } from '../modules/watch-stats/shares.js';
import { shareTokenHash } from '../modules/watch-stats/token-hash.js';
import { openDatabase, type Db } from './index.js';
import { isSealed, resetSecretKeys, SEALED_PREFIX } from './secret-box.js';
import { initSecretsAtRest, sealedColumns } from './secret-keys.js';

// DATA-16 follow-up: users.settings (media-server access token), the mobile relay secret and the
// Year in review share token are sealed at rest like the other secrets.

const log = pino({ level: 'silent' });
const dirs: string[] = [];
const dbs: Db[] = [];

// Test values only (not real credentials).
const ACCESS_TOKEN = 'jf-access-token-plain-0001';
const RELAY_SECRET = 'relay-secret-plain-0002';
const SHARE_TOKEN = 'ShareTokenPlain0003abcd';

function setup(): { dir: string; d: Db } {
  const dir = mkdtempSync(join(tmpdir(), 'mt-sealed-cols-'));
  dirs.push(dir);
  const d = openDatabase(join(dir, 'arclight.db'));
  dbs.push(d);
  return { dir, d };
}

function fileText(d: Db, dir: string): string {
  d.$client.pragma('wal_checkpoint(TRUNCATE)');
  return readFileSync(join(dir, 'arclight.db')).toString('latin1');
}

/** Rows as an older version wrote them: plain SQL, no sealing, no token hash. */
function legacyRows(d: Db): void {
  const now = new Date().toISOString();
  const settings = JSON.stringify({
    locale: 'en',
    discordUserId: '1234',
    mediaServerLink: { kind: 'jellyfin', externalId: 'u1', username: 'ann', accessToken: ACCESS_TOKEN, linkedAt: now },
  });
  d.$client
    .prepare(
      `INSERT INTO users (id, username, username_key, password_hash, role, permissions, settings, created_at, updated_at) VALUES (1, 'ann', 'ann', 'x', 'user', 0, ?, ?, ?)`,
    )
    .run(settings, now, now);
  d.$client
    .prepare(
      `INSERT INTO mobile_devices (user_id, relay_device_id, relay_secret, platform, device_name, created_at, last_seen_at) VALUES (1, 'dev-1', ?, 'android', '', ?, ?)`,
    )
    .run(RELAY_SECRET, now, now);
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  d.$client
    .prepare(`INSERT INTO wrapped_shares (token, user_id, year, created_at, expires_at) VALUES (?, 1, 2026, ?, ?)`)
    .run(SHARE_TOKEN, now, expires);
}

function rawRow(d: Db, sql: string): string {
  return d.$client.prepare(sql).pluck().get() as string;
}

afterEach(() => {
  for (const d of dbs.splice(0)) d.$client.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetSecretKeys();
});

describe('sealed users.settings, relay secret and share token (DATA-16)', () => {
  it('declares the columns sealed', () => {
    const cols = sealedColumns().map((c) => `${c.table}.${c.column}`);
    for (const c of ['users.settings', 'mobile_devices.relay_secret', 'wrapped_shares.token']) expect(cols).toContain(c);
  });

  it('reads plaintext rows from before the upgrade, then seals them in place', () => {
    const { dir, d } = setup();
    legacyRows(d);

    // Before the backfill (no key yet): plaintext reads as is, legacy share has no hash.
    const before = d.select().from(users).where(eq(users.id, 1)).get();
    expect((before?.settings as Record<string, { accessToken?: string }>)['mediaServerLink']?.accessToken).toBe(ACCESS_TOKEN);
    expect(d.select().from(mobileDevices).get()?.relaySecret).toBe(RELAY_SECRET);
    expect(d.select().from(wrappedShares).get()?.tokenHash).toBeNull();

    const res = initSecretsAtRest({ configDir: dir, db: d, log, env: {} });
    expect(res.enabled).toBe(true);
    expect(res.rewritten).toBeGreaterThanOrEqual(3);

    const userRaw = rawRow(d, 'SELECT settings FROM users WHERE id = 1');
    expect(userRaw).not.toContain(ACCESS_TOKEN);
    expect(userRaw).toContain(SEALED_PREFIX);
    // Only the secret is sealed: non-secret keys stay queryable (discord-bot uses json_extract).
    expect(rawRow(d, `SELECT json_extract(settings, '$.discordUserId') FROM users WHERE id = 1`)).toBe('1234');
    expect(isSealed(rawRow(d, 'SELECT relay_secret FROM mobile_devices'))).toBe(true);
    expect(isSealed(rawRow(d, 'SELECT token FROM wrapped_shares'))).toBe(true);
    expect(rawRow(d, 'SELECT token_hash FROM wrapped_shares')).toBe(shareTokenHash(SHARE_TOKEN));

    const text = fileText(d, dir);
    for (const secret of [ACCESS_TOKEN, RELAY_SECRET, SHARE_TOKEN]) expect(text).not.toContain(secret);

    // Values still read back in the clear, and the old share link still answers.
    const after = d.select().from(users).where(eq(users.id, 1)).get();
    expect((after?.settings as Record<string, { accessToken?: string }>)['mediaServerLink']?.accessToken).toBe(ACCESS_TOKEN);
    expect(d.select().from(mobileDevices).get()?.relaySecret).toBe(RELAY_SECRET);
    const shares = new WrappedShares(d, () => new Date(), () => '');
    const resolved = shares.resolve(SHARE_TOKEN);
    expect(resolved?.token).toBe(SHARE_TOKEN);
    expect(shares.view(resolved!).path).toContain(SHARE_TOKEN);

    // Idempotent: a second start has nothing to do.
    resetSecretKeys();
    expect(initSecretsAtRest({ configDir: dir, db: d, log, env: {} }).rewritten).toBe(0);
  });

  it('seals new writes, including the relay upsert and new share links, and round-trips them', () => {
    const { dir, d } = setup();
    initSecretsAtRest({ configDir: dir, db: d, log, env: {} });
    const now = new Date().toISOString();
    d.insert(users)
      .values({ id: 1, username: 'bo', usernameKey: 'bo', passwordHash: 'x', role: 'user', settings: { mediaServerLink: { accessToken: ACCESS_TOKEN } }, createdAt: now, updatedAt: now })
      .run();
    expect(rawRow(d, 'SELECT settings FROM users WHERE id = 1')).not.toContain(ACCESS_TOKEN);

    const mobile = new MobileService({ db: d, relayUrl: 'http://127.0.0.1:9', enabled: true, serverUrl: () => '' });
    mobile.register(1, { relayDeviceId: 'dev-2', relaySecret: RELAY_SECRET, platform: 'ios', deviceName: 'phone' });
    expect(isSealed(rawRow(d, 'SELECT relay_secret FROM mobile_devices'))).toBe(true);
    // Re-registration goes through onConflictDoUpdate: still sealed, new value.
    mobile.register(1, { relayDeviceId: 'dev-2', relaySecret: `${RELAY_SECRET}-b`, platform: 'ios', deviceName: 'phone' });
    expect(isSealed(rawRow(d, 'SELECT relay_secret FROM mobile_devices'))).toBe(true);
    expect(d.select().from(mobileDevices).all().map((r) => r.relaySecret)).toEqual([`${RELAY_SECRET}-b`]);

    const shares = new WrappedShares(d, () => new Date(), () => 'https://example.test');
    const share = shares.create(1, 2026, 7);
    const token = share.path.split('/').pop()!;
    expect(isSealed(rawRow(d, 'SELECT token FROM wrapped_shares'))).toBe(true);
    expect(shares.resolve(token)?.id).toBe(share.id);
    expect(shares.list(1)[0]?.url).toBe(`https://example.test${share.path}`);
    expect(shares.resolve(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).toBeUndefined();
    expect(fileText(d, dir)).not.toContain(token);
  });

  it('stores plaintext with ARCLIGHT_SECRETS_AT_REST=0 and opens sealed rows again', () => {
    const { dir, d } = setup();
    legacyRows(d);
    initSecretsAtRest({ configDir: dir, db: d, log, env: {} });
    expect(rawRow(d, 'SELECT relay_secret FROM mobile_devices')).not.toBe(RELAY_SECRET);

    resetSecretKeys();
    const off = initSecretsAtRest({ configDir: dir, db: d, log, env: { ARCLIGHT_SECRETS_AT_REST: '0' } });
    expect(off.enabled).toBe(false);
    expect(rawRow(d, 'SELECT settings FROM users WHERE id = 1')).toContain(ACCESS_TOKEN);
    expect(rawRow(d, 'SELECT relay_secret FROM mobile_devices')).toBe(RELAY_SECRET);
    expect(rawRow(d, 'SELECT token FROM wrapped_shares')).toBe(SHARE_TOKEN);

    const shares = new WrappedShares(d, () => new Date(), () => '');
    const share = shares.create(1, 2025, 7);
    const token = share.path.split('/').pop()!;
    expect(rawRow(d, `SELECT token FROM wrapped_shares WHERE id = ${share.id}`)).toBe(token);
    expect(shares.resolve(token)?.id).toBe(share.id);
  });
});
