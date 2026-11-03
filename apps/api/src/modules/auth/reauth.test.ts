import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { users } from '../../db/schema.js';
import { buildAuthApp, cookieFrom } from './test-support.js';

// Adding a way in (passkey, authenticator app, personal API key) needs a session younger than
// ten minutes or the account's current password; the global API key is masked until revealed.

const ADMIN = { username: 'admin', password: 'password1' };
const MINUTE = 60_000;

/** An app on a clock the test moves; the admin's session is opened at the start. */
async function clockedApp(opts: { maxFailures?: number } = {}) {
  let t = Date.parse('2026-01-01T12:00:00Z');
  const ctx = await buildAuthApp({ now: () => new Date(t), ...opts });
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: ADMIN });
  const cookie = cookieFrom(res);
  await ctx.app.inject({ method: 'POST', url: '/api/v1/setup/complete', headers: { cookie }, payload: {} });
  return { ...ctx, cookie, advance: (ms: number) => (t += ms) };
}

const GATED = [
  { url: '/api/v1/user/me/passkeys/options', payload: {} },
  { url: '/api/v1/user/me/2fa/totp/setup', payload: {} },
  { url: '/api/v1/user/me/apikeys', payload: { name: 'script', scope: 'read' } },
] as const;

describe('re-authentication for new sign-in methods', () => {
  it('lets a session younger than ten minutes through without a password', async () => {
    const { app, cookie, advance } = await clockedApp();
    advance(9 * MINUTE);
    for (const r of GATED) {
      const res = await app.inject({ method: 'POST', url: r.url, headers: { cookie }, payload: r.payload });
      expect(res.statusCode, r.url).toBeLessThan(300);
    }
  });

  it('answers 401 REAUTH_REQUIRED for an older session, and passes with the current password', async () => {
    const { app, cookie, advance } = await clockedApp();
    advance(11 * MINUTE);
    for (const r of GATED) {
      const refused = await app.inject({ method: 'POST', url: r.url, headers: { cookie }, payload: r.payload });
      expect(refused.statusCode, r.url).toBe(401);
      expect(refused.json().code).toBe('REAUTH_REQUIRED');
      const ok = await app.inject({ method: 'POST', url: r.url, headers: { cookie }, payload: { ...r.payload, currentPassword: ADMIN.password } });
      expect(ok.statusCode, r.url).toBeLessThan(300);
    }
    // The old session itself is still signed in: the refusal is not a lost session.
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(200);
  });

  it('counts a wrong password as a failed sign-in and rate-limits it', async () => {
    const { app, cookie, advance } = await clockedApp({ maxFailures: 3 });
    advance(11 * MINUTE);
    const url = '/api/v1/user/me/passkeys/options';
    for (let i = 0; i < 3; i++) {
      const wrong = await app.inject({ method: 'POST', url, headers: { cookie }, payload: { currentPassword: 'not-it' } });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().code).toBe('INVALID_CREDENTIALS');
    }
    const limited = await app.inject({ method: 'POST', url, headers: { cookie }, payload: { currentPassword: ADMIN.password } });
    expect(limited.statusCode).toBe(429);
  });

  it('asks an account without a password to sign in again', async () => {
    const { app, auth, db, advance } = await clockedApp();
    const user = await auth.createUser({ username: 'viewer', password: 'password2', role: 'user' });
    db.update(users).set({ localPassword: false }).where(eq(users.id, user.id)).run();
    const session = auth.createSession(user.id, { method: 'jellyfin' });
    const cookie = `al_session=${session.token}`;
    expect((await app.inject({ method: 'POST', url: '/api/v1/user/me/passkeys/options', headers: { cookie }, payload: {} })).statusCode).toBe(200);
    advance(11 * MINUTE);
    const refused = await app.inject({ method: 'POST', url: '/api/v1/user/me/passkeys/options', headers: { cookie }, payload: { currentPassword: 'password2' } });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ code: 'REAUTH_REQUIRED', error: expect.stringMatching(/sign in again/) });
  });

  it('keeps refusing personal API keys, whatever their scope', async () => {
    const { app, cookie } = await clockedApp();
    const key = (await app.inject({ method: 'POST', url: '/api/v1/user/me/apikeys', headers: { cookie }, payload: { name: 'k', scope: 'admin' } })).json().key as string;
    const res = await app.inject({ method: 'POST', url: '/api/v1/user/me/apikeys', headers: { 'x-api-key': key }, payload: { name: 'more', scope: 'admin' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('global API key', () => {
  it('is masked in GET /settings/security, revealed by POST …/reveal, and kept when the mask is sent back', async () => {
    const { app, cookie, auth } = await clockedApp();
    const key = auth.apiKey();
    const got = await app.inject({ method: 'GET', url: '/api/v1/settings/security', headers: { cookie } });
    expect(got.json().apiKey).toBe(`********${key.slice(-4)}`);
    expect(got.json().apiKey).not.toContain(key.slice(0, 8));

    const revealed = await app.inject({ method: 'POST', url: '/api/v1/settings/security/apikey/reveal', headers: { cookie } });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json()).toEqual({ apiKey: key });

    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/security', headers: { cookie }, payload: { ...(got.json() as Record<string, unknown>), sessionDays: 14 } });
    expect(put.statusCode).toBe(200);
    expect(auth.apiKey()).toBe(key);
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { 'x-api-key': key } })).statusCode).toBe(200);
  });

  it('is revealed only to signed-in admins, never to personal keys', async () => {
    const { app, cookie, auth } = await clockedApp();
    const adminKey = (await app.inject({ method: 'POST', url: '/api/v1/user/me/apikeys', headers: { cookie }, payload: { name: 'k', scope: 'admin' } })).json().key as string;
    expect((await app.inject({ method: 'POST', url: '/api/v1/settings/security/apikey/reveal', headers: { 'x-api-key': adminKey } })).statusCode).toBe(403);
    await auth.createUser({ username: 'viewer', password: 'password2', role: 'user' });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'viewer', password: 'password2' } });
    expect((await app.inject({ method: 'POST', url: '/api/v1/settings/security/apikey/reveal', headers: { cookie: cookieFrom(login) } })).statusCode).toBe(403);
  });
});
