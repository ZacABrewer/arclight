import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_DEFINITIONS_DIR, DefinitionCatalogue } from '@arclight/indexers';
import { DEFAULT_DEFINITION_FEED_URL, DefinitionFeedIndex, DefinitionFeedSettings, type DefinitionFeedSettingsInput } from '@arclight/shared';
import type { NotificationEvent } from '@arclight/notifications';
import { createTestDb } from '../../db/test-utils.js';
import { feedsRegistry, summarize } from '../../feeds.js';
import { getDefinitionFeedSettings, getIndexerGlobalSettings, updateDefinitionFeedSettings, updateIndexerGlobalSettings } from '../settings/service.js';
import { DefinitionFeed, definitionSha256 } from './definition-feed.js';
import { DefinitionStore } from './definitions.js';
import { definitionFeedCronFor } from './jobs.js';
import { indexersRoutes } from './routes.js';
import { IndexersService } from './service.js';

// Definition feed against a fake feed server (node:http on 127.0.0.1, port 0).

const NYAA = await readFile(join(BUILTIN_DEFINITIONS_DIR, 'nyaa.yml'), 'utf8');

/** A valid definition derived from the builtin nyaa.yml with another id/name/description. */
function yamlFor(id: string, description = 'feed copy'): string {
  return NYAA.replace(/^id: nyaa$/m, `id: ${id}`)
    .replace(/^name: Nyaa$/m, `name: ${id.toUpperCase()}`)
    .replace(/^description: .*$/m, `description: "${description}"`);
}

interface FeedServer {
  url: string;
  files: Map<string, { body: string; etag?: string; status?: number }>;
  requests: Array<{ path: string; ifNoneMatch: string | undefined }>;
  close(): Promise<void>;
}

const servers: FeedServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function feedServer(): Promise<FeedServer> {
  const files: FeedServer['files'] = new Map();
  const requests: FeedServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').replace(/^\/feed\//, '');
    const ifNoneMatch = req.headers['if-none-match'];
    requests.push({ path, ifNoneMatch: typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined });
    const f = files.get(path);
    if (!f) {
      res.writeHead(404).end('not found');
      return;
    }
    if (f.etag && ifNoneMatch === f.etag) {
      res.writeHead(304, { etag: f.etag }).end();
      return;
    }
    res.writeHead(f.status ?? 200, f.etag ? { etag: f.etag } : {}).end(f.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const s: FeedServer = {
    url: `http://127.0.0.1:${port}/feed/`,
    files,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  servers.push(s);
  return s;
}

/** Publish definitions (id → yaml) plus a matching index.json. */
function publish(server: FeedServer, defs: Record<string, string>, opts: { etag?: string; badSha?: string[] } = {}): void {
  for (const key of [...server.files.keys()]) server.files.delete(key);
  const definitions = Object.entries(defs).map(([id, yaml]) => {
    server.files.set(`${id}.yml`, { body: yaml });
    const sha256 = opts.badSha?.includes(id) ? '0'.repeat(64) : definitionSha256(yaml);
    return { id, version: sha256.slice(0, 8), file: `${id}.yml`, sha256 };
  });
  server.files.set('index.json', { body: JSON.stringify({ schemaVersion: 1, definitions }), ...(opts.etag ? { etag: opts.etag } : {}) });
}

async function setup(settings: DefinitionFeedSettingsInput = {}) {
  const server = await feedServer();
  const config = await mkdtemp(join(tmpdir(), 'arclight-feed-'));
  dirs.push(config);
  const customDir = join(config, 'definitions');
  const feedDir = join(customDir, 'feed');
  const store = new DefinitionStore({ customDir, feedDir });
  await store.ready();
  const current = DefinitionFeedSettings.parse({ url: server.url, ...settings });
  const notifications: NotificationEvent[] = [];
  const feed = new DefinitionFeed({
    store,
    feedDir,
    settings: () => current,
    log: pino({ level: 'silent' }),
    notify: async (e) => {
      notifications.push(e);
    },
  });
  return { server, store, feed, feedDir, customDir, notifications };
}

describe('definition feed sync', () => {
  it('installs new definitions and hot-reloads the catalogue', async () => {
    const t = await setup();
    publish(t.server, { 'feed-one': yamlFor('feed-one') });
    const r = await t.feed.sync();
    expect(r).toMatchObject({ added: ['feed-one'], updated: [], removed: [], rejected: [], notModified: false });
    expect(t.store.get('feed-one')).toBeDefined();
    expect(t.store.source('feed-one')).toBe('feed');
    expect(t.store.status().feed).toBe(1);
    expect(t.notifications).toHaveLength(1);
  });

  it('feed overrides a builtin definition with the same id', async () => {
    const t = await setup();
    publish(t.server, { nyaa: yamlFor('nyaa', 'from the feed') });
    await t.feed.sync();
    expect(t.store.source('nyaa')).toBe('feed');
    expect(t.store.get('nyaa')?.description).toBe('from the feed');
  });

  it('a user definition overrides the feed', async () => {
    const t = await setup();
    publish(t.server, { 'feed-one': yamlFor('feed-one', 'feed') });
    await t.feed.sync();
    await mkdir(t.customDir, { recursive: true });
    await writeFile(join(t.customDir, 'feed-one.yml'), yamlFor('feed-one', 'mine'));
    await t.store.reload();
    expect(t.store.source('feed-one')).toBe('custom');
    expect(t.store.get('feed-one')?.description).toBe('mine');
    expect((await t.feed.status()).installed[0]).toMatchObject({ id: 'feed-one', active: false });
  });

  it('updates a changed definition and keeps the previous version', async () => {
    const t = await setup();
    publish(t.server, { 'feed-one': yamlFor('feed-one', 'v1') });
    await t.feed.sync();
    publish(t.server, { 'feed-one': yamlFor('feed-one', 'v2') });
    const r = await t.feed.sync();
    expect(r.updated).toEqual(['feed-one']);
    expect(t.store.get('feed-one')?.description).toBe('v2');
    const status = await t.feed.status();
    expect(status.installed[0]?.previousVersion).toBe(definitionSha256(yamlFor('feed-one', 'v1')).slice(0, 8));
    expect(await readFile(join(t.feedDir, '.previous', 'feed-one.yml'), 'utf8')).toContain('v1');
  });

  it('leaves unchanged definitions alone (no download)', async () => {
    const t = await setup();
    publish(t.server, { 'feed-one': yamlFor('feed-one'), 'feed-two': yamlFor('feed-two') });
    await t.feed.sync();
    t.server.requests.length = 0;
    const r = await t.feed.sync();
    expect(r).toMatchObject({ unchanged: 2, added: [], updated: [] });
    expect(t.server.requests.map((q) => q.path)).toEqual(['index.json']);
  });

  it('uses the index ETag: 304 means nothing to do', async () => {
    const t = await setup();
    publish(t.server, { 'feed-one': yamlFor('feed-one') }, { etag: '"v1"' });
    await t.feed.sync();
    const r = await t.feed.sync();
    expect(r.notModified).toBe(true);
    expect(t.server.requests.at(-1)).toEqual({ path: 'index.json', ifNoneMatch: '"v1"' });
  });

  it('rejects a file whose sha256 does not match the index', async () => {
    const t = await setup();
    publish(t.server, { 'feed-one': yamlFor('feed-one'), 'feed-bad': yamlFor('feed-bad') }, { badSha: ['feed-bad'] });
    const r = await t.feed.sync();
    expect(r.added).toEqual(['feed-one']);
    expect(r.rejected).toEqual([expect.objectContaining({ id: 'feed-bad', reason: expect.stringMatching(/sha256 mismatch/) })]);
    expect(t.store.get('feed-bad')).toBeUndefined();
    expect((await t.feed.status()).rejected).toHaveLength(1);
  });

  it('rejects invalid YAML and an id that differs from the index, keeping the installed version', async () => {
    const t = await setup();
    publish(t.server, { 'feed-one': yamlFor('feed-one', 'good') });
    await t.feed.sync();
    publish(t.server, { 'feed-one': 'id: feed-one\nname: [unclosed', 'feed-two': yamlFor('other-id') });
    const r = await t.feed.sync();
    expect(r.rejected.map((x) => x.id).sort()).toEqual(['feed-one', 'feed-two']);
    expect(r.rejected.find((x) => x.id === 'feed-two')?.reason).toMatch(/"other-id"/);
    expect(t.store.get('feed-one')?.description).toBe('good');
  });

  it('removes definitions the index no longer lists', async () => {
    const t = await setup();
    publish(t.server, { 'feed-one': yamlFor('feed-one'), 'feed-two': yamlFor('feed-two') });
    await t.feed.sync();
    publish(t.server, { 'feed-one': yamlFor('feed-one') });
    const r = await t.feed.sync();
    expect(r.removed).toEqual(['feed-two']);
    expect(t.store.get('feed-two')).toBeUndefined();
  });

  it('fails on an unsupported schemaVersion or a broken index and records the error', async () => {
    const t = await setup();
    t.server.files.set('index.json', { body: JSON.stringify({ schemaVersion: 99, definitions: [] }) });
    await expect(t.feed.sync()).rejects.toThrow(/schemaVersion 99/);
    t.server.files.set('index.json', { body: JSON.stringify({ schemaVersion: 1, definitions: [{ id: 'x', version: '1', file: '../x.yml', sha256: 'a'.repeat(64) }] }) });
    await expect(t.feed.sync()).rejects.toThrow(/invalid index/);
    t.server.files.delete('index.json');
    await expect(t.feed.sync()).rejects.toThrow(/HTTP 404/);
    const status = await t.feed.status();
    expect(status.lastError).toMatch(/HTTP 404/);
    expect(status.lastSuccessAt).toBeNull();
  });

  it('a 404 on the default feed index is info ("not published yet"), not an error or a stale feed', async () => {
    const config = await mkdtemp(join(tmpdir(), 'arclight-feed-'));
    dirs.push(config);
    const customDir = join(config, 'definitions');
    const feedDir = join(customDir, 'feed');
    const store = new DefinitionStore({ customDir, feedDir });
    await store.ready();
    const requested: string[] = [];
    const feed = new DefinitionFeed({
      store,
      feedDir,
      settings: () => DefinitionFeedSettings.parse({}),
      log: pino({ level: 'silent' }),
      fetch: async (url) => {
        requested.push(String(url));
        return new Response('404: Not Found', { status: 404 });
      },
    });
    await expect(feed.sync()).resolves.toMatchObject({ added: [], rejected: [] });
    expect(requested).toEqual([`${DEFAULT_DEFINITION_FEED_URL}index.json`]);
    const report = await feed.feedStatus();
    expect(report).toMatchObject({ lastError: null, notPublished: true });
    expect(report.detail).toContain('feed not published yet');
    // Never stale, however long it stays unpublished.
    const later = new Date(Date.now() + 30 * 24 * 3_600_000);
    expect(summarize('definitions', 'Indexer definitions', report, later, new Date(0)).state).toBe('never');
  });

  it('state survives a new DefinitionFeed instance (restart)', async () => {
    const t = await setup();
    publish(t.server, { 'feed-one': yamlFor('feed-one') });
    await t.feed.sync();
    const store = new DefinitionStore({ customDir: t.customDir, feedDir: t.feedDir });
    await store.ready();
    expect(store.source('feed-one')).toBe('feed');
    const again = new DefinitionFeed({ store, feedDir: t.feedDir, settings: () => DefinitionFeedSettings.parse({ url: t.server.url }) });
    expect((await again.status()).installed.map((i) => i.id)).toEqual(['feed-one']);
    expect((await again.sync()).unchanged).toBe(1);
  });
});

describe('definition feed rollback', () => {
  it('restores the previous version and holds the rolled-back version off', async () => {
    const t = await setup();
    publish(t.server, { 'feed-one': yamlFor('feed-one', 'v1') });
    await t.feed.sync();
    publish(t.server, { 'feed-one': yamlFor('feed-one', 'v2') });
    await t.feed.sync();
    const status = await t.feed.rollback('feed-one');
    expect(t.store.get('feed-one')?.description).toBe('v1');
    expect(status.installed[0]?.previousVersion).toBe(definitionSha256(yamlFor('feed-one', 'v2')).slice(0, 8));
    // The same v2 is still published: not re-installed.
    expect((await t.feed.sync()).unchanged).toBe(1);
    expect(t.store.get('feed-one')?.description).toBe('v1');
    // A newer v3 is installed again.
    publish(t.server, { 'feed-one': yamlFor('feed-one', 'v3') });
    expect((await t.feed.sync()).updated).toEqual(['feed-one']);
    expect(t.store.get('feed-one')?.description).toBe('v3');
  });

  it('refuses without a previous version or for unknown ids', async () => {
    const t = await setup();
    publish(t.server, { 'feed-one': yamlFor('feed-one') });
    await t.feed.sync();
    await expect(t.feed.rollback('feed-one')).rejects.toThrow(/no previous version/);
    await expect(t.feed.rollback('nope')).rejects.toThrow(/not installed/);
  });
});

describe('definition feed wiring', () => {
  it('builtin index.json is current and every entry parses (the repo can serve as its own feed)', async () => {
    const index = DefinitionFeedIndex.parse(JSON.parse(await readFile(join(BUILTIN_DEFINITIONS_DIR, 'index.json'), 'utf8')));
    const catalogue = await DefinitionCatalogue.fromDirectories([BUILTIN_DEFINITIONS_DIR]);
    expect(index.definitions.map((d) => d.id).sort()).toEqual(catalogue.ids());
    for (const d of index.definitions) {
      const text = await readFile(join(BUILTIN_DEFINITIONS_DIR, d.file), 'utf8');
      expect(definitionSha256(text), `${d.file}: run node scripts/build-definition-index.mjs`).toBe(d.sha256);
    }
    const script = fileURLToPath(new URL('../../../../../scripts/build-definition-index.mjs', import.meta.url));
    const { buildIndex } = (await import(script)) as { buildIndex: () => Promise<unknown> };
    expect(await buildIndex()).toEqual(index);
  });

  it('settings live in indexers.definitionFeed and survive Indexer options saves', async () => {
    const db = await createTestDb();
    expect(getDefinitionFeedSettings(db)).toMatchObject({ enabled: true, intervalHours: 12, mode: 'auto' });
    expect(getDefinitionFeedSettings(db).url).toBe('https://raw.githubusercontent.com/zacheryabrewer/arclight/main/packages/indexers/src/definitions/builtin/');
    updateDefinitionFeedSettings(db, { enabled: true, url: 'https://example.test/defs/', intervalHours: 6, mode: 'manual' });
    updateIndexerGlobalSettings(db, { ...getIndexerGlobalSettings(db), rssSyncIntervalMinutes: 30 });
    expect(getDefinitionFeedSettings(db)).toMatchObject({ url: 'https://example.test/defs/', mode: 'manual' });
    expect(getIndexerGlobalSettings(db)).not.toHaveProperty('definitionFeed');
    expect(definitionFeedCronFor({ enabled: true, mode: 'auto', intervalHours: 12 })).toBe('41 */12 * * *');
    expect(definitionFeedCronFor({ enabled: true, mode: 'manual', intervalHours: 12 })).toBeNull();
  });

  it('routes: status, sync, rollback errors and settings', async () => {
    const t = await setup();
    const db = await createTestDb();
    const service = new IndexersService({ db, definitions: t.store });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(
      indexersRoutes(service, {
        feed: { feed: t.feed, getSettings: () => getDefinitionFeedSettings(db), updateSettings: (v) => updateDefinitionFeedSettings(db, v) },
      }),
      { prefix: '/api/v1' },
    );
    publish(t.server, { 'feed-one': yamlFor('feed-one') });
    const sync = await app.inject({ method: 'POST', url: '/api/v1/indexer/definition/feed/sync' });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().added).toEqual(['feed-one']);
    const status = await app.inject({ method: 'GET', url: '/api/v1/indexer/definition/feed/status' });
    expect(status.json().installed[0]).toMatchObject({ id: 'feed-one', active: true });
    const def = await app.inject({ method: 'GET', url: '/api/v1/indexer/definition/feed-one' });
    expect(def.json().source).toBe('feed');
    expect((await app.inject({ method: 'POST', url: '/api/v1/indexer/definition/feed/rollback/feed-one' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/indexer/definition/feed/rollback/nope' })).statusCode).toBe(404);
    const settings = await app.inject({ method: 'GET', url: '/api/v1/indexer/definition/feed/settings' });
    const put = await app.inject({ method: 'PUT', url: '/api/v1/indexer/definition/feed/settings', payload: { ...(settings.json() as object), intervalHours: 3 } });
    expect(put.json().intervalHours).toBe(3);
    t.server.files.clear();
    expect((await app.inject({ method: 'POST', url: '/api/v1/indexer/definition/feed/sync' })).statusCode).toBe(502);
  });

  it('feeds registry: placeholders, stale after 3 intervals, never-succeeded feeds go stale from registration', async () => {
    const ctx = {};
    const reg = feedsRegistry(ctx);
    expect(feedsRegistry(ctx)).toBe(reg);
    const t0 = new Date('2026-10-01T00:00:00Z');
    const hour = 3_600_000;
    reg.register(
      { id: 'definitions', name: 'Indexer definitions', status: () => ({ enabled: true, intervalMs: 12 * hour, lastSyncAt: null, lastSuccessAt: null, lastError: 'HTTP 404' }) },
      t0,
    );
    const early = await reg.summary(new Date(t0.getTime() + hour));
    expect(early.map((f) => [f.id, f.state])).toEqual([
      ['guides', 'unregistered'],
      ['definitions', 'error'],
      ['updates', 'unregistered'],
      ['sceneMappings', 'unregistered'],
    ]);
    const late = await reg.summary(new Date(t0.getTime() + 37 * hour));
    expect(late.find((f) => f.id === 'definitions')?.state).toBe('stale');
    const ok = summarize('x', 'X', { enabled: true, intervalMs: hour, lastSyncAt: t0.toISOString(), lastSuccessAt: t0.toISOString(), lastError: null }, new Date(t0.getTime() + 2 * hour));
    expect(ok).toMatchObject({ state: 'ok', staleAfterMs: 3 * hour });
    expect(summarize('x', 'X', { enabled: false, intervalMs: hour, lastSyncAt: null, lastSuccessAt: null, lastError: null }, t0).state).toBe('disabled');
  });
});
