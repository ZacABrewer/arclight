import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { UpdateInfo } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { createUpdateAvailableCheck } from './health.js';
import { UPDATE_CHECK_JOB, updatesModule, updatesServiceFor } from './index.js';
import { UpdatesService } from './service.js';
import { compareVersions, normalizeVersion } from './version.js';

const NOW = new Date('2026-10-26T12:00:00Z');

interface FakeApi {
  releases: unknown[] | (() => Response);
  tags?: string[] | null;
  calls: string[];
}

/** A fake api.github.com + ghcr.io answering from in-memory data. */
function fakeFetch(api: FakeApi): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    api.calls.push(`${url.host}${url.pathname}`);
    const headers = new Headers(init?.headers);
    if (url.host === 'api.github.com' && /^\/repos\/[^/]+\/[^/]+\/releases$/.test(url.pathname)) {
      expect(headers.get('user-agent')).toMatch(/^Arclight\//);
      if (typeof api.releases === 'function') return api.releases();
      return Response.json(api.releases);
    }
    if (url.host === 'ghcr.io' && url.pathname === '/token') {
      if (api.tags === null) return new Response('nope', { status: 500 });
      return Response.json({ token: 'anon' });
    }
    if (url.host === 'ghcr.io' && url.pathname.endsWith('/tags/list')) {
      expect(headers.get('authorization')).toBe('Bearer anon');
      return Response.json({ name: 'zacheryabrewer/arclight', tags: api.tags ?? [] });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `Arclight ${tag}`,
  body: `## ${tag}\n- things`,
  html_url: `https://github.com/zacheryabrewer/arclight/releases/tag/${tag}`,
  draft: false,
  prerelease: tag.includes('-'),
  published_at: '2026-10-01T00:00:00Z',
  ...extra,
});

async function setup(api: FakeApi, currentVersion = '0.2.0', isDocker = true) {
  const db = await createTestDb();
  let now = NOW;
  const service = new UpdatesService({ db, currentVersion, isDocker, fetchImpl: fakeFetch(api), now: () => now });
  return { db, service, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('version ordering', () => {
  it('orders releases and pre-releases by semver precedence', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('0.1.0-dev', '0.1.0')).toBeLessThan(0);
    expect(compareVersions('nonsense', '0.0.1')).toBeLessThan(0);
    expect(normalizeVersion('v0.2.0')).toBe('0.2.0');
    expect(normalizeVersion('latest')).toBeNull();
  });
});

describe('UpdatesService', () => {
  it('reports the newest stable release whose image is published', async () => {
    const api: FakeApi = {
      releases: [release('v0.4.0-rc.1'), release('v0.3.1'), release('v0.3.0'), release('v0.2.0'), release('v0.5.0', { draft: true })],
      // 0.3.1 is tagged on GitHub but CI has not pushed its image yet.
      tags: ['v0.3.0', 'v0.2.0', '0.3', 'latest', 'develop'],
      calls: [],
    };
    const { service } = await setup(api);
    expect(service.info()).toMatchObject({ checkedAt: null, updateAvailable: false, releases: [] });
    const info = await service.check();
    expect(info).toMatchObject({
      currentVersion: '0.2.0',
      latestVersion: '0.3.0',
      imageTag: 'v0.3.0',
      image: 'ghcr.io/zacheryabrewer/arclight',
      updateAvailable: true,
      checkedAt: NOW.toISOString(),
      channel: 'stable',
    });
    expect(info.releaseNotes).toContain('## v0.3.0');
    expect(info.releases.map((r) => r.version)).toEqual(['0.3.0']);
    expect(api.calls).toEqual(['api.github.com/repos/zacheryabrewer/arclight/releases', 'ghcr.io/token', 'ghcr.io/v2/zacheryabrewer/arclight/tags/list']);
  });

  it('includes pre-releases and the develop tag on the develop channel', async () => {
    const api: FakeApi = { releases: [release('v0.4.0-rc.1'), release('v0.3.0')], tags: ['v0.4.0-rc.1', 'v0.3.0', 'develop'], calls: [] };
    const { service } = await setup(api, '0.3.0');
    service.updateSettings({ channel: 'develop' });
    const info = await service.check();
    expect(info).toMatchObject({ latestVersion: '0.4.0-rc.1', imageTag: 'develop', updateAvailable: true, channel: 'develop' });
    expect(info.releases[0]).toMatchObject({ prerelease: true, imageTag: 'v0.4.0-rc.1' });
  });

  it('counts every release when GHCR cannot be read, and shows recent notes when current', async () => {
    const api: FakeApi = { releases: [release('v0.2.0'), release('v0.1.0')], tags: null, calls: [] };
    const { service } = await setup(api, '0.2.0');
    const info = await service.check();
    expect(info).toMatchObject({ latestVersion: '0.2.0', imageTag: 'v0.2.0', updateAvailable: false });
    expect(info.releases.map((r) => r.version)).toEqual(['0.2.0', '0.1.0']);
  });

  it('keeps the last good result and records the error when GitHub fails', async () => {
    let fail = false;
    const api: FakeApi = {
      releases: () => (fail ? new Response('slow down', { status: 403 }) : Response.json([release('v0.3.0')])),
      tags: ['v0.3.0'],
      calls: [],
    };
    const { service, advance } = await setup(api);
    await service.check();
    fail = true;
    advance(60_000);
    const info = await service.check();
    expect(info).toMatchObject({ latestVersion: '0.3.0', updateAvailable: true, checkedAt: NOW.toISOString() });
    expect(info.error).toMatch(/rate-limited/);
    fail = false;
    expect((await service.check()).error).toBeUndefined();
  });

  it('is due once per interval and never when disabled', async () => {
    const api: FakeApi = { releases: [release('v0.2.0')], tags: ['v0.2.0'], calls: [] };
    const { service, advance } = await setup(api);
    expect(service.isDue()).toBe(true);
    await service.check();
    expect(service.isDue()).toBe(false);
    advance(23 * 3_600_000);
    expect(service.isDue()).toBe(false);
    advance(3_600_000);
    expect(service.isDue()).toBe(true);
    service.updateSettings({ checkIntervalHours: 1 });
    service.updateSettings({ enabled: false });
    expect(service.isDue()).toBe(false);
  });

  it('forgets a cache built for another repository', async () => {
    const api: FakeApi = { releases: [release('v0.3.0')], tags: ['v0.3.0'], calls: [] };
    const { service } = await setup(api);
    await service.check();
    service.updateSettings({ repo: 'someone/fork' });
    expect(service.info()).toMatchObject({ checkedAt: null, updateAvailable: false, repo: 'someone/fork', image: 'ghcr.io/someone/fork' });
  });

  it('rejects an invalid repository name', async () => {
    const { service } = await setup({ releases: [], calls: [] });
    expect(() => service.updateSettings({ repo: 'not a repo' })).toThrow(/owner\/name/);
  });
});

describe('UpdateAvailable health check', () => {
  it('warns while an update is available and notifyOnUpdate is on', async () => {
    const api: FakeApi = { releases: [release('v0.3.0')], tags: ['v0.3.0'], calls: [] };
    const { service } = await setup(api);
    const check = createUpdateAvailableCheck(() => service);
    // The check never needs HealthDeps.
    const run = () => check.run({} as never);
    expect(await run()).toEqual([]);
    await service.check();
    const out = await run();
    expect(out).toEqual([
      expect.objectContaining({ source: 'UpdateAvailable', status: 'warning', wikiUrl: '/docs/system/health#update-available' }),
    ]);
    expect(out[0]!.message).toContain('ghcr.io/zacheryabrewer/arclight:v0.3.0');
    service.updateSettings({ notifyOnUpdate: false });
    expect(await run()).toEqual([]);
  });
});

describe('updates module routes', () => {
  it('serves GET /system/update, POST /system/update/check and the settings section', async () => {
    const db = await createTestDb();
    const bus = new EventBus();
    const log = pino({ level: 'silent' });
    const ctx: AppContext = {
      config: { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null },
      db,
      bus,
      scheduler: new Scheduler(db, bus, log),
      log,
      startedAt: NOW,
    };
    const api: FakeApi = { releases: [release('v99.0.0')], tags: ['v99.0.0'], calls: [] };
    updatesServiceFor(ctx, { fetchImpl: fakeFetch(api), currentVersion: '1.0.0', now: () => NOW });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(updatesModule(ctx), { prefix: '/api/v1' });

    const before = await app.inject({ method: 'GET', url: '/api/v1/system/update' });
    expect(before.statusCode).toBe(200);
    expect(before.json<UpdateInfo>()).toMatchObject({ currentVersion: '1.0.0', updateAvailable: false, checkedAt: null, isDocker: false });

    const checked = await app.inject({ method: 'POST', url: '/api/v1/system/update/check' });
    expect(checked.json<UpdateInfo>()).toMatchObject({ latestVersion: '99.0.0', updateAvailable: true });

    const settings = await app.inject({ method: 'PUT', url: '/api/v1/settings/updates', payload: { checkIntervalHours: 6 } });
    expect(settings.json()).toMatchObject({ enabled: true, repo: 'zacheryabrewer/arclight', channel: 'stable', checkIntervalHours: 6, notifyOnUpdate: true });
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/settings/updates', payload: { checkIntervalHours: 0 } });
    expect(bad.statusCode).toBe(400);
    expect(ctx.scheduler.has(UPDATE_CHECK_JOB)).toBe(true);
    await app.close();
  });
});
