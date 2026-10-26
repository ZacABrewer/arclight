import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createTestDb } from '../../db/test-utils.js';
import { buildAuthApp, cookieFrom } from './test-support.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-auth-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ADMIN = { username: 'admin', password: 'password1' };

/** Fresh app with an admin created through setup and setup completed. */
async function readyApp() {
  const ctx = await buildAuthApp();
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: ADMIN });
  const cookie = cookieFrom(res);
  await ctx.app.inject({ method: 'POST', url: '/api/v1/setup/complete', headers: { cookie }, payload: {} });
  return { ...ctx, cookie };
}

describe('setup flow', () => {
  it('reports needsSetup and the step list on a fresh install', async () => {
    const { app } = await buildAuthApp();
    const status = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json().needsSetup).toBe(true);
    expect(status.json().steps.map((s: { id: string }) => s.id)).toEqual(['admin', 'tmdb', 'rootFolders', 'downloadClient', 'indexer']);
    const auth = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(auth.json()).toMatchObject({ needsSetup: true, authenticated: false, authMethod: 'forms', session: null });
  });

  it('creates the first admin once, signed in, and refuses a second', async () => {
    const { app } = await buildAuthApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: ADMIN });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ via: 'session', isAdmin: true, user: { username: 'admin', role: 'admin' } });
    const cookie = cookieFrom(res);
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Lax/);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.json().user.username).toBe('admin');
    const again = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'evil', password: 'password1' } });
    expect(again.statusCode).toBe(409);
  });

  it('guards setup writes once an admin exists', async () => {
    const { app } = await buildAuthApp();
    await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: ADMIN });
    const anon = await app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { tmdbApiKey: 'x' } });
    expect(anon.statusCode).toBe(401);
    const folder = await app.inject({ method: 'POST', url: '/api/v1/setup/rootfolder', payload: { path: join(tmp, 'tv'), mediaType: 'series' } });
    expect(folder.statusCode).toBe(401);
  });

  it('creates missing root folders and completes setup idempotently', async () => {
    const { app, auth } = await buildAuthApp();
    const cookie = cookieFrom(await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: ADMIN }));
    const tv = join(tmp, 'media', 'tv');
    const folder = await app.inject({ method: 'POST', url: '/api/v1/setup/rootfolder', headers: { cookie }, payload: { path: tv, mediaType: 'series' } });
    expect(folder.statusCode).toBe(201);
    expect((await stat(tv)).isDirectory()).toBe(true);
    // Same path again returns the existing folder instead of failing.
    const dup = await app.inject({ method: 'POST', url: '/api/v1/setup/rootfolder', headers: { cookie }, payload: { path: tv, mediaType: 'series' } });
    expect(dup.json().id).toBe(folder.json().id);

    const done = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { cookie },
      payload: { tmdbApiKey: 'tmdb-key', rootFolders: [{ path: join(tmp, 'media', 'movies'), mediaType: 'movie' }], authMethod: 'forms' },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().needsSetup).toBe(false);
    const steps = Object.fromEntries(done.json().steps.map((s: { id: string; complete: boolean }) => [s.id, s.complete]));
    expect(steps).toMatchObject({ admin: true, tmdb: true, rootFolders: true });

    const second = await app.inject({ method: 'POST', url: '/api/v1/setup/complete', headers: { cookie }, payload: {} });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('SETUP_COMPLETE');
    expect(auth.listUsers()).toHaveLength(1);
  });

  it('supports a headless one-call setup that creates the admin', async () => {
    const { app, auth } = await buildAuthApp();
    const missing = await app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { authMethod: 'basic' } });
    expect(missing.statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { ...ADMIN, authMethod: 'basic' } });
    expect(res.statusCode).toBe(200);
    expect(auth.listUsers()[0]?.role).toBe('admin');
    expect(auth.authSettings().method).toBe('basic');
    const again = await app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { username: 'x2', password: 'password2' } });
    expect(again.statusCode).toBe(409);
  });
});

describe('login and session lifecycle', () => {
  it('rejects anonymous callers on protected routes but serves public ones', async () => {
    const { app } = await readyApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/user' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/system/ping' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/no/such/route' })).statusCode).toBe(404);
  });

  it('logs in with a cookie, reports status, and logs out', async () => {
    const { app } = await readyApp();
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'wrong-one' } });
    expect(bad.statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: ADMIN });
    expect(login.statusCode).toBe(200);
    const cookie = cookieFrom(login);
    expect(cookie).toMatch(/^mt_session=.+/);
    const status = await app.inject({ method: 'GET', url: '/api/v1/auth/status', headers: { cookie } });
    expect(status.json()).toMatchObject({ needsSetup: false, authenticated: true, session: { via: 'session', isAdmin: true } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie } })).json()).toEqual({ via: 'session', user: 'admin' });
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie } })).statusCode).toBe(401);
  });

  it('marks the cookie Secure behind an https proxy', async () => {
    const { app } = await readyApp();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-proto': 'https' }, payload: ADMIN });
    expect(String(login.headers['set-cookie'])).toMatch(/; Secure/);
  });

  it('lets a user change their own password and lists their sessions', async () => {
    const { app } = await readyApp();
    const cookie = cookieFrom(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: ADMIN }));
    const sessions = await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: { cookie } });
    expect(sessions.json().some((s: { current: boolean }) => s.current)).toBe(true);
    const wrong = await app.inject({ method: 'PUT', url: '/api/v1/user/me/password', headers: { cookie }, payload: { currentPassword: 'nope', newPassword: 'password2' } });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({ method: 'PUT', url: '/api/v1/user/me/password', headers: { cookie }, payload: { currentPassword: 'password1', newPassword: 'password2' } });
    expect(ok.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie } })).statusCode).toBe(200);
  });
});

describe('API key', () => {
  it('authenticates with the X-Api-Key header or ?apikey= query', async () => {
    const { app, auth } = await readyApp();
    const key = auth.apiKey();
    const header = await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { 'x-api-key': key } });
    expect(header.json()).toEqual({ via: 'apikey', user: null });
    const query = await app.inject({ method: 'GET', url: `/api/v1/probe?apikey=${key}` });
    expect(query.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { 'x-api-key': 'wrong' } })).statusCode).toBe(401);
  });

  it('is shown to admins and regenerates, invalidating the old key', async () => {
    const { app, cookie, auth } = await readyApp();
    const old = auth.apiKey();
    const got = await app.inject({ method: 'GET', url: '/api/v1/settings/security', headers: { cookie } });
    expect(got.json()).toEqual({ method: 'forms', requireForLocal: true, sessionDays: 30, apiKey: old });
    const regen = await app.inject({ method: 'POST', url: '/api/v1/settings/security/apikey', headers: { cookie } });
    expect(regen.json().apiKey).not.toBe(old);
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { 'x-api-key': old } })).statusCode).toBe(401);
  });
});

describe('bypass rules', () => {
  async function withSettings(update: { method: 'forms' | 'basic' | 'none'; requireForLocal: boolean }) {
    const ctx = await readyApp();
    const res = await ctx.app.inject({ method: 'PUT', url: '/api/v1/settings/security', headers: { cookie: ctx.cookie }, payload: { ...update, sessionDays: 30 } });
    expect(res.statusCode).toBe(200);
    return ctx;
  }

  it('method none lets LAN requests through and still blocks public addresses', async () => {
    const { app } = await withSettings({ method: 'none', requireForLocal: true });
    const lan = await app.inject({ method: 'GET', url: '/api/v1/probe', remoteAddress: '192.168.1.40' });
    expect(lan.json()).toEqual({ via: 'bypass', user: null });
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe', remoteAddress: '203.0.113.7' })).statusCode).toBe(401);
  });

  it('a spoofed X-Forwarded-For from a public peer does not bypass', async () => {
    const { app } = await withSettings({ method: 'forms', requireForLocal: false });
    const spoof = await app.inject({ method: 'GET', url: '/api/v1/probe', remoteAddress: '203.0.113.7', headers: { 'x-forwarded-for': '192.168.1.5' } });
    expect(spoof.statusCode).toBe(401);
    const proxied = await app.inject({ method: 'GET', url: '/api/v1/probe', remoteAddress: '10.0.0.2', headers: { 'x-forwarded-for': '198.51.100.3' } });
    expect(proxied.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe', remoteAddress: '10.0.0.2' })).statusCode).toBe(200);
  });

  it('basic auth accepts credentials and challenges anonymous callers', async () => {
    const { app } = await withSettings({ method: 'basic', requireForLocal: true });
    const anon = await app.inject({ method: 'GET', url: '/api/v1/probe' });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers['www-authenticate']).toMatch(/^Basic/);
    const basic = `Basic ${Buffer.from('admin:password1').toString('base64')}`;
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { authorization: basic } })).json()).toEqual({ via: 'basic', user: 'admin' });
  });
});

describe('admin guard and user management', () => {
  it('admins manage users; plain users are read-only and kept out of admin routes', async () => {
    const { app, cookie } = await readyApp();
    const created = await app.inject({ method: 'POST', url: '/api/v1/user', headers: { cookie }, payload: { username: 'viewer', password: 'password1', email: 'v@x.example' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ role: 'user', permissions: 0 });
    expect(JSON.stringify(created.json())).not.toContain('password');
    const dup = await app.inject({ method: 'POST', url: '/api/v1/user', headers: { cookie }, payload: { username: 'VIEWER', password: 'password1' } });
    expect(dup.statusCode).toBe(409);

    const userCookie = cookieFrom(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'viewer', password: 'password1' } }));
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie: userCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/probe', headers: { cookie: userCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/user', headers: { cookie: userCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/security', headers: { cookie: userCookie } })).statusCode).toBe(403);
    const self = await app.inject({ method: 'PUT', url: '/api/v1/user/me', headers: { cookie: userCookie }, payload: { displayName: 'Vee', settings: { theme: 'light' } } });
    expect(self.statusCode).toBe(200);
    expect(self.json()).toMatchObject({ displayName: 'Vee', settings: { theme: 'light' } });

    const id = created.json().id as number;
    const reset = await app.inject({ method: 'PUT', url: `/api/v1/user/${id}`, headers: { cookie }, payload: { password: 'password9', role: 'admin' } });
    expect(reset.json().role).toBe('admin');
    // A password reset ends that user's sessions.
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { cookie: userCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/user/${id}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v1/user/${id}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it('refuses to delete the only admin', async () => {
    const { app, auth } = await readyApp();
    const key = auth.apiKey();
    const adminId = auth.listUsers()[0]!.id;
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/user/${adminId}`, headers: { 'x-api-key': key } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('LAST_ADMIN');
  });
});

describe('app wiring', () => {
  it('buildApp protects module routes and keeps public ones open', async () => {
    const db = await createTestDb();
    const config = { configDir: tmp, dbPath: ':memory:', logDir: tmp, port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };
    const app = await buildApp(config, db, pino({ level: 'silent' }), { probe: false });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/system/status' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/v1/system/ping' })).json()).toEqual({ status: 'ok' });
      expect((await app.inject({ method: 'GET', url: '/api/v1/setup/status' })).json().needsSetup).toBe(true);
      const created = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: ADMIN });
      const cookie = cookieFrom(created);
      expect((await app.inject({ method: 'GET', url: '/api/v1/system/status', headers: { cookie } })).statusCode).toBe(200);
      // The calendar feed authenticates with its own token, no session needed.
      const feed = await app.inject({ method: 'GET', url: '/api/v1/calendar/feed', headers: { cookie } });
      const ics = await app.inject({ method: 'GET', url: feed.json().path });
      expect(ics.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
