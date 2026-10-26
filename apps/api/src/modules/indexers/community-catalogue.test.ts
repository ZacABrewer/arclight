import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import {
  categoryGroupOf,
  categoryGroupsOf,
  CommunityCatalogueSettings,
  IndexerCatalogue,
  IndexerCatalogueEntryDetail,
  type CommunityCatalogueSettingsInput,
} from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { indexerCatalogueEmptyCheck } from '../health/checks/feeds.js';
import type { HealthDeps } from '../health/types.js';
import { buildCatalogue, catalogueEntry } from './catalogue.js';
import { CommunityCatalogue, gitBlobSha1, parseListing, reasonKey } from './community-catalogue.js';
import { definitionSha256 } from './definition-feed.js';
import { DefinitionStore } from './definitions.js';
import { communityCatalogueCronFor } from './jobs.js';
import { indexersRoutes } from './routes.js';
import { IndexersService } from './service.js';

// Community catalogue against an in-memory "GitHub": a contents-API listing plus raw files,
// served by a fake fetch (no network). Fixture definitions: packages/indexers/fixtures/community.

const FIXTURES = fileURLToPath(new URL('../../../../../packages/indexers/fixtures/community/', import.meta.url));
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');
const LISTING = 'https://catalogue.test/contents/definitions/v11';
const RAW = 'https://catalogue.test/raw/';

interface FakeHub {
  files: Map<string, string>;
  etag: string | null;
  /** Names whose raw download answers 500. */
  broken: Set<string>;
  /** Names whose listing hash is wrong. */
  badHash: Set<string>;
  requests: Array<{ url: string; ifNoneMatch: string | null }>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

function fakeHub(): FakeHub {
  const hub: FakeHub = {
    files: new Map(),
    etag: '"listing-1"',
    broken: new Set(),
    badHash: new Set(),
    requests: [],
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const ifNoneMatch = headers.get('if-none-match');
      hub.requests.push({ url: input, ifNoneMatch });
      if (input === LISTING) {
        if (hub.etag && ifNoneMatch === hub.etag) return new Response(null, { status: 304 });
        const body = [...hub.files].map(([name, text]) => ({
          name,
          type: 'file',
          size: Buffer.byteLength(text),
          sha: hub.badHash.has(name) ? '0'.repeat(40) : gitBlobSha1(Buffer.from(text)),
          download_url: `${RAW}${name}`,
        }));
        body.push({ name: 'schema.json', type: 'file', size: 2, sha: 'a'.repeat(40), download_url: `${RAW}schema.json` });
        return new Response(JSON.stringify(body), { status: 200, headers: hub.etag ? { etag: hub.etag } : {} });
      }
      if (input.startsWith(RAW)) {
        const name = input.slice(RAW.length);
        if (hub.broken.has(name)) return new Response('boom', { status: 500 });
        const text = hub.files.get(name);
        return text === undefined ? new Response('missing', { status: 404 }) : new Response(text, { status: 200 });
      }
      return new Response('unknown', { status: 404 });
    },
  };
  return hub;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(settings: CommunityCatalogueSettingsInput = {}) {
  const hub = fakeHub();
  for (const name of ['alphatracker.yml', 'betaprivate.yml', 'gammamismatch.yml', 'deltahyphen.yml', 'broken.yml']) hub.files.set(name, await fixture(name));
  // A community copy of a builtin id: the builtin must win.
  hub.files.set('yts.yml', (await fixture('alphatracker.yml')).replace('id: alphatracker', 'id: yts').replace('name: AlphaTracker', 'name: YTS community copy'));
  const config = await mkdtemp(join(tmpdir(), 'arclight-community-'));
  dirs.push(config);
  const customDir = join(config, 'definitions');
  const communityDir = join(customDir, 'community');
  let current = CommunityCatalogueSettings.parse({ url: LISTING, ...settings });
  const store = new DefinitionStore({ customDir, feedDir: join(customDir, 'feed'), communityDir, communityEnabled: () => current.enabled });
  await store.ready();
  const catalogue = new CommunityCatalogue({ store, dir: communityDir, settings: () => current, fetch: hub.fetch, log: pino({ level: 'silent' }) });
  return {
    hub,
    store,
    catalogue,
    communityDir,
    set: (next: CommunityCatalogueSettingsInput) => {
      current = CommunityCatalogueSettings.parse({ ...current, ...next });
    },
  };
}

const ctxFor = (store: DefinitionStore) => ({ store, community: async () => ({ enabled: true, lastSuccessAt: null, lastError: null }) });

describe('community catalogue sync', () => {
  it('installs every listed definition and loads them below builtin', async () => {
    const t = await setup();
    const r = await t.catalogue.sync();
    expect(r).toMatchObject({ notModified: false, added: 6, updated: 0, removed: 0, unchanged: 0, failed: [], total: 6 });
    expect((await readdir(t.communityDir)).filter((n) => n.endsWith('.yml')).sort()).toEqual([
      'alphatracker.yml',
      'betaprivate.yml',
      'broken.yml',
      'deltahyphen.yml',
      'gammamismatch.yml',
      'yts.yml',
    ]);
    expect(t.store.source('alphatracker')).toBe('community');
    expect(t.store.source('deltahyphen')).toBe('community');
    // builtin wins over the community copy
    expect(t.store.source('yts')).toBe('builtin');
    expect(t.store.get('yts')?.name).not.toMatch(/community/);
    expect(t.store.overrides('yts')).toEqual(['community']);

    const status = await t.catalogue.status();
    expect(status).toMatchObject({ files: 6, supported: 4, limited: 1, unsupported: 2, overridden: 1, sourceUrl: LISTING, stale: false, previousAvailable: false });
    expect(status.topReasons.map((x) => x.reason)).toEqual(
      expect.arrayContaining([expect.stringMatching(/captcha/), expect.stringMatching(/does not match file name/), expect.stringMatching(/Invalid YAML/)]),
    );
  });

  it('lists unsupported files with their reason and limited ones with theirs', async () => {
    const t = await setup();
    await t.catalogue.sync();
    const cat = IndexerCatalogue.parse(await buildCatalogue(ctxFor(t.store)));
    const byId = new Map(cat.entries.map((e) => [e.key, e]));
    expect(byId.get('definition:alphatracker')).toMatchObject({ source: 'community', support: 'supported', privacy: 'public', categoryGroups: ['movies', 'tv'] });
    expect(byId.get('definition:betaprivate')).toMatchObject({ support: 'limited', supportReason: expect.stringMatching(/captcha/), categoryGroups: ['anime', 'music'] });
    expect(byId.get('definition:gammamismatch')).toMatchObject({
      support: 'unsupported',
      name: 'GammaMismatch',
      privacy: 'semi-private',
      language: 'fr-FR',
      supportReason: expect.stringMatching(/does not match file name/),
    });
    expect(byId.get('definition:broken')).toMatchObject({ support: 'unsupported', name: 'broken', source: 'community' });
    expect(byId.get('definition:yts')).toMatchObject({ source: 'builtin', overrides: ['community'] });
    expect(byId.get('generic:newznab')).toMatchObject({ kind: 'generic', protocol: 'usenet' });
    expect(byId.get('preset:nzbgeek')).toMatchObject({ kind: 'preset', source: 'preset', preset: { implementation: 'newznab', baseUrl: 'https://api.nzbgeek.info' } });
    expect(cat.counts.unsupported).toBe(2);
    expect(cat.counts.supported).toBe(cat.counts.total - 2);
    expect(cat.counts.bySource['community']).toBe(5);

    const detail = IndexerCatalogueEntryDetail.parse(await catalogueEntry(ctxFor(t.store), 'definition:gammamismatch'));
    expect(detail.file).toBe('gammamismatch.yml');
    const alpha = await catalogueEntry(ctxFor(t.store), 'definition:alphatracker');
    expect(alpha.searchModes).toEqual(expect.arrayContaining(['search', 'tv-search', 'movie-search']));
  });

  it('revalidates the listing with its ETag and downloads nothing on 304', async () => {
    const t = await setup();
    await t.catalogue.sync();
    t.hub.requests.length = 0;
    const r = await t.catalogue.sync();
    expect(r).toMatchObject({ notModified: true, total: 6 });
    expect(t.hub.requests).toEqual([{ url: LISTING, ifNoneMatch: '"listing-1"' }]);
  });

  it('downloads only changed files and keeps the replaced copy for rollback', async () => {
    const t = await setup();
    await t.catalogue.sync();
    t.hub.files.set('alphatracker.yml', (await fixture('alphatracker.yml')).replace('Public test tracker for movies and TV', 'Changed upstream'));
    t.hub.files.delete('broken.yml');
    t.hub.etag = '"listing-2"';
    t.hub.requests.length = 0;
    const r = await t.catalogue.sync();
    expect(r).toMatchObject({ added: 0, updated: 1, removed: 1, unchanged: 4, total: 5 });
    expect(t.hub.requests.map((q) => q.url)).toEqual([LISTING, `${RAW}alphatracker.yml`]);
    expect(t.store.get('alphatracker')?.description).toBe('Changed upstream');

    const after = await t.catalogue.rollback();
    expect(after.files).toBe(6);
    expect(t.store.get('alphatracker')?.description).toBe('Public test tracker for movies and TV');
    // The rolled-back copy stays while the listing is unchanged.
    const again = await t.catalogue.sync();
    expect(again.notModified).toBe(true);
    expect(t.store.get('alphatracker')?.description).toBe('Public test tracker for movies and TV');
  });

  it('keeps the old copy of a file that fails to download or verify', async () => {
    const t = await setup();
    await t.catalogue.sync();
    t.hub.files.set('alphatracker.yml', (await fixture('alphatracker.yml')).replace('Public test tracker', 'New'));
    t.hub.files.set('deltahyphen.yml', (await fixture('deltahyphen.yml')).replace('Public XXX', 'New'));
    t.hub.broken.add('alphatracker.yml');
    t.hub.badHash.add('deltahyphen.yml');
    t.hub.files.set('epsilon.yml', (await fixture('alphatracker.yml')).replace('id: alphatracker', 'id: epsilon'));
    t.hub.etag = '"listing-3"';
    const r = await t.catalogue.sync();
    expect(r.failed.map((f) => f.file).sort()).toEqual(['alphatracker.yml', 'deltahyphen.yml']);
    expect(r.failed.find((f) => f.file === 'deltahyphen.yml')?.reason).toMatch(/hash mismatch/);
    expect(r.added).toBe(1);
    expect(t.store.get('alphatracker')?.description).toBe('Public test tracker for movies and TV');
    expect(t.store.get('epsilon')).toBeDefined();
    // Failures clear the ETag so they are retried even if the listing does not change.
    t.hub.broken.clear();
    t.hub.badHash.clear();
    const retry = await t.catalogue.sync();
    expect(retry.notModified).toBe(false);
    expect(retry.updated).toBe(2);
    expect(t.store.get('alphatracker')?.description).toBe('New for movies and TV');
  });

  it('fails without touching the live copy when every download fails or the listing is bad', async () => {
    const t = await setup();
    for (const name of t.hub.files.keys()) t.hub.broken.add(name);
    await expect(t.catalogue.sync()).rejects.toThrow(/every download failed/);
    let status = await t.catalogue.status();
    expect(status).toMatchObject({ files: 0, lastSuccessAt: null, stale: true });
    expect(status.lastError).toMatch(/every download failed/);

    t.hub.broken.clear();
    await t.catalogue.sync();
    const fetchBad = t.hub.fetch;
    t.hub.fetch = async (input, init) => (input === LISTING ? new Response('{"nope":1}', { status: 200 }) : fetchBad(input, init));
    const t2 = new CommunityCatalogue({ store: t.store, dir: t.communityDir, settings: () => CommunityCatalogueSettings.parse({ url: LISTING }), fetch: t.hub.fetch });
    await expect(t2.sync()).rejects.toThrow(/neither a contents array nor a definition index/);
    status = await t2.status();
    expect(status.files).toBe(6);
    expect(t.store.get('alphatracker')).toBeDefined();
  });

  it('reports a rate-limited listing with its reset time', async () => {
    const t = await setup();
    const c = new CommunityCatalogue({
      store: t.store,
      dir: t.communityDir,
      settings: () => CommunityCatalogueSettings.parse({ url: LISTING }),
      fetch: async () => new Response('limit', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } }),
    });
    await expect(c.sync()).rejects.toThrow(/HTTP 403 \(rate limited until 2027-01-15T08:00:00.000Z\)/);
  });

  it('turned off: nothing is loaded or fetched', async () => {
    const t = await setup();
    await t.catalogue.sync();
    t.set({ enabled: false });
    await t.store.reload();
    expect(t.store.get('alphatracker')).toBeUndefined();
    expect(t.store.communityFailures()).toEqual([]);
    expect((await t.catalogue.status()).supported).toBe(0);
    await expect(t.catalogue.sync()).rejects.toThrow(/turned off/);
    expect(await t.catalogue.due()).toBe(false);
    expect(communityCatalogueCronFor({ enabled: false, intervalHours: 24 })).toBeNull();
    expect(communityCatalogueCronFor({ enabled: true, intervalHours: 24 })).toBe('23 4 * * *');
  });
});

describe('listing formats', () => {
  it('reads a GitHub contents array, skipping folders and non-YAML files', () => {
    const files = parseListing(
      [
        { name: 'a.yml', type: 'file', sha: 'b'.repeat(40), size: 10, download_url: 'https://raw.test/a.yml' },
        { name: 'sub', type: 'dir', sha: 'c'.repeat(40), download_url: null },
        { name: 'schema.json', type: 'file', sha: 'd'.repeat(40), download_url: 'https://raw.test/schema.json' },
        { name: '../evil.yml', type: 'file', sha: 'e'.repeat(40), download_url: 'https://raw.test/evil.yml' },
      ],
      LISTING,
    );
    expect(files).toEqual([{ name: 'a.yml', url: 'https://raw.test/a.yml', hash: 'b'.repeat(40), hashKind: 'git-sha1', size: 10 }]);
  });

  it('reads an Arclight feed index (sha256 over LF text)', () => {
    const files = parseListing({ schemaVersion: 1, definitions: [{ id: 'x', version: '1', file: 'defs/x.yml', sha256: definitionSha256('a: 1\n') }] }, 'https://mirror.test/feed/index.json');
    expect(files).toEqual([{ name: 'x.yml', url: 'https://mirror.test/feed/defs/x.yml', hash: definitionSha256('a: 1\n'), hashKind: 'sha256' }]);
  });

  it('git blob hash matches git', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha1(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('groups reasons without their quoted values', () => {
    expect(reasonKey('id "darkpeers-api" does not match file name "darkpeers" (at id)')).toBe('id "…" does not match file name "…"');
  });

  it('maps standard categories to chooser groups', () => {
    expect(categoryGroupOf(2040)).toBe('movies');
    expect(categoryGroupOf(5070)).toBe('anime');
    expect(categoryGroupOf(5040)).toBe('tv');
    expect(categoryGroupOf(100_123)).toBe('other');
    expect(categoryGroupsOf([7020, 2000, 3010, 6000, 8000])).toEqual(['movies', 'music', 'books', 'xxx', 'other']);
  });
});

describe('catalogue routes', () => {
  async function app() {
    const t = await setup();
    await t.catalogue.sync();
    const db = await createTestDb();
    const service = new IndexersService({ db, log: pino({ level: 'silent' }), definitions: t.store });
    let saved = CommunityCatalogueSettings.parse({ url: LISTING });
    const server = Fastify().withTypeProvider<ZodTypeProvider>();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    await server.register(
      indexersRoutes(service, {
        catalogue: { community: async () => ({ enabled: saved.enabled, lastSuccessAt: (await t.catalogue.lastSync()).lastSuccessAt, lastError: null }) },
        community: {
          catalogue: t.catalogue,
          getSettings: () => saved,
          updateSettings: async (v) => {
            saved = v;
            t.set(v);
            await t.store.reload();
            return saved;
          },
        },
      }),
      { prefix: '/api/v1' },
    );
    return { server, t };
  }

  it('serves the catalogue with an ETag and answers 304 to If-None-Match', async () => {
    const { server } = await app();
    const res = await server.inject({ method: 'GET', url: '/api/v1/indexer/catalogue' });
    expect(res.statusCode).toBe(200);
    const body = IndexerCatalogue.parse(res.json());
    expect(res.headers['etag']).toBe(body.etag);
    expect(body.community.enabled).toBe(true);
    const again = await server.inject({ method: 'GET', url: '/api/v1/indexer/catalogue', headers: { 'if-none-match': body.etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('serves entry details, community status, settings and sync', async () => {
    const { server } = await app();
    const entry = await server.inject({ method: 'GET', url: `/api/v1/indexer/catalogue/entry/${encodeURIComponent('definition:betaprivate')}` });
    expect(entry.json()).toMatchObject({ support: 'limited', requiresLogin: true });
    expect((await server.inject({ method: 'GET', url: '/api/v1/indexer/catalogue/entry/definition%3Anope' })).statusCode).toBe(404);
    const status = await server.inject({ method: 'GET', url: '/api/v1/indexer/catalogue/community/status' });
    expect(status.json()).toMatchObject({ files: 6, unsupported: 2 });
    const sync = await server.inject({ method: 'POST', url: '/api/v1/indexer/catalogue/community/sync' });
    expect(sync.json()).toMatchObject({ notModified: true });

    const before = IndexerCatalogue.parse((await server.inject({ method: 'GET', url: '/api/v1/indexer/catalogue' })).json());
    const put = await server.inject({ method: 'PUT', url: '/api/v1/indexer/catalogue/community/settings', payload: { enabled: false, url: LISTING, intervalHours: 12 } });
    expect(put.json()).toEqual({ enabled: false, url: LISTING, intervalHours: 12 });
    const after = IndexerCatalogue.parse((await server.inject({ method: 'GET', url: '/api/v1/indexer/catalogue' })).json());
    expect(after.etag).not.toBe(before.etag);
    expect(after.entries.some((e) => e.source === 'community')).toBe(false);
    const syncOff = await server.inject({ method: 'POST', url: '/api/v1/indexer/catalogue/community/sync' });
    expect(syncOff.statusCode).toBe(400);
    const badPut = await server.inject({ method: 'PUT', url: '/api/v1/indexer/catalogue/community/settings', payload: { enabled: true, url: 'not a url', intervalHours: 12 } });
    expect(badPut.statusCode).toBe(400);
  });
});

describe('IndexerCatalogueEmpty health check', () => {
  const run = (c: Awaited<ReturnType<NonNullable<HealthDeps['indexerCatalogue']>>>) =>
    indexerCatalogueEmptyCheck.run({ indexerCatalogue: async () => c } as unknown as HealthDeps);

  it('warns when a synced catalogue has nothing that loads', async () => {
    expect(await run({ enabled: true, lastSuccessAt: '2026-10-26T00:00:00Z', files: 0, supported: 0 })).toEqual([
      expect.objectContaining({ source: 'IndexerCatalogueEmpty', status: 'warning', message: expect.stringMatching(/has no definitions/) }),
    ]);
    expect(await run({ enabled: true, lastSuccessAt: '2026-10-26T00:00:00Z', files: 4, supported: 0 })).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/4 definition files but none of them load/) }),
    ]);
  });

  it('is quiet when off, never synced or healthy', async () => {
    expect(await run({ enabled: false, lastSuccessAt: '2026-10-26T00:00:00Z', files: 0, supported: 0 })).toEqual([]);
    expect(await run({ enabled: true, lastSuccessAt: null, files: 0, supported: 0 })).toEqual([]);
    expect(await run({ enabled: true, lastSuccessAt: '2026-10-26T00:00:00Z', files: 5, supported: 3 })).toEqual([]);
  });
});
