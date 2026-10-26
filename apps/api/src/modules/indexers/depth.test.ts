import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IndexerCreate, IndexerGlobalSettings, ReleaseResource } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { getSection, getIndexerGlobalSettings, updateIndexerGlobalSettings } from '../settings/service.js';
import { DefinitionStore } from './definitions.js';
import { INDEXER_STATS_CLEANUP_JOB, registerIndexerJobs, rescheduleRssSync, RSS_SYNC_JOB, rssCronFor } from './jobs.js';
import { indexersRoutes } from './routes.js';
import { indexerStats } from './schema.js';
import { IndexersService, type SearchGrabOutcome } from './service.js';
import type { TunnelOpener } from './proxies.js';

// ---- fixtures -----------------------------------------------------------------------

const T0 = Date.parse('2026-10-25T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

const TEST_DEF = `
id: testsite
name: TestSite
description: Private test tracker
language: en-US
type: private
links:
  - https://testsite.example/
settings:
  - {name: cookie, type: text, label: Cookie}
  - {name: freeleech, type: checkbox, label: Freeleech only, default: false}
  - {name: sort, type: select, label: Sort, default: added, options: {added: Added, size: Size}}
  - {name: info_note, type: info, label: About, default: "Paste your cookie"}
caps:
  categorymappings:
    - {id: 1, cat: Movies/HD, desc: "Movies HD"}
    - {id: 2, cat: TV/HD, desc: "TV HD"}
  modes:
    search: [q]
    tv-search: [q, season, ep]
    movie-search: [q]
login:
  method: cookie
search:
  paths:
    - path: browse.php
  inputs:
    q: "{{ .Keywords }}"
    sort: "{{ .Config.sort }}"
    free: "{{ if .Config.freeleech }}1{{ end }}"
  rows:
    selector: "table#t > tbody > tr"
  fields:
    category: {selector: "td.cat"}
    title: {selector: "td.name a"}
    details: {selector: "td.name a", attribute: href}
    download: {selector: "a.dl", attribute: href}
    size: {selector: "td.size"}
    seeders: {selector: "td.s"}
    leechers: {selector: "td.l"}
    date: {text: "2026-10-20T10:00:00Z"}
`;

const SITE_PAGE = `<html><body><table id="t"><tbody>
<tr><td class="cat">1</td><td class="name"><a href="details.php?id=1">Movie.One.2024.1080p.WEB-DL-GRP</a></td><td class="size">1.5 GB</td><td class="s">10</td><td class="l">2</td><td><a class="dl" href="download.php?id=1">dl</a></td></tr>
</tbody></table></body></html>`;

const TORRENT_BYTES = 'd8:announce3:urle';

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<caps><server title="Fake" /><limits default="50" max="100" />
<searching><search available="yes" supportedParams="q" /><tv-search available="yes" supportedParams="q,season,ep" /><movie-search available="yes" supportedParams="q" /></searching>
<categories><category id="2000" name="Movies"><subcat id="2040" name="Movies/HD" /></category><category id="5000" name="TV" /></categories></caps>`;

function feed(items: Array<{ title: string; guid: string; link: string }>): string {
  const body = items
    .map(
      (i) => `<item><title>${i.title}</title><guid>${i.guid}</guid><pubDate>${new Date(T0 - 3_600_000).toUTCString()}</pubDate>
<size>1000000000</size><link>${i.link}</link><category>2040</category><torznab:attr name="seeders" value="5" /></item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Fake</title>${body}</channel></rss>`;
}

interface Call {
  url: URL;
  method: string;
  cookie: string | null;
  body: string | undefined;
}

type Handler = (url: URL, call: Call) => Response | Promise<Response>;

class FakeNet {
  readonly calls: Call[] = [];
  readonly routes = new Map<string, Handler>();

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      cookie: headers.get('cookie'),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    this.calls.push(call);
    const handler = this.routes.get(url.hostname);
    if (!handler) throw new TypeError(`fetch failed: ${url.hostname}`);
    return handler(url, call);
  };

  to(host: string): Call[] {
    return this.calls.filter((c) => c.url.hostname === host);
  }
}

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const xml = (body: string) => new Response(body, { headers: { 'content-type': 'application/xml' } });
const torrent = () => new Response(new TextEncoder().encode(TORRENT_BYTES), { headers: { 'content-type': 'application/x-bittorrent' } });

let clock = T0;
let net: FakeNet;
let db: Db;
let dir: string;
let store: DefinitionStore;
let service: IndexersService;
let scheduler: Scheduler;
let app: FastifyInstance;
let tunnels: Array<{ type: string; host: string; port: number; target: string; targetPort: number }>;
let tunnelError: Error | null;

const openTunnel: TunnelOpener = async (proxy, host, port) => {
  tunnels.push({ type: proxy.type, host: proxy.host, port: proxy.port, target: host, targetPort: port });
  if (tunnelError) throw tunnelError;
  return { destroy() {} } as unknown as Socket;
};

function definitionInput(name: string, overrides: Partial<IndexerCreate> = {}, fields: Record<string, string | boolean> = { cookie: 'uid=1; pass=abc' }): IndexerCreate {
  return {
    name,
    implementation: 'definition',
    settings: { definitionId: 'testsite', fields },
    ...overrides,
  };
}

function torznabInput(name: string, overrides: Partial<IndexerCreate> = {}): IndexerCreate {
  return {
    name,
    implementation: 'torznab',
    settings: { baseUrl: `http://${name.toLowerCase()}.example`, apiKey: 'k', categories: [2000] },
    ...overrides,
  };
}

function serveTorznab(host: string, items: Array<{ title: string; guid: string; link: string }>): void {
  net.routes.set(host, (url) => (url.searchParams.get('t') === 'caps' ? xml(CAPS) : xml(feed(items))));
}

function serveSite(): void {
  net.routes.set('testsite.example', (url) => {
    if (url.pathname === '/browse.php') return html(SITE_PAGE);
    if (url.pathname === '/download.php') return torrent();
    return new Response('not found', { status: 404 });
  });
}

const json = <T>(res: { json: () => unknown }) => res.json() as T;

beforeEach(async () => {
  clock = T0;
  net = new FakeNet();
  tunnels = [];
  tunnelError = null;
  db = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), 'mt-defs-'));
  await writeFile(join(dir, 'testsite.yml'), TEST_DEF, 'utf8');
  store = new DefinitionStore({ customDir: dir });
  service = new IndexersService({
    db,
    fetch: net.fetch,
    now: () => clock,
    sleep: async () => {},
    definitions: store,
    openTunnel,
    indexerTimeoutMs: 5_000,
  });
  await store.ready();
  scheduler = new Scheduler(db, new EventBus(), pino({ level: 'silent' }));
  registerIndexerJobs(scheduler, service, { rssIntervalMinutes: getSection(db, 'indexers').rssSyncIntervalMinutes });
  app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    indexersRoutes(service, {
      settings: {
        get: () => getIndexerGlobalSettings(db),
        update: (value: IndexerGlobalSettings) => {
          const saved = updateIndexerGlobalSettings(db, value);
          rescheduleRssSync(scheduler, saved.rssSyncIntervalMinutes);
          return saved;
        },
      },
    }),
  );
});

afterEach(async () => {
  await app.close();
  scheduler.stop();
  await rm(dir, { recursive: true, force: true });
});

// ---- definition catalogue -----------------------------------------------------------

describe('definition catalogue', () => {
  it('lists bundled and custom definitions with their source', async () => {
    const res = await app.inject({ method: 'GET', url: '/indexer/definition' });
    expect(res.statusCode).toBe(200);
    const list = json<Array<{ id: string; source: string; protocol: string }>>(res);
    expect(list.find((d) => d.id === 'testsite')).toMatchObject({ source: 'custom', protocol: 'torrent' });
    expect(list.find((d) => d.id === 'yts')).toMatchObject({ source: 'builtin' });
    expect(list.length).toBeGreaterThan(5);
  });

  it('filters by privacy, query and language', async () => {
    const priv = json<Array<{ id: string; privacy: string }>>(await app.inject({ method: 'GET', url: '/indexer/definition?privacy=private' }));
    expect(priv.map((d) => d.id)).toContain('testsite');
    expect(priv.every((d) => d.privacy === 'private')).toBe(true);
    const q = json<Array<{ id: string }>>(await app.inject({ method: 'GET', url: '/indexer/definition?query=test%20tracker' }));
    expect(q.map((d) => d.id)).toEqual(['testsite']);
    const lang = json<Array<{ id: string }>>(await app.inject({ method: 'GET', url: '/indexer/definition?language=xx' }));
    expect(lang).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/indexer/definition?privacy=secret' })).statusCode).toBe(400);
  });

  it('serves the detail with typed settings fields and categories', async () => {
    const res = await app.inject({ method: 'GET', url: '/indexer/definition/testsite' });
    expect(res.statusCode).toBe(200);
    const detail = json<{
      settingsFields: Array<{ name: string; type: string; default?: unknown; options?: unknown; informational: boolean }>;
      categories: Array<{ id: number }>;
      requiresLogin: boolean;
      searchModes: string[];
      tested: boolean;
    }>(res);
    const byName = Object.fromEntries(detail.settingsFields.map((f) => [f.name, f]));
    expect(byName['freeleech']).toMatchObject({ type: 'checkbox', default: false, informational: false });
    expect(byName['sort']).toMatchObject({ default: 'added', options: [{ value: 'added', label: 'Added' }, { value: 'size', label: 'Size' }] });
    expect(byName['info_note']).toMatchObject({ informational: true, default: 'Paste your cookie' });
    expect(detail.categories.map((c) => c.id)).toEqual(expect.arrayContaining([2040, 5040]));
    expect(detail).toMatchObject({ requiresLogin: true, tested: false });
    expect(detail.searchModes).toEqual(expect.arrayContaining(['search', 'tv-search', 'movie-search']));
  });

  it('answers 404 for an unknown definition', async () => {
    expect((await app.inject({ method: 'GET', url: '/indexer/definition/nope' })).statusCode).toBe(404);
  });

  it('accepts an uploaded custom definition and saves it to the config directory', async () => {
    const yaml = TEST_DEF.replace('id: testsite', 'id: uploaded').replace('name: TestSite', 'name: Uploaded');
    const res = await app.inject({ method: 'POST', url: '/indexer/definition', payload: { yaml } });
    expect(res.statusCode).toBe(201);
    expect(json<{ id: string; source: string }>(res)).toMatchObject({ id: 'uploaded', source: 'custom' });
    expect(await readFile(join(dir, 'uploaded.yml'), 'utf8')).toBe(yaml);
    expect(store.get('uploaded')?.name).toBe('Uploaded');
  });

  it('rejects an invalid uploaded definition', async () => {
    const res = await app.inject({ method: 'POST', url: '/indexer/definition', payload: { yaml: 'id: broken\nname: Broken\n' } });
    expect(res.statusCode).toBe(400);
    expect(json<{ error: string }>(res).error).toMatch(/invalid definition/);
  });

  it('reloads files added to the directory and reports broken ones', async () => {
    await writeFile(join(dir, 'second.yml'), TEST_DEF.replace('id: testsite', 'id: second'), 'utf8');
    await writeFile(join(dir, 'bad.yml'), 'id: bad\nname: [unclosed', 'utf8');
    const res = await app.inject({ method: 'POST', url: '/indexer/definition/reload' });
    expect(res.statusCode).toBe(200);
    const result = json<{ custom: number; errors: Array<{ file: string }> }>(res);
    expect(result.custom).toBe(2);
    expect(result.errors.some((e) => e.file.endsWith('bad.yml'))).toBe(true);
    expect(store.get('second')).toBeDefined();
  });

  it('deletes custom definitions but not bundled ones', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/indexer/definition/yts' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/indexer/definition/testsite' })).statusCode).toBe(204);
    expect(store.get('testsite')).toBeUndefined();
  });
});

// ---- definition indexers ------------------------------------------------------------

describe('definition indexers', () => {
  it('creates an indexer from a definition with the site link and definition name', async () => {
    const res = await app.inject({ method: 'POST', url: '/indexer', payload: definitionInput('Site') });
    expect(res.statusCode).toBe(201);
    expect(json<object>(res)).toMatchObject({
      implementation: 'definition',
      protocol: 'torrent',
      definitionName: 'TestSite',
      privacy: 'private',
      settings: { baseUrl: 'https://testsite.example/', apiPath: '', definitionId: 'testsite', fields: { cookie: 'uid=1; pass=abc' } },
    });
  });

  it('rejects unknown definitions and mistyped field values', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/indexer',
      payload: { name: 'X', implementation: 'definition', settings: { definitionId: 'nope' } },
    });
    expect(unknown.statusCode).toBe(400);
    const badCheckbox = await app.inject({ method: 'POST', url: '/indexer', payload: definitionInput('X', {}, { freeleech: 'maybe' }) });
    expect(badCheckbox.statusCode).toBe(400);
    const badSelect = await app.inject({ method: 'POST', url: '/indexer', payload: definitionInput('X', {}, { sort: 'random' }) });
    expect(json<{ error: string }>(badSelect).error).toMatch(/sort/);
  });

  it('uses a custom site link as the base URL', async () => {
    const created = service.create(definitionInput('Mirror', {}, { sitelink: 'https://mirror.example/' }));
    expect(created.settings.baseUrl).toBe('https://mirror.example/');
  });

  it('searches through the definition with the login cookie and caches the results', async () => {
    serveSite();
    const created = service.create(definitionInput('Site', {}, { cookie: 'uid=1; pass=abc', sort: 'size', freeleech: true }));
    const res = await app.inject({ method: 'GET', url: '/search?query=Movie%20One' });
    expect(res.statusCode).toBe(200);
    const releases = json<ReleaseResource[]>(res);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      title: 'Movie.One.2024.1080p.WEB-DL-GRP',
      indexerId: created.id,
      indexerName: 'Site',
      downloadUrl: 'https://testsite.example/download.php?id=1',
      seeders: 10,
    });
    const call = net.to('testsite.example')[0]!;
    expect(call.cookie).toContain('pass=abc');
    expect(call.url.searchParams.get('sort')).toBe('size');
    expect(call.url.searchParams.get('free')).toBe('1');
    expect(service.cachedResult(created.id, releases[0]!.guid)?.title).toBe('Movie.One.2024.1080p.WEB-DL-GRP');
  });

  it('runs RSS and caps through the definition', async () => {
    serveSite();
    const created = service.create(definitionInput('Site'));
    const fresh = await service.rss();
    expect(fresh.map((r) => r.title)).toEqual(['Movie.One.2024.1080p.WEB-DL-GRP']);
    const caps = await app.inject({ method: 'GET', url: `/indexer/${created.id}/caps` });
    expect(caps.statusCode).toBe(200);
    expect(json<{ searching: { tvSearch: { available: boolean } } }>(caps).searching.tvSearch.available).toBe(true);
  });

  it('tests an unsaved definition indexer', async () => {
    serveSite();
    const res = await app.inject({ method: 'POST', url: '/indexer/test', payload: definitionInput('Site') });
    expect(res.statusCode).toBe(200);
    expect(json<{ ok: boolean }>(res).ok).toBe(true);
  });

  it('downloads release files through the definition with its cookies', async () => {
    serveSite();
    const created = service.create(definitionInput('Site'));
    const result = await service.downloadRelease(created.id, 'https://testsite.example/download.php?id=1');
    expect(result.kind).toBe('file');
    if (result.kind === 'file') expect(new TextDecoder().decode(result.data)).toBe(TORRENT_BYTES);
    const call = net.to('testsite.example').find((c) => c.url.pathname === '/download.php')!;
    expect(call.cookie).toContain('uid=1');
  });
});

// ---- download endpoint --------------------------------------------------------------

describe('GET /indexer/:id/download', () => {
  it('streams a search result as a .torrent attachment', async () => {
    serveSite();
    const created = service.create(definitionInput('Site'));
    await app.inject({ method: 'GET', url: '/search?query=Movie' });
    const url = encodeURIComponent('https://testsite.example/download.php?id=1');
    const res = await app.inject({ method: 'GET', url: `/indexer/${created.id}/download?url=${url}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-bittorrent');
    expect(res.headers['content-disposition']).toContain('Movie.One.2024.1080p.WEB-DL-GRP.torrent');
    expect(res.body).toBe(TORRENT_BYTES);
  });

  it('refuses links that do not belong to the indexer', async () => {
    const created = service.create(definitionInput('Site'));
    const url = encodeURIComponent('https://evil.example/steal');
    const res = await app.inject({ method: 'GET', url: `/indexer/${created.id}/download?url=${url}` });
    expect(res.statusCode).toBe(400);
    expect(net.calls).toHaveLength(0);
  });

  it('redirects magnets, including a Torznab link that redirects to one', async () => {
    const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
    serveTorznab('tz.example', [{ title: 'Show.S01E01.1080p', guid: 'g1', link: 'http://tz.example/dl/1' }]);
    const base = net.routes.get('tz.example')!;
    net.routes.set('tz.example', (url, call) =>
      url.pathname === '/dl/1' ? new Response(null, { status: 302, headers: { location: magnet } }) : base(url, call),
    );
    const created = service.create(torznabInput('TZ'));
    const direct = await app.inject({ method: 'GET', url: `/indexer/${created.id}/download?url=${encodeURIComponent(magnet)}` });
    expect(direct.statusCode).toBe(302);
    expect(direct.headers.location).toBe(magnet);
    const viaLink = await app.inject({
      method: 'GET',
      url: `/indexer/${created.id}/download?url=${encodeURIComponent('http://tz.example/dl/1')}`,
    });
    expect(viaLink.statusCode).toBe(302);
    expect(viaLink.headers.location).toBe(magnet);
  });

  it('answers 404 when the indexer no longer has the release', async () => {
    net.routes.set('tz.example', () => new Response('gone', { status: 410 }));
    const created = service.create(torznabInput('TZ'));
    const res = await app.inject({
      method: 'GET',
      url: `/indexer/${created.id}/download?url=${encodeURIComponent('http://tz.example/dl/9')}`,
    });
    expect(res.statusCode).toBe(404);
    expect(json<{ code: string }>(res).code).toBe('UNAVAILABLE');
  });
});

// ---- proxies ------------------------------------------------------------------------

describe('indexer proxies', () => {
  const flare = { name: 'Flare', type: 'flaresolverr', host: 'http://flare.example', port: 8191, requestTimeout: 30 } as const;

  it('creates, lists, updates and deletes proxies with the password masked', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/indexerproxy',
      payload: { name: 'Socks', type: 'socks5', host: 'proxy.example', port: 1080, username: 'u', password: 'secret', tags: [1] },
    });
    expect(created.statusCode).toBe(201);
    const proxy = json<{ id: number; password: string }>(created);
    expect(proxy.password).toBe('********');
    const updated = await app.inject({
      method: 'PUT',
      url: `/indexerproxy/${proxy.id}`,
      payload: { port: 1081, password: '********' },
    });
    expect(json<{ port: number }>(updated).port).toBe(1081);
    expect(service.proxies.resolve({ proxyId: proxy.id, tags: [] })).toEqual([
      { type: 'socks5', host: 'proxy.example', port: 1081, username: 'u', password: 'secret' },
    ]);
    expect(json<unknown[]>(await app.inject({ method: 'GET', url: '/indexerproxy' }))).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/indexerproxy/${proxy.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/indexerproxy/${proxy.id}` })).statusCode).toBe(404);
  });

  it('rejects duplicate names', async () => {
    await app.inject({ method: 'POST', url: '/indexerproxy', payload: flare });
    expect((await app.inject({ method: 'POST', url: '/indexerproxy', payload: { ...flare, name: 'flare' } })).statusCode).toBe(409);
  });

  it('applies an explicit proxy, falls back to tags, and clears the link on delete', async () => {
    const byId = service.proxies.create(flare);
    const byTag = service.proxies.create({ name: 'Tagged', type: 'http', host: 'p.example', port: 3128, tags: [7] });
    const explicit = service.create(torznabInput('A', { proxyId: byId.id, tags: [7] }));
    expect(explicit).toMatchObject({ proxyId: byId.id, proxyNames: ['Flare'] });
    const tagged = service.create(torznabInput('B', { tags: [7] }));
    expect(tagged.proxyNames).toEqual(['Tagged']);
    expect(service.create(torznabInput('C')).proxyNames).toBeUndefined();
    expect(service.proxies.resolve({ proxyId: null, tags: [7] })).toEqual([{ type: 'http', host: 'p.example', port: 3128 }]);
    service.proxies.delete(byId.id);
    expect(service.get(explicit.id).proxyId).toBeUndefined();
    expect(byTag.id).toBeGreaterThan(0);
  });

  it('rejects an unknown proxyId on indexers', async () => {
    const res = await app.inject({ method: 'POST', url: '/indexer', payload: torznabInput('A', { proxyId: 99 }) });
    expect(res.statusCode).toBe(400);
  });

  it('solves a real request.get through FlareSolverr when testing', async () => {
    net.routes.set('flare.example', (url, call) => {
      expect(url.pathname).toBe('/v1');
      expect(JSON.parse(call.body ?? '{}')).toEqual({ cmd: 'request.get', url: 'https://tracker.example/', maxTimeout: 30_000 });
      return new Response(JSON.stringify({ status: 'ok', version: '3.3.21', solution: { url: 'https://tracker.example/', status: 200 } }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const res = await app.inject({ method: 'POST', url: '/indexerproxy/test', payload: { ...flare, url: 'https://tracker.example/' } });
    expect(json<{ ok: boolean; message: string }>(res)).toMatchObject({ ok: true, message: 'FlareSolverr fetched https://tracker.example/ (v3.3.21)' });
    expect(net.to('flare.example')[0]!.url.port).toBe('8191');
  });

  it('reports FlareSolverr failures', async () => {
    net.routes.set('flare.example', () => new Response('bad', { status: 500 }));
    const saved = service.proxies.create(flare);
    const res = await app.inject({ method: 'POST', url: `/indexerproxy/${saved.id}/test`, payload: {} });
    expect(json<{ ok: boolean; message: string }>(res)).toMatchObject({ ok: false, message: 'FlareSolverr returned HTTP 500' });
  });

  it('opens a tunnel to the target URL when testing HTTP/SOCKS proxies', async () => {
    const payload = { name: 'Http', type: 'http', host: 'proxy.example', port: 3128, url: 'https://tracker.example:8443/' };
    const ok = json<{ ok: boolean }>(await app.inject({ method: 'POST', url: '/indexerproxy/test', payload }));
    expect(ok.ok).toBe(true);
    expect(tunnels[0]).toEqual({ type: 'http', host: 'proxy.example', port: 3128, target: 'tracker.example', targetPort: 8443 });
    tunnelError = new Error('proxy refused the connection');
    const failed = json<{ ok: boolean; message: string }>(await app.inject({ method: 'POST', url: '/indexerproxy/test', payload }));
    expect(failed).toMatchObject({ ok: false, message: 'proxy refused the connection' });
  });

  it('sends Torznab requests through FlareSolverr when a challenge is returned', async () => {
    const proxy = service.proxies.create(flare);
    const created = service.create(torznabInput('TZ', { proxyId: proxy.id }));
    let challenged = false;
    net.routes.set('tz.example', (url, call) => {
      if (!challenged) {
        challenged = true;
        return new Response('<title>Just a moment...</title>', { status: 503, headers: { server: 'cloudflare', 'content-type': 'text/html' } });
      }
      expect(call.cookie).toContain('cf_clearance=ok');
      return url.searchParams.get('t') === 'caps' ? xml(CAPS) : xml(feed([]));
    });
    net.routes.set('flare.example', () =>
      new Response(
        JSON.stringify({
          status: 'ok',
          solution: {
            url: 'http://tz.example/api',
            status: 200,
            response: '',
            headers: {},
            cookies: [{ name: 'cf_clearance', value: 'ok', domain: 'tz.example', path: '/' }],
            userAgent: 'UA',
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const caps = await service.getCaps(created.id, { refresh: true });
    expect(caps.searching.search.available).toBe(true);
    expect(net.to('flare.example')).toHaveLength(1);
  });
});

// ---- stats --------------------------------------------------------------------------

describe('indexer stats', () => {
  it('records queries, failures and grabs and aggregates them per indexer and day', async () => {
    serveTorznab('good.example', [{ title: 'Movie.2024.1080p', guid: 'g1', link: 'http://good.example/dl/1' }]);
    net.routes.set('good.example', (url) =>
      url.pathname === '/dl/1' ? torrent() : url.searchParams.get('t') === 'caps' ? xml(CAPS) : xml(feed([{ title: 'Movie.2024.1080p', guid: 'g1', link: 'http://good.example/dl/1' }])),
    );
    const good = service.create(torznabInput('Good'));
    const bad = service.create(torznabInput('Bad')); // no route: unreachable
    await service.manualSearch({ query: 'movie' });
    await service.downloadRelease(good.id, 'http://good.example/dl/1');

    const res = await app.inject({ method: 'GET', url: '/indexer/stats?days=7' });
    expect(res.statusCode).toBe(200);
    const stats = json<{
      days: number;
      indexers: Array<{ indexerId: number; queries: number; grabs: number; failures: number; byDay: Array<{ date: string; queries: number }> }>;
      totals: { queries: number; grabs: number; failures: number; byDay: unknown[] };
    }>(res);
    expect(stats.days).toBe(7);
    const g = stats.indexers.find((i) => i.indexerId === good.id)!;
    const b = stats.indexers.find((i) => i.indexerId === bad.id)!;
    expect(g).toMatchObject({ queries: 1, grabs: 1, failures: 0 });
    expect(b).toMatchObject({ queries: 1, grabs: 0, failures: 1 });
    expect(g.byDay).toHaveLength(7);
    expect(g.byDay.at(-1)).toMatchObject({ date: '2026-10-25', queries: 1 });
    expect(stats.totals).toMatchObject({ queries: 2, grabs: 1, failures: 1 });
  });

  it('records RSS fetches and averages successful response times', async () => {
    const created = service.create(torznabInput('Good'));
    let calls = 0;
    net.routes.set('good.example', (url) => {
      calls++;
      clock += 250; // each request takes 250 ms of fake time
      return url.searchParams.get('t') === 'caps' ? xml(CAPS) : xml(feed([]));
    });
    await service.rss();
    const stats = service.stats.query(30);
    const entry = stats.indexers.find((i) => i.indexerId === created.id)!;
    expect(entry.queries).toBe(1);
    expect(entry.avgResponseMs).toBe(250 * calls);
  });

  it('prunes rows older than 90 days', async () => {
    const created = service.create(torznabInput('Good'));
    db.insert(indexerStats)
      .values([
        { indexerId: created.id, kind: 'query', durationMs: 10, success: true, at: new Date(T0 - 91 * DAY).toISOString() },
        { indexerId: created.id, kind: 'query', durationMs: 10, success: true, at: new Date(T0 - 89 * DAY).toISOString() },
      ])
      .run();
    expect(service.stats.prune()).toBe(1);
    expect(db.select().from(indexerStats).all()).toHaveLength(1);
  });

  it('validates the window', async () => {
    expect((await app.inject({ method: 'GET', url: '/indexer/stats?days=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/indexer/stats?days=91' })).statusCode).toBe(400);
    expect(json<{ days: number }>(await app.inject({ method: 'GET', url: '/indexer/stats' })).days).toBe(30);
  });
});

// ---- global settings & scheduling ---------------------------------------------------

describe('indexer options', () => {
  it('serves defaults', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/indexers' });
    expect(json<object>(res)).toEqual({
      minimumAgeMinutes: 0,
      retentionDays: 0,
      maximumSizeMb: 0,
      rssSyncIntervalMinutes: 15,
      allowHardcodedSubs: false,
      whitelistedHardcodedSubs: [],
      preferIndexerFlags: false,
    });
  });

  it('stores shared values in the releases section and reschedules RSS sync', async () => {
    const body = {
      minimumAgeMinutes: 30,
      retentionDays: 1500,
      maximumSizeMb: 20000,
      rssSyncIntervalMinutes: 30,
      allowHardcodedSubs: true,
      whitelistedHardcodedSubs: ['ENG'],
      preferIndexerFlags: true,
    };
    const res = await app.inject({ method: 'PUT', url: '/settings/indexers', payload: body });
    expect(res.statusCode).toBe(200);
    expect(json<object>(res)).toEqual(body);
    expect(getSection(db, 'releases')).toMatchObject({ minimumAgeMinutes: 30, retentionDays: 1500, maximumSizeMb: 20000 });
    expect(scheduler.listScheduled().find((j) => j.name === RSS_SYNC_JOB)?.interval).toBe('*/30 * * * *');

    await app.inject({ method: 'PUT', url: '/settings/indexers', payload: { ...body, rssSyncIntervalMinutes: 0 } });
    expect(scheduler.listScheduled().find((j) => j.name === RSS_SYNC_JOB)).toBeUndefined();
    expect(scheduler.has(RSS_SYNC_JOB)).toBe(true);
  });

  it('rejects intervals outside 10-1440 (except 0)', async () => {
    const res = await app.inject({ method: 'PUT', url: '/settings/indexers', payload: { rssSyncIntervalMinutes: 5 } });
    expect(res.statusCode).toBe(400);
  });

  it('maps intervals to cron expressions', () => {
    expect(rssCronFor(0)).toBeNull();
    expect(rssCronFor(15)).toBe('*/15 * * * *');
    expect(rssCronFor(120)).toBe('0 */2 * * *');
    expect(rssCronFor(90)).toBe('0 */2 * * *');
    expect(rssCronFor(1440)).toBe('0 0 * * *');
  });

  it('registers RSS sync on demand only when the stored interval is 0, plus the stats cleanup job', async () => {
    const other = new Scheduler(db, new EventBus(), pino({ level: 'silent' }));
    registerIndexerJobs(other, service, { rssIntervalMinutes: 0 });
    expect(other.has(RSS_SYNC_JOB)).toBe(true);
    expect(other.listScheduled().map((j) => j.name).sort()).toEqual([INDEXER_STATS_CLEANUP_JOB, 'IndexerStatusCheck'].sort());
  });
});

// ---- search grab --------------------------------------------------------------------

describe('POST /search/grab', () => {
  async function searchOnce(): Promise<ReleaseResource> {
    serveSite();
    service.create(definitionInput('Site'));
    const res = await app.inject({ method: 'GET', url: '/search?query=Movie' });
    return json<ReleaseResource[]>(res)[0]!;
  }

  it('answers 404 for results that are not in the search cache', async () => {
    const res = await app.inject({ method: 'POST', url: '/search/grab', payload: { guid: 'nope', indexerId: 1 } });
    expect(res.statusCode).toBe(404);
  });

  it('answers 400 when no release pipeline is attached', async () => {
    const r = await searchOnce();
    const res = await app.inject({ method: 'POST', url: '/search/grab', payload: { guid: r.guid, indexerId: r.indexerId } });
    expect(res.statusCode).toBe(400);
  });

  it('needs force for results without a library match', async () => {
    const r = await searchOnce();
    const seen: Array<{ force: boolean; title: string }> = [];
    service.setSearchGrabber(async (release, opts): Promise<SearchGrabOutcome> => {
      seen.push({ force: opts.force, title: release.title });
      if (!opts.force) return { kind: 'no-match', rejections: ['Unknown Movie'] };
      return { kind: 'grabbed', title: release.title, queueItemId: 4, downloadId: 'abc', downloadClientId: 1, matched: false, rejections: ['Unknown Movie'] };
    });
    const refused = await app.inject({ method: 'POST', url: '/search/grab', payload: { guid: r.guid, indexerId: r.indexerId } });
    expect(refused.statusCode).toBe(409);
    expect(json<{ code: string; error: string }>(refused)).toMatchObject({ code: 'NO_MATCH' });
    const forced = await app.inject({ method: 'POST', url: '/search/grab', payload: { guid: r.guid, indexerId: r.indexerId, force: true } });
    expect(forced.statusCode).toBe(200);
    expect(json<object>(forced)).toEqual({
      title: r.title,
      queueItemId: 4,
      downloadId: 'abc',
      downloadClientId: 1,
      matched: false,
      rejections: ['Unknown Movie'],
    });
    expect(seen.map((s) => s.force)).toEqual([false, true]);
  });

  it('maps release pipeline errors to HTTP', async () => {
    const r = await searchOnce();
    service.setSearchGrabber(async () => {
      const err = new Error('No enabled torrent download client is available') as Error & { code: string };
      err.name = 'ReleasesError';
      err.code = 'CLIENT_UNAVAILABLE';
      throw err;
    });
    const res = await app.inject({ method: 'POST', url: '/search/grab', payload: { guid: r.guid, indexerId: r.indexerId, force: true } });
    expect(res.statusCode).toBe(503);
  });
});
