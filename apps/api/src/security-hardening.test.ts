import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppContext } from './app.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import { createTestDb, seedAdmin } from './db/test-utils.js';
import { createLogger } from './logging.js';
import { authServiceFor, SESSION_COOKIE } from './modules/auth/index.js';
import { EVENTS_RECHECK_MS } from './modules/events/index.js';
import { setSection } from './modules/settings/service.js';
import { DEFAULT_CSP, HSTS_VALUE, installSecurityHeaders, PAGE_CSP } from './security-headers.js';

// Full-app regressions for the 0.24 security pass: CORS with credentials (AUTH-02 / CLI-02 /
// DATA-19), the /events Origin check and re-check, security headers (CLI-03), trusted proxies
// (AUTH-01), Secure cookies behind a TLS proxy (AUTH-16), command/restore routes for narrow
// credentials (DATA-13), secrets in logs (DATA-14), portal-only hostnames (AUTH-25) and the
// first-run setup race (AUTH-08).

const base: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };
// A built web app is being served: the dev-server localhost allowance is off.
const prod: AppConfig = { ...base, webDist: join(tmpdir(), 'arclight-no-web-dist') };

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
}
const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of open.splice(0)) await h.app.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function harness(opts: { config?: Partial<AppConfig>; admin?: boolean; log?: pino.Logger } = {}): Promise<Harness> {
  const db = await createTestDb();
  if (opts.admin ?? true) seedAdmin(db);
  let ctx: AppContext | undefined;
  const app = await buildApp({ ...prod, ...opts.config }, db, opts.log ?? pino({ level: 'silent' }), { probe: false, onContext: (c) => (ctx = c) });
  await app.ready();
  const h = { app, ctx: ctx!, db };
  open.push(h);
  return h;
}

async function adminSession(h: Harness, username = 'owner'): Promise<{ id: number; cookie: string }> {
  const auth = authServiceFor(h.ctx);
  const user = await auth.createUser({ username, password: 'password1', role: 'admin' });
  return { id: user.id, cookie: `${SESSION_COOKIE}=${auth.createSession(user.id).token}` };
}

async function personalKey(h: Harness, scope: 'read' | 'requests' | 'admin'): Promise<string> {
  const { cookie } = await adminSession(h, `keyowner-${scope}`);
  const res = await h.app.inject({ method: 'POST', url: '/api/v1/user/me/apikeys', headers: { cookie }, payload: { name: scope, scope } });
  expect(res.statusCode).toBe(201);
  return res.json().key as string;
}

describe('CORS (AUTH-02 / CLI-02 / DATA-19)', () => {
  const get = (h: Harness, origin: string, extra: Record<string, string> = {}) =>
    h.app.inject({ method: 'GET', url: '/api/v1/system/ping', headers: { origin, host: 'arclight.example.com', ...extra } });

  it('never reflects a foreign origin, with or without credentials', async () => {
    const h = await harness();
    const res = await get(h, 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    const preflight = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/settings/security',
      headers: { origin: 'https://evil.example', host: 'arclight.example.com', 'access-control-request-method': 'PUT' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    // Another port on the same machine is another origin (SameSite would still send the cookie).
    expect((await get(h, 'http://arclight.example.com:8081')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows credentials for the page’s own origin, the Application URL, portal hostnames and ARCLIGHT_CORS_ORIGINS', async () => {
    const h = await harness({ config: { corsOrigins: 'https://dash.example.com' } });
    setSection(h.db, 'requests', {
      applicationUrl: 'https://media.example.com',
      publicPortal: { enabled: true, hosts: [{ hostname: 'requests.example.com', portalOnly: false }] },
    });
    for (const origin of ['https://arclight.example.com', 'https://media.example.com', 'https://requests.example.com', 'https://dash.example.com']) {
      const res = await get(h, origin);
      expect(res.headers['access-control-allow-origin'], origin).toBe(origin);
      expect(res.headers['access-control-allow-credentials'], origin).toBe('true');
      expect(String(res.headers['vary'])).toMatch(/origin/i);
    }
  });

  it('answers the apps’ WebView origins without credentials', async () => {
    const h = await harness();
    const res = await get(h, 'capacitor://localhost');
    expect(res.headers['access-control-allow-origin']).toBe('capacitor://localhost');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('keeps the dev server (another localhost port) working when no web app is built', async () => {
    const h = await harness({ config: { webDist: null } });
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/system/ping', headers: { origin: 'http://localhost:5173', host: 'localhost:8686' } });
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('/events WebSocket', () => {
  it('refuses the upgrade from a foreign page, accepts the page’s own origin (AUTH-02)', async () => {
    const h = await harness();
    const { cookie } = await adminSession(h);
    await expect(h.app.injectWS('/api/v1/events', { headers: { cookie, origin: 'https://evil.example', host: 'arclight.example.com' } })).rejects.toThrow(/403/);
    const ws = await h.app.injectWS('/api/v1/events', { headers: { cookie, origin: 'https://arclight.example.com', host: 'arclight.example.com' } });
    ws.terminate();
  });

  it('closes an open socket once its session is signed out', async () => {
    const intervals: (() => void)[] = [];
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === EVENTS_RECHECK_MS) intervals.push(fn);
      return real(() => undefined, 1_000_000);
    }) as typeof setInterval);
    const h = await harness();
    const auth = authServiceFor(h.ctx);
    const user = await auth.createUser({ username: 'watcher', password: 'password1', role: 'admin' });
    const session = auth.createSession(user.id);
    const before = intervals.length;
    const ws = await h.app.injectWS('/api/v1/events', { headers: { cookie: `${SESSION_COOKIE}=${session.token}` } });
    const closed = new Promise<number>((resolve) => ws.on('close', (code: number) => resolve(code)));
    // The socket's own re-check timer.
    expect(intervals.length).toBe(before + 1);
    const recheck = intervals[intervals.length - 1]!;
    // Still signed in: the check keeps the socket open.
    recheck();
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.readyState).toBe(ws.OPEN);
    auth.revokeAllSessions(user.id);
    recheck();
    expect(await closed).toBe(1008);
  });
});

describe('security headers (CLI-03)', () => {
  it('sends nosniff, a referrer policy and frame protection on API responses', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/system/ping' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['content-security-policy']).toBe(DEFAULT_CSP);
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('gives HTML pages the script policy and keeps a route’s own policy', async () => {
    const db = await createTestDb();
    const app = Fastify();
    installSecurityHeaders(app, db);
    app.get('/page', async (_req, reply) => reply.type('text/html').send('<!doctype html><p>hi</p>'));
    app.get('/own', async (_req, reply) => reply.type('text/html').header('content-security-policy', "default-src 'none'").send('x'));
    const page = await app.inject({ method: 'GET', url: '/page' });
    expect(page.headers['content-security-policy']).toBe(PAGE_CSP);
    expect(PAGE_CSP).toContain("script-src 'self'");
    expect(PAGE_CSP).not.toContain('unsafe-eval');
    expect((await app.inject({ method: 'GET', url: '/own' })).headers['content-security-policy']).toBe("default-src 'none'");
    await app.close();
  });

  it('sends HSTS only over https on the https Application URL’s host', async () => {
    const h = await harness();
    setSection(h.db, 'requests', { applicationUrl: 'https://media.example.com' });
    const req = (host: string, proto: string) =>
      h.app.inject({ method: 'GET', url: '/api/v1/system/ping', headers: { host, 'x-forwarded-proto': proto } });
    expect((await req('media.example.com', 'https')).headers['strict-transport-security']).toBe(HSTS_VALUE);
    expect((await req('media.example.com', 'http')).headers['strict-transport-security']).toBeUndefined();
    expect((await req('192.0.2.10:8686', 'https')).headers['strict-transport-security']).toBeUndefined();
  });
});

describe('trusted proxies (AUTH-01)', () => {
  const login = (h: Harness, remoteAddress: string, xff: string, password = 'wrong-password') =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress, headers: { 'x-forwarded-for': xff }, payload: { username: 'owner', password } });

  it('ignores X-Forwarded-For from a public peer, so rotating it does not reset the limit', async () => {
    const h = await harness();
    await adminSession(h);
    for (let i = 0; i < 10; i++) expect((await login(h, '203.0.113.5', `198.51.100.${i}`)).statusCode).toBe(401);
    expect((await login(h, '203.0.113.5', '198.51.100.200')).statusCode).toBe(429);
  });

  it('honours X-Forwarded-For from a proxy on a private address (the default)', async () => {
    const h = await harness();
    await adminSession(h);
    for (let i = 0; i < 10; i++) expect((await login(h, '172.18.0.2', '198.51.100.1')).statusCode).toBe(401);
    expect((await login(h, '172.18.0.2', '198.51.100.1')).statusCode).toBe(429);
    // The account itself is now in its backoff, from any address (AUTH-01 per-account counter).
    const other = await login(h, '172.18.0.2', '198.51.100.2');
    expect(other.statusCode).toBe(429);
    expect(Number(other.headers['retry-after'])).toBeGreaterThan(0);
    // Another client behind the same proxy, another account: not blocked.
    const fresh = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '172.18.0.2',
      headers: { 'x-forwarded-for': '198.51.100.2' },
      payload: { username: 'someone-else', password: 'nope-nope' },
    });
    expect(fresh.statusCode).toBe(401);
  });

  it('ARCLIGHT_TRUSTED_PROXIES=none uses the socket address only', async () => {
    const h = await harness({ config: { trustedProxies: 'none' } });
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/system/ping', remoteAddress: '172.18.0.2', headers: { 'x-forwarded-proto': 'https', host: 'media.example.com' } });
    setSection(h.db, 'requests', { applicationUrl: 'https://media.example.com' });
    expect(res.statusCode).toBe(200);
    // X-Forwarded-Proto ignored: plain http, so no HSTS.
    const again = await h.app.inject({ method: 'GET', url: '/api/v1/system/ping', remoteAddress: '172.18.0.2', headers: { 'x-forwarded-proto': 'https', host: 'media.example.com' } });
    expect(again.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('Secure cookies behind a TLS proxy without X-Forwarded-Proto (AUTH-16)', () => {
  it('marks the session cookie Secure on the https Application URL’s host', async () => {
    const h = await harness();
    await adminSession(h);
    setSection(h.db, 'requests', { applicationUrl: 'https://media.example.com' });
    const login = (host: string) =>
      h.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host }, payload: { username: 'owner', password: 'password1' } });
    const onAppHost = await login('media.example.com');
    expect(onAppHost.statusCode).toBe(200);
    expect(String(onAppHost.headers['set-cookie'])).toMatch(/;\s*Secure/i);
    const onLan = await login('192.0.2.10:8686');
    expect(String(onLan.headers['set-cookie'])).not.toMatch(/;\s*Secure/i);
  });
});

describe('command and restore routes (DATA-13)', () => {
  it('a requests-scope key may not set a program path or import a configuration; an admin-scope key may', async () => {
    const h = await harness();
    const write = await personalKey(h, 'requests');
    const admin = await personalKey(h, 'admin');
    const put = (key: string, url: string, payload: object) => h.app.inject({ method: 'PUT', url, headers: { 'x-api-key': key }, payload });
    const current = (await h.app.inject({ method: 'GET', url: '/api/v1/subtitle/settings', headers: { 'x-api-key': admin } })).json();
    expect((await put(write, '/api/v1/subtitle/settings', { ...current, ffmpegPath: '/tmp/evil' })).statusCode).toBe(403);
    expect((await put(write, '/api/v1/settings/solver', {})).statusCode).toBe(403);
    const imported = await h.app.inject({ method: 'POST', url: '/api/v1/config/import', headers: { 'x-api-key': write }, payload: { settings: {} } });
    expect(imported.statusCode).toBe(403);
    expect((await put(admin, '/api/v1/subtitle/settings', current)).statusCode).not.toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/settings/solver', headers: { 'x-api-key': admin } })).statusCode).toBe(200);
  });

  it('a requests-scope key may not create a custom-script notification', async () => {
    const h = await harness();
    const write = await personalKey(h, 'requests');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/notification',
      headers: { 'x-api-key': write },
      payload: { name: 'script', implementation: 'custom-script', settings: { path: '/tmp/evil.sh' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });
});

describe('secrets in logs (DATA-14)', () => {
  it('masks ?apikey= and other credentials before the ring buffer and the log file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arclight-logs-'));
    dirs.push(dir);
    const { log, buffer, files } = createLogger({ logDir: dir, logLevel: 'info' }, { stdout: null, register: false });
    const h = await harness({ log });
    const key = authServiceFor(h.ctx).apiKey();
    await h.app.inject({ method: 'GET', url: `/api/v1/system/status?apikey=${key}` });
    await h.app.inject({ method: 'GET', url: '/api/v1/calendar/feed.ics?token=caltoken1234567890' });
    log.info({ headers: { authorization: 'Bearer secret-bearer-123456', cookie: 'al_session=abc' } }, 'headers logged');
    const lines = buffer.newestFirst().map((r) => JSON.stringify(r)).join('\n');
    files.close();
    const file = readFileSync(join(dir, 'arclight.log'), 'utf8');
    for (const text of [lines, file]) {
      expect(text).toContain('/api/v1/system/status');
      expect(text).not.toContain(key);
      expect(text).not.toContain('caltoken1234567890');
      expect(text).not.toContain('secret-bearer-123456');
      expect(text).not.toContain('al_session=abc');
    }
  });
});

describe('portal-only hostnames (AUTH-25)', () => {
  it('refuse the admin API to a signed-in admin, keep portal routes and the API key working', async () => {
    const h = await harness();
    const { cookie } = await adminSession(h);
    setSection(h.db, 'requests', { publicPortal: { enabled: true, hosts: [{ hostname: 'requests.example.com', portalOnly: true }] } });
    const on = (host: string, url: string, headers: Record<string, string> = { cookie }) => h.app.inject({ method: 'GET', url, headers: { host, ...headers } });
    const refused = await on('requests.example.com', '/api/v1/settings/security');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('PORTAL_ONLY_HOST');
    expect((await on('requests.example.com', '/api/v1/auth/me')).statusCode).toBe(200);
    expect((await on('arclight.example.com', '/api/v1/settings/security')).statusCode).toBe(200);
    const key = authServiceFor(h.ctx).apiKey();
    expect((await on('requests.example.com', '/api/v1/system/status', { 'x-api-key': key })).statusCode).toBe(200);
  });
});

describe('first-run setup (AUTH-08)', () => {
  it('two racing admin-creating calls make exactly one admin', async () => {
    const h = await harness({ admin: false });
    const [a, b] = await Promise.all([
      h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'first', password: 'password1' } }),
      h.app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { username: 'second', password: 'password2' } }),
    ]);
    expect([a.statusCode, b.statusCode].filter((c) => c < 300)).toHaveLength(1);
    const admins = authServiceFor(h.ctx).listUsers().filter((u) => u.role === 'admin');
    expect(admins).toHaveLength(1);
  });

  it('creates the admin before any folder; a retry with the same body signs in with it', async () => {
    const h = await harness({ admin: false });
    const bad = await h.app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { username: 'owner', password: 'password1', rootFolders: [{ path: 'relative/path', mediaType: 'movie' }] } });
    expect(bad.statusCode).toBe(400);
    // Validation failed before anything was written: no admin yet.
    expect(authServiceFor(h.ctx).hasAdmin()).toBe(false);
    const ok = await h.app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { username: 'owner', password: 'password1' } });
    expect(ok.statusCode).toBe(200);
    // Setup is complete: a second anonymous call is refused.
    const again = await h.app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: { username: 'owner', password: 'password1' } });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
  });
});
