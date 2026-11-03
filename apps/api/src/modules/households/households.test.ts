import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import { HOUSEHOLD_PROFILES_MAX, Permission, type ContentRestrictions } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import { openDatabase, type Db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor, SESSION_COOKIE } from '../auth/index.js';
import { UserApiKeyService } from '../auth/api-keys.js';
import { combineRestrictions } from '../requests/certification.js';
import { setSection } from '../settings/service.js';
import { ProgressStore } from '../playback/progress.js';
import { runHouseholdBackfill } from './backfill.js';
import { FRESH_CREDENTIAL_MS, HouseholdService, householdsFor, PIN_LOCK_BASE_MS, PIN_LOCK_MAX_MS, PIN_MAX_FAILURES, pinLockMs } from './service.js';

// Household profiles over HTTP and in the service: the owner profile and backfill, managing
// profiles, selecting (PIN rule, lockout, fresh-credential exception, credential kinds), and
// per-profile isolation of the player's state.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };
const KIDS: ContentRestrictions = { maxCertification: { movie: 'PG', tv: 'TV-PG' }, hideAdultContent: true };

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
  clock: { t: number };
}
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.app.close();
});

async function harness(): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  const clock = { t: Date.now() };
  // The first call creates the per-db service: give it the test clock before the app does.
  householdsFor(db, { now: () => new Date(clock.t) });
  let ctx: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), { probe: false, onContext: (c) => (ctx = c) });
  await app.ready();
  setSection(db, 'player', { enabled: true, video: true });
  const h = { app, ctx: ctx!, db, clock };
  open.push(h);
  return h;
}

let n = 0;
async function account(h: Harness, opts: { role?: 'user' | 'admin' } = {}) {
  const auth = authServiceFor(h.ctx);
  const username = `hh${++n}${Math.random().toString(36).slice(2, 6)}`;
  const user = await auth.createUser({ username, password: 'password1', role: opts.role ?? 'user', settings: { player: { allowed: true } } });
  const session = () => `${SESSION_COOKIE}=${auth.createSession(user.id).token}`;
  return { id: user.id, username, cookie: session(), session };
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (h: Harness, method: Method, url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function addProfile(h: Harness, cookie: string, body: object) {
  const res = await call(h, 'POST', '/api/v1/households/profiles', cookie, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: number; isOwner: boolean; hasPin: boolean };
}

async function select(h: Harness, cookie: string, id: number, pin?: string, headers: Record<string, string> = {}) {
  return call(h, 'POST', `/api/v1/households/profiles/${id}/select`, cookie, pin === undefined ? {} : { pin }, headers);
}

// ------------------------------------------------------------------------------------ backfill

describe('owner profiles and the backfill', () => {
  it('every user gets exactly one owner profile and every per-user row a profile id; a second run changes nothing', async () => {
    const db = await createTestDb();
    const at = '2026-01-01T00:00:00.000Z';
    // Users inserted directly (as before 0.23.0): no owner profile yet.
    const u1 = { id: seedAdmin(db, 'alpha') };
    db.update(schema.users).set({ displayName: 'Alpha Person' }).where(eq(schema.users.id, u1.id)).run();
    const u2 = { id: seedAdmin(db, 'beta') };
    for (const u of [u1, u2]) {
      db.insert(schema.playbackProgress).values({ userId: u.id, itemKey: 'track:1', positionMs: 1000, durationMs: 5000, played: false, updatedAt: at } as never).run();
      db.insert(schema.playbackPlays).values({ userId: u.id, itemKey: 'track:1', at }).run();
      db.insert(schema.playbackQueue).values({ userId: u.id, queue: { items: [], index: 0 }, updatedAt: at } as never).run();
    }
    const first = runHouseholdBackfill(db);
    expect(first.profiles).toBe(2);
    expect(first.rows).toBe(4);
    expect(first.queues).toBe(2);
    const owners = db.select().from(schema.householdProfiles).all();
    expect(owners.map((o) => [o.userId, o.isOwner, o.name, o.initial])).toEqual([
      [u1.id, true, 'Alpha Person', 'A'],
      [u2.id, true, 'beta', 'B'],
    ]);
    expect(db.select().from(schema.playbackProgress).where(isNull(schema.playbackProgress.profileId)).all()).toHaveLength(0);
    expect(db.select().from(schema.playbackPlays).where(isNull(schema.playbackPlays.profileId)).all()).toHaveLength(0);
    for (const row of db.select().from(schema.playbackProgress).all()) {
      expect(row.profileId).toBe(owners.find((o) => o.userId === row.userId)!.id);
    }
    expect(db.select().from(schema.profilePlaybackQueue).all()).toHaveLength(2);
    expect(runHouseholdBackfill(db)).toEqual({ profiles: 0, rows: 0, queues: 0 });
    expect(db.select().from(schema.householdProfiles).all()).toHaveLength(2);
  });

  it('runs on the real migrations, and deleting a profile removes its data and moves its sessions to the owner', async () => {
    const db = openDatabase(':memory:');
    const service = householdsFor(db);
    const at = new Date().toISOString();
    const user = { id: seedAdmin(db, 'gamma') };
    expect(runHouseholdBackfill(db).profiles).toBe(1);
    const kid = await service.create(user.id, { name: 'Kid', contentRestrictions: KIDS });
    const owner = service.owner(user.id)!;
    const progress = new ProgressStore(db);
    progress.report({ userId: user.id, profileId: kid.id, isOwnerProfile: false }, 'track:9', { positionMs: 10_000, durationMs: 100_000 } as never, Date.now());
    progress.report({ userId: user.id, profileId: owner.id, isOwnerProfile: true }, 'track:9', { positionMs: 20_000, durationMs: 100_000 } as never, Date.now());
    db.insert(schema.profileMyList).values({ profileId: kid.id, itemKey: 'movie:1', addedAt: at }).run();
    const kidSession = db.insert(schema.sessions).values({ tokenHash: 'x'.repeat(64), userId: user.id, profileId: kid.id, createdAt: at, lastSeenAt: at, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }).returning().get();

    service.remove(user.id, kid.id);
    expect(db.select().from(schema.householdProfiles).where(eq(schema.householdProfiles.id, kid.id)).all()).toHaveLength(0);
    expect(db.select().from(schema.profileMyList).all()).toHaveLength(0);
    const left = db.select().from(schema.playbackProgress).all();
    expect(left.map((r) => r.profileId)).toEqual([owner.id]);
    expect(db.select().from(schema.sessions).where(eq(schema.sessions.id, kidSession.id)).get()?.profileId).toBeNull();
    expect(() => service.remove(user.id, owner.id)).toThrow('owner-immutable');
  });

  it('a user created through the auth service starts with its owner profile', async () => {
    const h = await harness();
    const a = await account(h);
    const res = await call(h, 'GET', '/api/v1/households/profiles', a.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0]).toMatchObject({ isOwner: true, hasPin: false, contentRestrictions: null });
    expect(body.activeProfileId).toBe(body.profiles[0].id);
    const me = (await call(h, 'GET', '/api/v1/auth/me', a.cookie)).json();
    expect(me.activeProfile).toMatchObject({ id: body.profiles[0].id, isOwner: true });
  });
});

// ------------------------------------------------------------------------------------ managing

describe('managing profiles', () => {
  it('creates, edits and deletes profiles; never returns a PIN; the owner stays unrestricted and undeletable', async () => {
    const h = await harness();
    const a = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Kids', contentRestrictions: KIDS, pin: '1234' });
    expect(kid).toMatchObject({ isOwner: false, hasPin: true, name: 'Kids', initial: 'K', contentRestrictions: KIDS });
    expect(JSON.stringify(kid)).not.toContain('1234');
    const list = (await call(h, 'GET', '/api/v1/households/profiles', a.cookie)).json();
    expect(list.profiles.map((p: { name: string }) => p.name)).toHaveLength(2);
    const owner = list.profiles.find((p: { isOwner: boolean }) => p.isOwner);

    const edited = await call(h, 'PATCH', `/api/v1/households/profiles/${kid.id}`, a.cookie, { name: 'Little ones', pin: null });
    expect(edited.json()).toMatchObject({ name: 'Little ones', initial: 'L', hasPin: false });
    expect((await call(h, 'PATCH', `/api/v1/households/profiles/${owner.id}`, a.cookie, { contentRestrictions: KIDS })).json()).toEqual({ error: 'owner-immutable' });
    expect((await call(h, 'DELETE', `/api/v1/households/profiles/${owner.id}`, a.cookie)).statusCode).toBe(400);
    expect((await call(h, 'DELETE', `/api/v1/households/profiles/${kid.id}`, a.cookie)).statusCode).toBe(204);
    expect((await call(h, 'DELETE', `/api/v1/households/profiles/${kid.id}`, a.cookie)).statusCode).toBe(404);
    // The audit log names the profile, never the PIN.
    const entries = JSON.stringify(h.db.select().from(schema.auditEvents).all());
    expect(entries).toContain('household.profile.create');
    expect(entries).not.toContain('1234');
  });

  it(`stops at ${HOUSEHOLD_PROFILES_MAX} profiles`, async () => {
    const h = await harness();
    const a = await account(h);
    for (let i = 1; i < HOUSEHOLD_PROFILES_MAX; i++) await addProfile(h, a.cookie, { name: `P${i}` });
    const res = await call(h, 'POST', '/api/v1/households/profiles', a.cookie, { name: 'One too many' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'limit-reached' });
  });

  it('profiles of another account are not found', async () => {
    const h = await harness();
    const a = await account(h);
    const b = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Kids' });
    expect((await call(h, 'PATCH', `/api/v1/households/profiles/${kid.id}`, b.cookie, { name: 'Mine' })).statusCode).toBe(404);
    expect((await call(h, 'DELETE', `/api/v1/households/profiles/${kid.id}`, b.cookie)).statusCode).toBe(404);
    expect((await select(h, b.cookie, kid.id)).statusCode).toBe(404);
  });

  it('a non-owner profile cannot manage profiles', async () => {
    const h = await harness();
    const a = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Kids' });
    expect((await select(h, a.cookie, kid.id)).statusCode).toBe(200);
    // POST/PATCH/DELETE are outside the profile allowlist: the hook refuses before the route.
    expect((await call(h, 'POST', '/api/v1/households/profiles', a.cookie, { name: 'Sneaky' })).json()).toMatchObject({ error: 'profile-forbidden' });
    expect((await call(h, 'PATCH', `/api/v1/households/profiles/${kid.id}`, a.cookie, { contentRestrictions: null })).json()).toMatchObject({ error: 'profile-forbidden' });
    expect((await call(h, 'DELETE', `/api/v1/households/profiles/${kid.id}`, a.cookie)).statusCode).toBe(403);
    // The list still answers, without management rights.
    const list = await call(h, 'GET', '/api/v1/households/profiles', a.cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json().activeProfileId).toBe(kid.id);
  });

  it('admins manage any user’s profiles from the Users page; non-admins cannot', async () => {
    const h = await harness();
    const admin = await account(h, { role: 'admin' });
    const a = await account(h);
    const created = await call(h, 'POST', `/api/v1/users/${a.id}/profiles`, admin.cookie, { name: 'Teen', pin: '4321' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await call(h, 'GET', `/api/v1/users/${a.id}/profiles`, admin.cookie)).json().profiles).toHaveLength(2);
    expect((await call(h, 'PATCH', `/api/v1/users/${a.id}/profiles/${id}`, admin.cookie, { contentRestrictions: KIDS })).json().contentRestrictions).toEqual(KIDS);
    expect((await call(h, 'GET', `/api/v1/users/${a.id}/profiles`, a.cookie)).statusCode).toBe(403);
    expect((await call(h, 'GET', `/api/v1/users/999999/profiles`, admin.cookie)).statusCode).toBe(404);
    expect((await call(h, 'DELETE', `/api/v1/users/${admin.id}/profiles/${id}`, admin.cookie)).statusCode).toBe(404);
    expect((await call(h, 'DELETE', `/api/v1/users/${a.id}/profiles/${id}`, admin.cookie)).statusCode).toBe(204);
  });
});

// ------------------------------------------------------------------------------------ selecting

describe('selecting a profile', () => {
  it('takes effect on the next request; selecting the owner stores null', async () => {
    const h = await harness();
    const a = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Kids', contentRestrictions: KIDS });
    const res = await select(h, a.cookie, kid.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().activeProfile).toMatchObject({ id: kid.id });
    expect((await call(h, 'GET', '/api/v1/auth/me', a.cookie)).json().activeProfile).toMatchObject({ id: kid.id, isOwner: false });
    const owner = h.db.select().from(schema.householdProfiles).where(eq(schema.householdProfiles.userId, a.id)).all().find((p) => p.isOwner)!;
    expect((await select(h, a.cookie, owner.id)).statusCode).toBe(200);
    const token = a.cookie.split('=')[1]!;
    const sessions = h.db.select().from(schema.sessions).where(eq(schema.sessions.userId, a.id)).all();
    expect(sessions.every((s) => s.profileId === null)).toBe(true);
    expect(token.length).toBeGreaterThan(0);
    expect((await call(h, 'GET', '/api/v1/auth/me', a.cookie)).json().activeProfile.isOwner).toBe(true);
  });

  it('needs the PIN; wrong PINs lock after five tries with Retry-After', async () => {
    const h = await harness();
    const a = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Locked', pin: '2468' });
    expect((await select(h, a.cookie, kid.id)).json()).toEqual({ error: 'pin-required' });
    for (let i = 1; i <= PIN_MAX_FAILURES; i++) {
      const res = await select(h, a.cookie, kid.id, '0000');
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'pin-wrong' });
    }
    // Locked: even the right PIN is refused until the window passes.
    const locked = await select(h, a.cookie, kid.id, '2468');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toBe('pin-locked');
    expect(locked.json().retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    // The lock belongs to the profile: a new sign-in is locked out too.
    expect((await select(h, a.session(), kid.id, '2468')).statusCode).toBe(429);
    // Every failure and the lockout are audited with the profile id and never the PIN.
    const audit = h.db.select().from(schema.auditEvents).all();
    expect(audit.filter((e) => e.action === 'household.profile.pin-wrong')).toHaveLength(PIN_MAX_FAILURES);
    expect(audit.some((e) => e.action === 'household.profile.pin-locked')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('2468');
    // After the window: the right PIN works again.
    h.clock.t += 16 * 60_000;
    expect((await select(h, a.cookie, kid.id, '2468')).statusCode).toBe(200);
  });

  it('keeps the lockout across sign-ins and restarts, escalates it, and the owner lifts it by resetting the PIN', async () => {
    const h = await harness();
    const a = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Escalate', pin: '1111' });
    const fail = async (n: number) => {
      for (let i = 0; i < n; i++) expect((await select(h, a.session(), kid.id, '0000')).statusCode).toBe(401);
    };
    // Failures from different sign-ins add up on the profile.
    await fail(PIN_MAX_FAILURES - 1);
    // A fresh service (a restart) reads the count from the database.
    const restarted = new HouseholdService({ db: h.db, now: () => new Date(h.clock.t) });
    const cred = { via: 'session' as const, userId: a.id, sessionId: 999_999, activeProfileId: 0 };
    await expect(restarted.select(cred, kid.id, '0000')).rejects.toThrow('pin-wrong');
    let res = await select(h, a.session(), kid.id, '1111');
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBe(PIN_LOCK_BASE_MS / 1000);
    // The second lockout lasts twice as long.
    h.clock.t += PIN_LOCK_BASE_MS + 1000;
    await fail(PIN_MAX_FAILURES);
    res = await select(h, a.session(), kid.id, '1111');
    expect(Number(res.headers['retry-after'])).toBe((2 * PIN_LOCK_BASE_MS) / 1000);
    expect(pinLockMs(0)).toBe(PIN_LOCK_BASE_MS);
    expect(pinLockMs(20)).toBe(PIN_LOCK_MAX_MS);
    // The owner sets a new PIN: the lock is gone and the escalation starts over.
    expect((await call(h, 'PATCH', `/api/v1/households/profiles/${kid.id}`, a.cookie, { pin: '2222' })).statusCode).toBe(200);
    const row = h.db.select().from(schema.householdProfiles).where(eq(schema.householdProfiles.id, kid.id)).get()!;
    expect([row.failedPinAttempts, row.pinLockedUntil, row.pinLockouts]).toEqual([0, null, 0]);
    expect((await select(h, a.session(), kid.id, '2222')).statusCode).toBe(200);
  });

  it('counts PIN checks still running, so a burst cannot get more than five guesses in', async () => {
    const h = await harness();
    const a = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Burst', pin: '4444' });
    const results = await Promise.all(Array.from({ length: 12 }, () => select(h, a.session(), kid.id, '0000')));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(PIN_MAX_FAILURES);
    expect(codes.filter((c) => c === 429)).toHaveLength(12 - PIN_MAX_FAILURES);
  });

  it('a right PIN resets the count of wrong ones', async () => {
    const h = await harness();
    const a = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Reset', pin: '3333' });
    for (let i = 0; i < PIN_MAX_FAILURES - 1; i++) await select(h, a.session(), kid.id, '0000');
    expect((await select(h, a.session(), kid.id, '3333')).statusCode).toBe(200);
    for (let i = 0; i < PIN_MAX_FAILURES - 1; i++) expect((await select(h, a.session(), kid.id, '0000')).statusCode).toBe(401);
    expect((await select(h, a.session(), kid.id, '3333')).statusCode).toBe(200);
  });

  it('a fresh credential may re-select the PIN profile it is on without the PIN; an older one may not', async () => {
    const h = await harness();
    const a = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Pinned', pin: '1357' });
    const cookie = a.session();
    h.clock.t = Date.now() + 1000;
    expect((await select(h, cookie, kid.id, '1357')).statusCode).toBe(200);
    // Re-selecting the active profile from the picker, inside the 10 minutes: no PIN.
    expect((await select(h, cookie, kid.id)).statusCode).toBe(200);
    // The exception is only for the profile it is on.
    const other = await addProfile(h, a.session(), { name: 'Other', pin: '9999' });
    expect((await select(h, cookie, other.id)).json()).toEqual({ error: 'pin-required' });
    h.clock.t += FRESH_CREDENTIAL_MS + 1000;
    expect((await select(h, cookie, kid.id)).json()).toEqual({ error: 'pin-required' });
  });

  it('only sessions and app devices can select: Basic and API keys get 409 unsupported-credential', async () => {
    const h = await harness();
    const a = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Kids' });
    const auth = authServiceFor(h.ctx);
    auth.updateAuthSettings({ ...auth.authSettings(), method: 'basic' });
    const basic = `Basic ${Buffer.from(`${a.username}:password1`).toString('base64')}`;
    const viaBasic = await select(h, '', kid.id, undefined, { authorization: basic });
    expect(viaBasic.statusCode).toBe(409);
    expect(viaBasic.json()).toEqual({ error: 'unsupported-credential' });
    const userKey = new UserApiKeyService(h.db, () => new Date()).create(a.id, { name: 'k', scope: 'requests' }).key;
    const viaKey = await select(h, '', kid.id, undefined, { 'x-api-key': userKey });
    expect([403, 409]).toContain(viaKey.statusCode);
    if (viaKey.statusCode === 409) expect(viaKey.json()).toEqual({ error: 'unsupported-credential' });
    const installKey = authServiceFor(h.ctx).apiKey();
    expect((await select(h, '', kid.id, undefined, { 'x-api-key': installKey })).statusCode).toBe(409);
  });

  it('an app device selects a profile with its Bearer token, and new sign-ins start on the owner', async () => {
    const h = await harness();
    const a = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Kids', contentRestrictions: KIDS });
    const signIn = await call(h, 'POST', '/api/v1/app/sign-in', undefined, { username: a.username, password: 'password1', deviceName: 'TV', platform: 'android', appVersion: '1.0.0' });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const bearer = { authorization: `Bearer ${signIn.json().token}` };
    expect((await call(h, 'GET', '/api/v1/auth/me', undefined, undefined, bearer)).json().activeProfile.isOwner).toBe(true);
    expect((await select(h, '', kid.id, undefined, bearer)).statusCode).toBe(200);
    expect((await call(h, 'GET', '/api/v1/auth/me', undefined, undefined, bearer)).json().activeProfile.id).toBe(kid.id);
    // A second sign-in is a new device on the owner profile; the first stays on Kids.
    const again = await call(h, 'POST', '/api/v1/app/sign-in', undefined, { username: a.username, password: 'password1', deviceName: 'Phone', platform: 'android', appVersion: '1.0.0' });
    expect((await call(h, 'GET', '/api/v1/auth/me', undefined, undefined, { authorization: `Bearer ${again.json().token}` })).json().activeProfile.isOwner).toBe(true);
    // Deleting the profile moves the device back to the owner.
    expect((await call(h, 'DELETE', `/api/v1/households/profiles/${kid.id}`, a.cookie)).statusCode).toBe(204);
    expect((await call(h, 'GET', '/api/v1/auth/me', undefined, undefined, bearer)).json().activeProfile.isOwner).toBe(true);
  });
});

// ------------------------------------------------------------------------------------ isolation

describe('per-profile state', () => {
  it('progress, continue watching, queue, playlists, My List and settings are separate per profile', async () => {
    const h = await harness();
    const a = await account(h);
    const kid = await addProfile(h, a.cookie, { name: 'Kids' });
    const ownerCookie = a.cookie;
    const kidCookie = a.session();
    expect((await select(h, kidCookie, kid.id)).statusCode).toBe(200);

    // Progress.
    const report = { event: 'progress', positionMs: 30_000, durationMs: 200_000, deviceId: 'test-device', clientTime: new Date().toISOString() };
    expect((await call(h, 'PUT', '/api/v1/playback/progress/track:5', kidCookie, report)).statusCode).toBe(200);
    const kidProgress = (await call(h, 'GET', '/api/v1/playback/progress?itemKeys=track:5', kidCookie)).json();
    const ownerProgress = (await call(h, 'GET', '/api/v1/playback/progress?itemKeys=track:5', ownerCookie)).json();
    expect(kidProgress.items).toHaveLength(1);
    expect(ownerProgress.items).toHaveLength(0);
    const owner = h.db.select().from(schema.householdProfiles).where(eq(schema.householdProfiles.userId, a.id)).all().find((p) => p.isOwner)!;
    const store = new ProgressStore(h.db);
    expect(store.inProgress({ userId: a.id, profileId: kid.id, isOwnerProfile: false }, 10).map((p) => p.itemKey)).toEqual(['track:5']);
    expect(store.inProgress({ userId: a.id, profileId: owner.id, isOwnerProfile: true }, 10)).toEqual([]);

    // Queue.
    const queue = { items: ['track:5'], index: 0, positionMs: 0, shuffle: false, order: null, repeat: 'off', source: null };
    const put = await call(h, 'PUT', '/api/v1/playback/queue', kidCookie, queue);
    expect(put.statusCode, put.body).toBe(200);
    expect((await call(h, 'GET', '/api/v1/playback/queue', kidCookie)).json().items).toEqual(['track:5']);
    expect((await call(h, 'GET', '/api/v1/playback/queue', ownerCookie)).json().items).toEqual([]);

    // Playlists.
    expect((await call(h, 'POST', '/api/v1/playback/playlists', kidCookie, { name: 'Kid songs', trackIds: [] })).statusCode).toBe(201);
    expect((await call(h, 'GET', '/api/v1/playback/playlists', kidCookie)).json()).toHaveLength(1);
    expect((await call(h, 'GET', '/api/v1/playback/playlists', ownerCookie)).json()).toHaveLength(0);

    // Settings.
    expect((await call(h, 'PUT', '/api/v1/households/profiles/active/settings', kidCookie, { subtitleSize: 'large', showMusic: false })).json()).toMatchObject({ subtitleSize: 'large', showMusic: false });
    expect((await call(h, 'GET', '/api/v1/households/profiles/active/settings', ownerCookie)).json()).toMatchObject({ subtitleSize: 'medium', showMusic: true });
    // showMusic is a UI preference ANDed into the capabilities.
    expect((await call(h, 'GET', '/api/v1/playback/me', kidCookie)).json().sections.music).toBe(false);
    // The account menu items (Request portal, Open Arclight) are the owner profile's only.
    h.db.update(schema.users).set({ permissions: Permission.REQUEST | Permission.REQUEST_VIEW }).where(eq(schema.users.id, a.id)).run();
    expect((await call(h, 'GET', '/api/v1/playback/me', kidCookie)).json()).toMatchObject({ canRequest: false, appHome: null });
    expect((await call(h, 'GET', '/api/v1/playback/me', ownerCookie)).json()).toMatchObject({ canRequest: true, appHome: '/requests' });

    // My List rows are keyed by profile.
    h.db.insert(schema.profileMyList).values({ profileId: kid.id, itemKey: 'movie:77', addedAt: new Date().toISOString() }).run();
    const { myListHas } = await import('../playback/my-list.js');
    expect(await myListHas(h.db, kid.id, ['movie:77', 'movie:78'])).toEqual(new Set(['movie:77']));
    expect(await myListHas(h.db, owner.id, ['movie:77'])).toEqual(new Set());
  });
});

// ------------------------------------------------------------------------------------ restrictions

describe('combineRestrictions', () => {
  const none: ContentRestrictions = { maxCertification: { movie: null, tv: null }, hideAdultContent: false };
  it('keeps the stricter cap per type; null means no cap; adult hiding is an OR', () => {
    expect(combineRestrictions(none, null)).toEqual(none);
    expect(combineRestrictions(none, KIDS)).toEqual(KIDS);
    expect(combineRestrictions(KIDS, none)).toEqual(KIDS);
    expect(combineRestrictions({ maxCertification: { movie: 'PG-13', tv: null }, hideAdultContent: false }, { maxCertification: { movie: 'R', tv: 'TV-Y7' }, hideAdultContent: true })).toEqual({
      maxCertification: { movie: 'PG-13', tv: 'TV-Y7' },
      hideAdultContent: true,
    });
    expect(combineRestrictions({ maxCertification: { movie: 'G', tv: 'TV-14' }, hideAdultContent: true }, { maxCertification: { movie: 'PG', tv: 'TV-G' }, hideAdultContent: false })).toEqual({
      maxCertification: { movie: 'G', tv: 'TV-G' },
      hideAdultContent: true,
    });
  });
});
