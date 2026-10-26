import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestsSettings } from '@arclight/shared';
import type { AppContext } from './app.js';
import { createTestDb } from './db/test-utils.js';
import { setSection } from './modules/settings/service.js';
import { registerSpa } from './spa.js';

// The SPA fallback: static files, index.html for page loads, the portal mapping meta tag and
// portal-only hostnames.

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

async function server(portal: object) {
  dir = await mkdtemp(path.join(tmpdir(), 'arclight-spa-'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><head><title>Arclight</title></head><body><div id="root"></div></body></html>');
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
  const db = await createTestDb();
  setSection(db, 'requests', RequestsSettings.parse({ publicPortal: portal }));
  const app = Fastify({ trustProxy: true });
  await registerSpa(app, { db } as AppContext, dir);
  return app;
}

const portal = { enabled: true, paths: ['/ajkdlfjla'], hosts: [{ hostname: 'requests.example.com', portalOnly: true }] };

describe('SPA fallback', () => {
  it('serves static files and index.html for app pages without a portal tag', async () => {
    const app = await server(portal);
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log(1)');
    const page = await app.inject({ method: 'GET', url: '/library/movies', headers: { host: 'nas.local:7878' } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('<div id="root">');
    expect(page.body).not.toContain('arclight-portal');
    const root = await app.inject({ method: 'GET', url: '/', headers: { host: 'nas.local' } });
    expect(root.body).not.toContain('arclight-portal');
    expect((await app.inject({ method: 'GET', url: '/api/v1/nothing' })).statusCode).toBe(404);
  });

  it('tags portal paths, deep links included', async () => {
    const app = await server(portal);
    const page = await app.inject({ method: 'GET', url: '/ajkdlfjla/movie/603?x=1', headers: { host: 'nas.local' } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('&quot;base&quot;:&quot;/ajkdlfjla&quot;');
  });

  it('answers portal hostnames at the root, honouring X-Forwarded-Host, and redirects admin pages', async () => {
    const app = await server(portal);
    const root = await app.inject({ method: 'GET', url: '/', headers: { host: '127.0.0.1:7878', 'x-forwarded-host': 'requests.example.com' } });
    expect(root.body).toContain('&quot;mode&quot;:&quot;host&quot;');
    const admin = await app.inject({ method: 'GET', url: '/settings/general', headers: { host: 'requests.example.com' } });
    expect(admin.statusCode).toBe(302);
    expect(admin.headers.location).toBe('/');
    const login = await app.inject({ method: 'GET', url: '/login', headers: { host: 'requests.example.com' } });
    expect(login.statusCode).toBe(200);
  });
});
