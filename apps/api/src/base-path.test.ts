import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestsSettings } from '@arclight/shared';
import { buildApp, type AppContext } from './app.js';
import { normalizeBasePath, outsideBaseRedirect, stripBasePath, withBasePath } from './base-path.js';
import { loadConfig, type AppConfig } from './config.js';
import { createTestDb, seedAdmin } from './db/test-utils.js';
import { authServiceFor, SESSION_COOKIE } from './modules/auth/index.js';
import { setSection } from './modules/settings/service.js';
import { injectBasePath } from './spa.js';

// Sub-path hosting (ARCLIGHT_BASE_PATH): the normaliser, the URL rewrite, and a full app served
// below /arclight (REST, compat API, WebSocket, static files, SPA fallback, redirects).

describe('normalizeBasePath', () => {
  it('normalises to a leading slash and no trailing slash; empty means the root', () => {
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('  /  ')).toBe('');
    expect(normalizeBasePath('/arclight')).toBe('/arclight');
    expect(normalizeBasePath('arclight/')).toBe('/arclight');
    expect(normalizeBasePath('//apps//arclight//')).toBe('/apps/arclight');
    expect(normalizeBasePath('/my-app_v2.0~x')).toBe('/my-app_v2.0~x');
  });

  it('rejects anything that is not a plain path', () => {
    for (const bad of ['/../etc', '/a/./b', '/a b', '/a?x=1', '/a#b', '/%2e%2e', '\\arclight', '/ärclight', '/a:b', 'http://example.com/a']) {
      expect(() => normalizeBasePath(bad), bad).toThrow(/ARCLIGHT_BASE_PATH/);
    }
  });

  it('is read from ARCLIGHT_BASE_PATH by loadConfig', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arclight-base-'));
    try {
      expect(loadConfig({ ARCLIGHT_CONFIG: dir, ARCLIGHT_BASE_PATH: 'arclight/' }).basePath).toBe('/arclight');
      expect(loadConfig({ ARCLIGHT_CONFIG: dir }).basePath).toBe('');
      expect(() => loadConfig({ ARCLIGHT_CONFIG: dir, ARCLIGHT_BASE_PATH: '/../x' })).toThrow(/ARCLIGHT_BASE_PATH/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('base path helpers', () => {
  it('strips the base path and keeps the query', () => {
    expect(stripBasePath('', '/api/v1/x?y=1')).toBe('/api/v1/x?y=1');
    expect(stripBasePath('/arclight', '/arclight/')).toBe('/');
    expect(stripBasePath('/arclight', '/arclight/api/v1/x?y=1')).toBe('/api/v1/x?y=1');
    expect(stripBasePath('/arclight', '/arclight')).toBeNull();
    expect(stripBasePath('/arclight', '/arclight?x=1')).toBeNull();
    expect(stripBasePath('/arclight', '/arclightfoo/x')).toBeNull();
    expect(stripBasePath('/arclight', '/api/v1/x')).toBeNull();
  });

  it('redirects the root and the bare base path, 404s the rest', () => {
    expect(outsideBaseRedirect('/arclight', 'GET', '/')).toBe('/arclight/');
    expect(outsideBaseRedirect('/arclight', 'GET', '/arclight?x=1')).toBe('/arclight/?x=1');
    expect(outsideBaseRedirect('/arclight', 'HEAD', '/arclight')).toBe('/arclight/');
    expect(outsideBaseRedirect('/arclight', 'POST', '/')).toBeNull();
    expect(outsideBaseRedirect('/arclight', 'GET', '/api/v1/system/ping')).toBeNull();
  });

  it('prefixes server-issued locations', () => {
    expect(withBasePath('', '/')).toBe('/');
    expect(withBasePath('/arclight', '/')).toBe('/arclight/');
    expect(withBasePath('/arclight', '/portal?x=1')).toBe('/arclight/portal?x=1');
    expect(withBasePath('/arclight', 'https://example.com/')).toBe('https://example.com/');
    expect(withBasePath('/arclight', '//example.com/')).toBe('//example.com/');
  });

  it('makes the relative index.html URLs absolute below the base', () => {
    const html = '<!doctype html><html><head><link rel="manifest" href="./manifest.webmanifest" /><script type="module" crossorigin src="./assets/index-abc.js"></script></head><body><a href="./x">x</a></body></html>';
    const root = injectBasePath(html, '');
    expect(root).toContain('href="/manifest.webmanifest"');
    expect(root).toContain('src="/assets/index-abc.js"');
    expect(root).not.toContain('arclight-base');
    const sub = injectBasePath(html, '/arclight');
    expect(sub).toContain('href="/arclight/manifest.webmanifest"');
    expect(sub).toContain('src="/arclight/assets/index-abc.js"');
    expect(sub).toContain('<head>\n    <meta name="arclight-base" content="/arclight" />');
  });
});

describe('the app below /arclight', () => {
  const open: { close: () => Promise<unknown> }[] = [];
  let dir: string | null = null;
  afterEach(async () => {
    for (const app of open.splice(0)) await app.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function harness(basePath: string | undefined) {
    dir = await mkdtemp(path.join(tmpdir(), 'arclight-base-web-'));
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html><head><title>Arclight</title><script type="module" crossorigin src="./assets/app.js"></script></head><body><div id="root"></div></body></html>',
    );
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    await writeFile(path.join(dir, 'sw.js'), '// sw');
    const config: AppConfig = { configDir: dir, dbPath: ':memory:', logDir: dir, port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: dir, ...(basePath === undefined ? {} : { basePath }) };
    const db = await createTestDb();
    const adminId = seedAdmin(db);
    setSection(db, 'requests', RequestsSettings.parse({ publicPortal: { enabled: true, paths: ['/watch'], hosts: [{ hostname: 'requests.example.com', portalOnly: true }] } }));
    let ctx: AppContext | undefined;
    const app = await buildApp(config, db, pino({ level: 'silent' }), { probe: false, onContext: (c) => (ctx = c) });
    await app.ready();
    open.push(app);
    const auth = authServiceFor(ctx!);
    return { app, cookie: `${SESSION_COOKIE}=${auth.createSession(adminId).token}`, apiKey: auth.ensureApiKey() };
  }

  it('serves the REST api, the compat api, static files and the SPA below the base', async () => {
    const { app, apiKey } = await harness('/arclight');
    const ping = await app.inject({ method: 'GET', url: '/arclight/api/v1/system/ping' });
    expect(ping.statusCode).toBe(200);
    expect(ping.json()).toEqual({ status: 'ok' });

    const status = await app.inject({ method: 'GET', url: '/arclight/api/v3/system/status', headers: { 'x-api-key': apiKey } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ appName: 'Arclight', urlBase: '/arclight' });

    const asset = await app.inject({ method: 'GET', url: '/arclight/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log(1)');
    expect((await app.inject({ method: 'GET', url: '/arclight/sw.js' })).statusCode).toBe(200);

    const page = await app.inject({ method: 'GET', url: '/arclight/library/movies?x=1', headers: { host: 'nas.example.com' } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<meta name="arclight-base" content="/arclight" />');
    expect(page.body).toContain('src="/arclight/assets/app.js"');
    // Portal paths are matched after the base path is stripped.
    const portal = await app.inject({ method: 'GET', url: '/arclight/watch/movie/603', headers: { host: 'nas.example.com' } });
    expect(portal.body).toContain('&quot;base&quot;:&quot;/watch&quot;');
    expect((await app.inject({ method: 'GET', url: '/arclight/api/v1/nothing' })).statusCode).toBe(404);
  });

  it('answers 404 outside the base and redirects the root into it', async () => {
    const { app } = await harness('/arclight');
    for (const url of ['/api/v1/system/ping', '/api/v3/system/status', '/assets/app.js', '/library/movies', '/metrics', '/arclightx/api/v1/system/ping']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} })).statusCode).toBe(404);
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe('/arclight/');
    const bare = await app.inject({ method: 'GET', url: '/arclight?next=1' });
    expect(bare.statusCode).toBe(302);
    expect(bare.headers.location).toBe('/arclight/?next=1');
  });

  it('keeps the base path in the portal-only hostname redirect', async () => {
    const { app } = await harness('/arclight');
    const admin = await app.inject({ method: 'GET', url: '/arclight/settings/general', headers: { host: 'requests.example.com' } });
    expect(admin.statusCode).toBe(302);
    expect(admin.headers.location).toBe('/arclight/');
  });

  it('upgrades the events WebSocket below the base, not outside it', async () => {
    const { app, cookie } = await harness('/arclight');
    const ws = await app.injectWS('/arclight/api/v1/events', { headers: { cookie } });
    expect(ws.readyState).toBe(ws.OPEN);
    ws.terminate();
    await expect(app.injectWS('/api/v1/events', { headers: { cookie } })).rejects.toThrow(/404/);
  });

  it('behaves as before at the root (basePath left out or empty)', async () => {
    for (const basePath of [undefined, '']) {
      const { app } = await harness(basePath);
      expect((await app.inject({ method: 'GET', url: '/api/v1/system/ping' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/assets/app.js' })).statusCode).toBe(200);
      const page = await app.inject({ method: 'GET', url: '/library/movies', headers: { host: 'nas.example.com' } });
      expect(page.body).toContain('src="/assets/app.js"');
      expect(page.body).not.toContain('arclight-base');
      for (const app of open.splice(0)) await app.close();
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });
});
