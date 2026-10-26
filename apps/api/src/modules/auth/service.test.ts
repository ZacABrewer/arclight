import { describe, expect, it } from 'vitest';
import { Permission } from '@media-tron/shared';
import { createTestDb } from '../../db/test-utils.js';
import { sessions } from '../../db/schema.js';
import { AuthService } from './service.js';

async function make(opts: { maxFailures?: number } = {}) {
  const db = await createTestDb();
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const auth = new AuthService({ db, now: () => clock, ...opts });
  return {
    db,
    auth,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
const DAY = 24 * 60 * 60_000;

describe('AuthService users', () => {
  it('creates users with case-insensitive unique usernames and role-derived permissions', async () => {
    const { auth } = await make();
    const admin = await auth.createUser({ username: 'Admin', password: 'password1', role: 'admin', email: 'A@B.example' });
    expect(admin).toMatchObject({ username: 'Admin', role: 'admin', email: 'a@b.example', settings: {} });
    expect(admin.permissions & Permission.ADMIN).toBe(Permission.ADMIN);
    await expect(auth.createUser({ username: 'admin', password: 'password1' })).rejects.toMatchObject({ code: 'USER_EXISTS' });
    const user = await auth.createUser({ username: 'bob', password: 'password1', permissions: Permission.ADMIN | Permission.REQUEST });
    expect(user.permissions).toBe(Permission.REQUEST);
  });

  it('never demotes or deletes the last admin, nor lets you delete yourself', async () => {
    const { auth } = await make();
    const admin = await auth.createUser({ username: 'root', password: 'password1', role: 'admin' });
    const bob = await auth.createUser({ username: 'bob', password: 'password1' });
    await expect(auth.updateUser(admin.id, { role: 'user' })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    expect(() => auth.deleteUser(admin.id, bob.id)).toThrow(/only admin/);
    expect(() => auth.deleteUser(bob.id, bob.id)).toThrow(/own account/);
    auth.deleteUser(bob.id, admin.id);
    expect(auth.listUsers().map((u) => u.username)).toEqual(['root']);
  });

  it('merges settings and clears optional fields with null', async () => {
    const { auth } = await make();
    const u = await auth.createUser({ username: 'amy', password: 'password1', displayName: 'Amy', settings: { theme: 'dark' } });
    const next = auth.updateSelf(u.id, { displayName: null, settings: { locale: 'en-GB' } });
    expect(next.displayName).toBeUndefined();
    expect(next.settings).toEqual({ theme: 'dark', locale: 'en-GB' });
  });
});

describe('AuthService sessions', () => {
  it('logs in, resolves the session by token and logs out', async () => {
    const { auth, db } = await make();
    await auth.createUser({ username: 'amy', password: 'password1' });
    const result = await auth.login('AMY', 'password1', { ip: '10.0.0.2', userAgent: 'vitest' });
    expect(result.maxAgeSeconds).toBe(30 * 24 * 3600);
    expect(result.user.lastLoginAt).toBe('2026-01-01T00:00:00.000Z');
    // Only the hash is stored.
    expect(db.select().from(sessions).all()[0]?.tokenHash).not.toBe(result.token);
    expect(auth.resolveSession(result.token)?.user.username).toBe('amy');
    auth.logout(result.token);
    expect(auth.resolveSession(result.token)).toBeNull();
  });

  it('rejects wrong passwords and unknown users with the same error', async () => {
    const { auth } = await make();
    await auth.createUser({ username: 'amy', password: 'password1' });
    await expect(auth.login('amy', 'nope')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(auth.login('ghost', 'nope')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('expires sessions and slides persistent ones past half their lifetime', async () => {
    const { auth, advance } = await make();
    auth.updateAuthSettings({ method: 'forms', requireForLocal: true, sessionDays: 10 });
    await auth.createUser({ username: 'amy', password: 'password1' });
    const { token, expiresAt } = await auth.login('amy', 'password1');
    advance(2 * DAY);
    expect(auth.resolveSession(token)?.renewed).toBeUndefined();
    advance(4 * DAY);
    const slid = auth.resolveSession(token);
    expect(slid?.renewed).toEqual({ maxAgeSeconds: 10 * 24 * 3600 });
    expect(Date.parse(slid!.expiresAt)).toBeGreaterThan(Date.parse(expiresAt));
    advance(11 * DAY);
    expect(auth.resolveSession(token)).toBeNull();
  });

  it('gives non-remembered sessions a browser-session cookie and a one-day server lifetime', async () => {
    const { auth, advance } = await make();
    await auth.createUser({ username: 'amy', password: 'password1' });
    const r = await auth.login('amy', 'password1', { rememberMe: false });
    expect(r.maxAgeSeconds).toBeNull();
    advance(DAY + 1);
    expect(auth.resolveSession(r.token)).toBeNull();
  });

  it('changing the password ends every other session', async () => {
    const { auth } = await make();
    const u = await auth.createUser({ username: 'amy', password: 'password1' });
    const a = await auth.login('amy', 'password1');
    const b = await auth.login('amy', 'password1');
    await expect(auth.changePassword(u.id, 'wrong', 'password2')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await auth.changePassword(u.id, 'password1', 'password2', a.sessionId);
    expect(auth.resolveSession(a.token)).not.toBeNull();
    expect(auth.resolveSession(b.token)).toBeNull();
    await expect(auth.login('amy', 'password1')).rejects.toBeTruthy();
    expect((await auth.login('amy', 'password2')).user.username).toBe('amy');
  });

  it('locks an address out after repeated failures', async () => {
    const { auth, advance } = await make({ maxFailures: 3 });
    await auth.createUser({ username: 'amy', password: 'password1' });
    for (let i = 0; i < 3; i++) await expect(auth.login('amy', 'bad', { ip: '1.2.3.4' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(auth.login('amy', 'password1', { ip: '1.2.3.4' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // Other addresses are unaffected; the lock lifts after the window.
    expect((await auth.login('amy', 'password1', { ip: '5.6.7.8' })).user.username).toBe('amy');
    advance(16 * 60_000);
    expect((await auth.login('amy', 'password1', { ip: '1.2.3.4' })).user.username).toBe('amy');
  });

  it('lists and revokes only the caller own sessions', async () => {
    const { auth } = await make();
    const amy = await auth.createUser({ username: 'amy', password: 'password1' });
    const bob = await auth.createUser({ username: 'bob', password: 'password1' });
    const a = await auth.login('amy', 'password1', { userAgent: 'Firefox' });
    await auth.login('bob', 'password1');
    const list = auth.listSessions(amy.id, a.sessionId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ current: true, userAgent: 'Firefox' });
    expect(() => auth.revokeSession(bob.id, a.sessionId)).toThrow(/not found/);
    auth.revokeSession(amy.id, a.sessionId);
    expect(auth.listSessions(amy.id)).toEqual([]);
  });
});

describe('AuthService API key and bypass', () => {
  it('generates the API key once, verifies it and regenerates on demand', async () => {
    const { auth } = await make();
    const key = auth.ensureApiKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(auth.ensureApiKey()).toBe(key);
    expect(auth.verifyApiKey(key)).toBe(true);
    expect(auth.verifyApiKey(key.toUpperCase())).toBe(false);
    expect(auth.verifyApiKey(undefined)).toBe(false);
    const next = auth.regenerateApiKey();
    expect(next).not.toBe(key);
    expect(auth.verifyApiKey(key)).toBe(false);
  });

  it('bypasses only local requests, only after setup, only when configured', async () => {
    const { auth } = await make();
    auth.updateAuthSettings({ method: 'none', requireForLocal: true, sessionDays: 30 });
    expect(auth.bypasses(['192.168.1.4'])).toBe(false); // setup not complete
    auth.markSetupComplete();
    expect(auth.bypasses(['192.168.1.4'])).toBe(true);
    expect(auth.bypasses(['203.0.113.9'])).toBe(false);
    auth.updateAuthSettings({ method: 'forms', requireForLocal: true, sessionDays: 30 });
    expect(auth.bypasses(['192.168.1.4'])).toBe(false);
    auth.updateAuthSettings({ method: 'forms', requireForLocal: false, sessionDays: 30 });
    expect(auth.bypasses(['127.0.0.1', '10.0.0.8'])).toBe(true);
    expect(auth.bypasses(['10.0.0.8', '198.51.100.1'])).toBe(false);
  });
});
