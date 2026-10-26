import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuiltinClient, type AddTorrentInput, type DownloadClient } from '@arclight/download-clients';
import { createTorrent, Session } from '@arclight/torrent-engine';
import { CrossSeedSettings, type Indexer, type ReleaseResource } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, movies, series, trackedDownloads } from '../../db/schema.js';
import type { ReleaseDownload } from '../indexers/index.js';
import { quality } from '../releases/test-support.js';
import { setSection } from '../settings/service.js';
import { crossSeedRoutes } from './routes.js';
import * as tables from './schema.js';
import { cleanName, CrossSeedError, CrossSeedService, sizeMatches, titleMismatch, verifyEnds, type CrossSeedClient, type CrossSeedIndexersPort } from './service.js';

// Cross-seeding against fake indexer results: the "indexer" serves .torrent files generated
// from the temp library files (or from other data, to exercise the piece check), and the
// built-in engine runs on loopback with announce URLs it never contacts.

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const PRIV = 1;
const NEWS = 2;
const OTHER = 3;
const EP_NAME = 'Test.Show.S01E01.1080p.WEB-DL.mkv';
const MOVIE_NAME = 'Test.Movie.2021.1080p.BluRay.x264.mkv';
const SIZE = 100_000;

class FakeIndexers implements CrossSeedIndexersPort {
  indexers: Array<Pick<Indexer, 'id' | 'name' | 'protocol' | 'enableAutomaticSearch'>> = [
    { id: PRIV, name: 'PrivTracker', protocol: 'torrent', enableAutomaticSearch: true },
    { id: NEWS, name: 'Newsgroup', protocol: 'usenet', enableAutomaticSearch: true },
    { id: OTHER, name: 'OtherTracker', protocol: 'torrent', enableAutomaticSearch: false },
  ];
  releases: ReleaseResource[] = [];
  files = new Map<string, ReleaseDownload>();
  searches: Array<{ request: unknown; indexerIds: readonly number[] | undefined }> = [];
  list() {
    return this.indexers;
  }
  async search(request: unknown, opts: { indexerIds?: readonly number[] }) {
    this.searches.push({ request, indexerIds: opts.indexerIds });
    return this.releases;
  }
  async downloadRelease(_indexerId: number, url: string): Promise<ReleaseDownload> {
    const f = this.files.get(url);
    if (!f) throw new Error('404');
    return f;
  }
  /** Offer a release backed by a generated .torrent. */
  offer(title: string, torrent: Buffer | null, overrides: Partial<ReleaseResource> = {}): ReleaseResource {
    const url = `https://priv.invalid/dl/${this.releases.length}`;
    const r: ReleaseResource = {
      guid: url,
      title,
      size: SIZE,
      publishDate: '2026-10-01T00:00:00.000Z',
      downloadUrl: url,
      categories: [5000],
      indexerId: PRIV,
      indexerName: 'PrivTracker',
      indexerPriority: 25,
      protocol: 'torrent',
      seeders: 10,
      age: 1,
      ageHours: 24,
      ageMinutes: 1440,
      rejections: [],
      approved: false,
      ...overrides,
    };
    this.releases.push(r);
    if (torrent) this.files.set(url, { kind: 'file', protocol: 'torrent', data: torrent, contentType: 'application/x-bittorrent', fileName: 'x.torrent' });
    else this.files.set(url, { kind: 'magnet', magnetUrl: 'magnet:?xt=urn:btih:' + 'e'.repeat(40) });
    return r;
  }
}

class FakeQbit implements DownloadClient {
  readonly name = 'qBittorrent';
  added: AddTorrentInput[] = [];
  fail = false;
  async test() {
    return { version: '5', apiVersion: '2', warnings: [] };
  }
  async addTorrent(input: AddTorrentInput) {
    if (this.fail) throw new Error('qBittorrent refused the torrent');
    this.added.push(input);
    return { id: 'x', warnings: [] };
  }
  async getItems() {
    return [];
  }
  async removeItem() {}
  async getStatus() {
    return { outputRootDir: '/', isLocalhost: true, removesCompletedDownloads: false };
  }
  async setCategory() {}
  async pause() {}
  async resume() {}
}

interface Fx {
  db: Db;
  dir: string;
  linkDir: string;
  fake: FakeIndexers;
  service: CrossSeedService;
  session: Session;
  clients: CrossSeedClient[];
  qbit: FakeQbit;
  seriesId: number;
  movieId: number;
  files: { ep: number; movie: number };
  data: { ep: Buffer; movie: Buffer };
  paths: { ep: string; movie: string };
  added: number[];
}

async function setup(settings: Partial<CrossSeedSettings> = {}): Promise<Fx> {
  const db = await createTestDb({ ...tables });
  const dir = await mkdtemp(join(tmpdir(), 'mt-xseed-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const linkDir = join(dir, 'links');
  const session = new Session({
    settings: { listenPort: 0, listenAddress: '127.0.0.1', dht: false, pex: false, dhtBootstrapNodes: [], tickIntervalMs: 50, savePath: join(dir, 'downloads') },
    trackerClientFactory: () => null,
  });
  await session.start();
  cleanups.push(() => session.shutdown());

  const seriesId = db
    .insert(series)
    .values({
      tmdbId: 100,
      tvdbId: 7000,
      imdbId: 'tt0100',
      title: 'Test Show',
      sortTitle: 'test show',
      cleanTitle: 'testshow',
      year: 2020,
      status: 'continuing',
      genres: [],
      images: [],
      ratings: {},
      originalLanguage: 'en',
      path: join(dir, 'Test Show'),
      rootFolderPath: dir,
      qualityProfileId: 1,
      tags: [7],
      added: '2025-01-01T00:00:00.000Z',
    })
    .returning({ id: series.id })
    .get().id;
  const movieId = db
    .insert(movies)
    .values({
      tmdbId: 200,
      imdbId: 'tt0200',
      title: 'Test Movie',
      originalTitle: 'Test Movie',
      sortTitle: 'test movie',
      cleanTitle: 'testmovie',
      year: 2021,
      status: 'released',
      genres: [],
      images: [],
      ratings: {},
      originalLanguage: 'en',
      path: join(dir, 'Test Movie (2021)'),
      rootFolderPath: dir,
      qualityProfileId: 1,
      tags: [],
      added: '2025-01-01T00:00:00.000Z',
    })
    .returning({ id: movies.id })
    .get().id;

  const paths = { ep: join(dir, 'Test Show', 'Season 01', EP_NAME), movie: join(dir, 'Test Movie (2021)', MOVIE_NAME) };
  const data = { ep: randomBytes(SIZE), movie: randomBytes(SIZE) };
  for (const k of ['ep', 'movie'] as const) {
    await mkdir(dirname(paths[k]), { recursive: true });
    await writeFile(paths[k], data[k]);
  }
  const addFile = (path: string, o: { seriesId?: number; movieId?: number; seasonNumber?: number }, dateAdded: string) =>
    db
      .insert(mediaFiles)
      .values({
        mediaType: o.movieId ? 'movie' : 'series',
        seriesId: o.seriesId ?? null,
        movieId: o.movieId ?? null,
        seasonNumber: o.seasonNumber ?? null,
        relativePath: path.slice(dir.length + 1),
        path,
        sizeBytes: SIZE,
        dateAdded,
        quality: quality('WEBDL-1080p'),
        languages: ['en'],
      })
      .returning({ id: mediaFiles.id })
      .get().id;
  const files = {
    ep: addFile(paths.ep, { seriesId, seasonNumber: 1 }, '2026-01-02T00:00:00.000Z'),
    movie: addFile(paths.movie, { movieId }, '2026-01-01T00:00:00.000Z'),
  };
  db.insert(episodes).values({ seriesId, seasonNumber: 1, episodeNumber: 1, title: 'Pilot', hasFile: true, episodeFileId: files.ep }).run();

  setSection(db, 'crossSeed', CrossSeedSettings.parse({ enabled: true, linkDir, ...settings }));
  const fake = new FakeIndexers();
  const qbit = new FakeQbit();
  const clients: CrossSeedClient[] = [{ id: 10, name: 'Built-in', implementation: 'builtin', client: createBuiltinClient({}, session) }];
  const added: number[] = [];
  const service = new CrossSeedService({
    db,
    indexers: fake,
    clients: () => clients,
    session: () => session,
    defaultLinkDir: () => join(dir, 'default-links'),
    log: pino({ level: 'silent' }),
    onAdded: (row) => added.push(row.id),
  });
  return { db, dir, linkDir, fake, service, session, clients, qbit, seriesId, movieId, files, data, paths, added };
}

/** A private single-file torrent of `data` named `name`. */
function torrentOf(name: string, data: Buffer, opts: { multi?: boolean } = {}): { torrent: Buffer; infoHash: string } {
  const files = opts.multi ? [{ path: [name], data }, { path: ['info.nfo'], data: Buffer.from('nfo') }] : [{ path: [name], data }];
  const created = createTorrent({
    name: opts.multi ? 'Pack' : name,
    files,
    pieceLength: 16 * 1024,
    private: true,
    announce: 'http://tracker.priv.invalid/announce',
  });
  return { torrent: created.torrent, infoHash: created.metainfo.infoHashHex };
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

describe('cross-seed matching helpers', () => {
  it('cleanName and sizeMatches', () => {
    expect(cleanName('The Office (US) & Friends')).toBe('theofficeusandfriends');
    expect(sizeMatches(1000, 1000, 0.5)).toEqual({ ok: true, exact: true });
    expect(sizeMatches(1004, 1000, 0.5)).toEqual({ ok: true, exact: false });
    expect(sizeMatches(1006, 1000, 0.5).ok).toBe(false);
    expect(sizeMatches(0, 1000, 0.5).ok).toBe(false);
  });

  it('titleMismatch accepts the same episode or movie and rejects packs and others', () => {
    const ep = { mediaType: 'series' as const, title: 'Test Show', altTitles: [], year: 2020, season: 1, episodeNumbers: [1] };
    expect(titleMismatch('Test.Show.S01E01.1080p.WEB-DL-OTHER', ep)).toBeNull();
    expect(titleMismatch('Test.Show.S01E02.1080p.WEB-DL-OTHER', ep)).toBe('different episodes');
    expect(titleMismatch('Test.Show.S02E01.1080p.WEB-DL-OTHER', ep)).toBe('different season');
    expect(titleMismatch('Test.Show.S01.1080p.WEB-DL-OTHER', ep)).toBe('season pack');
    expect(titleMismatch('Other.Show.S01E01.1080p.WEB-DL', ep)).toBe('different series');
    const movie = { mediaType: 'movie' as const, title: 'Test Movie', altTitles: [], year: 2021 };
    expect(titleMismatch('Test.Movie.2021.1080p.BluRay.x264-GRP', movie)).toBeNull();
    expect(titleMismatch('Test.Movie.2015.1080p.BluRay.x264-GRP', movie)).toBe('different year');
    expect(titleMismatch('Another.Movie.2021.1080p.BluRay.x264-GRP', movie)).toBe('different movie');
  });

  it('verifyEnds hashes the first and last piece against the file on disk', async () => {
    const fx = await setup();
    const good = torrentOf(EP_NAME, fx.data.ep);
    const { parseTorrent } = await import('@arclight/torrent-engine');
    expect(await verifyEnds(parseTorrent(good.torrent), dirname(fx.paths.ep))).toBe(true);
    const bad = torrentOf(EP_NAME, randomBytes(SIZE));
    expect(await verifyEnds(parseTorrent(bad.torrent), dirname(fx.paths.ep))).toBe(false);
  });
});

describe('cross-seed search', () => {
  it('adds a verified torrent to the built-in engine seed-only through a hard link', async () => {
    const fx = await setup();
    const t = torrentOf('Test.Show.S01E01.1080p.WEB-DL-OTHER.mkv', fx.data.ep);
    fx.fake.offer('Test.Show.S01E01.1080p.WEB-DL-OTHER', t.torrent);
    const res = await fx.service.searchFile(fx.files.ep);
    expect(res).toMatchObject({ filesSearched: 1, candidates: 1, skipped: [] });
    expect(res.added).toHaveLength(1);
    expect(res.added[0]).toMatchObject({ infoHash: t.infoHash, state: 'seeding', indexerId: PRIV, indexerName: 'PrivTracker', mediaFileId: fx.files.ep, downloadClientId: 10 });
    expect(res.added[0]!.savePath).toBe(join(fx.linkDir, t.infoHash));
    expect(await exists(join(fx.linkDir, t.infoHash, 'Test.Show.S01E01.1080p.WEB-DL-OTHER.mkv'))).toBe(true);
    const torrent = fx.session.getTorrent(t.infoHash)!;
    expect(torrent.category).toBe('cross-seed');
    expect(torrent.isComplete).toBe(true);
    expect(fx.fake.searches[0]).toMatchObject({ request: { kind: 'tv', season: 1, episode: 1, tvdbId: 7000 }, indexerIds: [PRIV] });
    expect(fx.added).toHaveLength(1);
    expect(fx.service.indexerFor(t.infoHash)).toBe(PRIV);
  });

  it('seeds in place when the torrent names the file exactly like the library', async () => {
    const fx = await setup();
    const t = torrentOf(MOVIE_NAME, fx.data.movie);
    fx.fake.offer('Test.Movie.2021.1080p.BluRay.x264', t.torrent);
    const res = await fx.service.search({ movieId: fx.movieId });
    expect(res.added[0]).toMatchObject({ state: 'seeding', savePath: dirname(fx.paths.movie) });
    expect(fx.fake.searches[0]!.request).toMatchObject({ kind: 'movie', tmdbId: 200, imdbId: 'tt0200', year: 2021 });
    expect(await exists(fx.linkDir)).toBe(false);
  });

  it('skips sizes outside the tolerance and torrents whose file size differs', async () => {
    const fx = await setup({ sizeTolerancePercent: 0.5 });
    fx.fake.offer('Test.Show.S01E01.720p.HDTV-A', null, { size: SIZE * 2 });
    const near = torrentOf('near.mkv', randomBytes(SIZE + 100));
    fx.fake.offer('Test.Show.S01E01.1080p.WEB-DL-B', near.torrent, { size: SIZE + 100 });
    const res = await fx.service.searchFile(fx.files.ep);
    expect(res.added).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toEqual(['size does not match', 'file size differs from the torrent']);
  });

  it('rejects a torrent whose piece hashes do not match and removes its link', async () => {
    const fx = await setup();
    const t = torrentOf('Test.Show.S01E01.1080p.WEB-DL-X.mkv', randomBytes(SIZE));
    fx.fake.offer('Test.Show.S01E01.1080p.WEB-DL-X', t.torrent);
    const res = await fx.service.searchFile(fx.files.ep);
    expect(res.skipped).toEqual([{ title: 'Test.Show.S01E01.1080p.WEB-DL-X', indexerId: PRIV, reason: 'piece hashes do not match the file' }]);
    expect(await exists(join(fx.linkDir, t.infoHash))).toBe(false);
    expect(fx.session.getTorrents()).toHaveLength(0);
    expect(fx.service.list()).toEqual([]);
  });

  it('skips season packs, multi-file torrents, other episodes and magnets', async () => {
    const fx = await setup();
    fx.fake.offer('Test.Show.S01.1080p.WEB-DL-PACK', null);
    fx.fake.offer('Test.Show.S01E03.1080p.WEB-DL-GRP', null);
    fx.fake.offer('Test.Show.S01E01.1080p.WEB-DL-MULTI', torrentOf(EP_NAME, fx.data.ep, { multi: true }).torrent);
    fx.fake.offer('Test.Show.S01E01.1080p.WEB-DL-MAG', null, { indexerId: PRIV });
    const res = await fx.service.searchFile(fx.files.ep);
    expect(res.skipped.map((s) => s.reason)).toEqual([
      'season pack',
      'different episodes',
      'multi-file torrent',
      'magnet links cannot be verified before seeding',
    ]);
  });

  it('dedupes by info-hash against tracked downloads and earlier cross-seeds', async () => {
    const fx = await setup();
    const t = torrentOf('Test.Show.S01E01.1080p.WEB-DL-OTHER.mkv', fx.data.ep);
    const at = new Date().toISOString();
    fx.db
      .insert(trackedDownloads)
      .values({ downloadId: t.infoHash, clientId: null, title: 'grab', state: 'downloading', statusMessages: [], protocol: 'torrent', addedAt: at, updatedAt: at })
      .run();
    fx.fake.offer('Test.Show.S01E01.1080p.WEB-DL-OTHER', t.torrent, { infoHash: t.infoHash });
    expect((await fx.service.searchFile(fx.files.ep)).skipped[0]!.reason).toBe('already in a download client');
    fx.db.delete(trackedDownloads).run();
    expect((await fx.service.searchFile(fx.files.ep)).added).toHaveLength(1);
    // Without a release info-hash the torrent is downloaded, then recognised.
    fx.fake.releases[0] = { ...fx.fake.releases[0]!, infoHash: undefined } as unknown as ReleaseResource;
    const again = await fx.service.searchFile(fx.files.ep);
    expect(again.added).toEqual([]);
    expect(again.skipped[0]!.reason).toBe('already in a download client');
  });

  it('adds to qBittorrent with skip_checking when it is the chosen client', async () => {
    const fx = await setup({ downloadClientId: 20, category: 'xseed' });
    fx.clients.push({ id: 20, name: 'qBit', implementation: 'qbittorrent', client: fx.qbit });
    const t = torrentOf(EP_NAME, fx.data.ep);
    fx.fake.offer('Test.Show.S01E01.1080p.WEB-DL', t.torrent);
    const res = await fx.service.searchFile(fx.files.ep);
    expect(res.added[0]).toMatchObject({ state: 'seeding', downloadClientId: 20 });
    expect(fx.qbit.added[0]).toMatchObject({ skipChecking: true, category: 'xseed', savePath: dirname(fx.paths.ep), paused: false });
    expect(fx.session.getTorrents()).toHaveLength(0);
  });

  it('records a failed add and reports when no supported client is enabled', async () => {
    const fx = await setup({ downloadClientId: 20 });
    fx.clients.push({ id: 20, name: 'qBit', implementation: 'qbittorrent', client: fx.qbit });
    fx.qbit.fail = true;
    const t = torrentOf(EP_NAME, fx.data.ep);
    fx.fake.offer('Test.Show.S01E01.1080p.WEB-DL', t.torrent);
    const res = await fx.service.searchFile(fx.files.ep);
    expect(res.added[0]).toMatchObject({ state: 'failed', message: 'qBittorrent refused the torrent', savePath: null });
    expect(fx.service.list({ state: 'failed' })).toHaveLength(1);

    const fx2 = await setup();
    fx2.clients.splice(0);
    fx2.fake.offer('Test.Show.S01E01.1080p.WEB-DL', torrentOf(EP_NAME, fx2.data.ep).torrent);
    expect((await fx2.service.searchFile(fx2.files.ep)).skipped[0]!.reason).toBe('no built-in or qBittorrent download client is enabled');
  });

  it('honours excluded tags and the indexer selection, ignoring usenet results', async () => {
    const fx = await setup({ excludeTags: [7] });
    expect((await fx.service.searchFile(fx.files.ep)).filesSearched).toBe(0);
    expect(fx.fake.searches).toHaveLength(0);
    fx.service.updateSettings({ ...fx.service.settings(), excludeTags: [], indexerIds: [OTHER, NEWS] });
    fx.fake.offer('Test.Show.S01E01.1080p.WEB-DL', torrentOf(EP_NAME, fx.data.ep).torrent, { indexerId: NEWS, protocol: 'usenet' });
    fx.fake.offer('Test.Show.S01E01.1080p.WEB-DL-P', torrentOf(EP_NAME, fx.data.ep).torrent, { indexerId: PRIV });
    const res = await fx.service.searchFile(fx.files.ep);
    expect(fx.fake.searches[0]!.indexerIds).toEqual([OTHER]);
    expect(res.candidates).toBe(0);
  });

  it('search by series or movie id; unknown ids are NOT_FOUND', async () => {
    const fx = await setup();
    expect((await fx.service.search({ seriesId: fx.seriesId })).filesSearched).toBe(1);
    await expect(fx.service.search({ seriesId: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(fx.service.search({ mediaFileId: 999 })).rejects.toBeInstanceOf(CrossSeedError);
    await expect(fx.service.search({})).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('cross-seed scheduling', () => {
  it('the scheduled run searches due files newest first and skips recently searched ones', async () => {
    const fx = await setup({ maxPerRun: 1 });
    expect(await fx.service.runScheduled()).toMatch(/^1 file\(s\) searched/);
    expect(fx.fake.searches[0]!.request).toMatchObject({ kind: 'tv' });
    await fx.service.runScheduled();
    expect(fx.fake.searches[1]!.request).toMatchObject({ kind: 'movie' });
    expect(await fx.service.runScheduled()).toMatch(/^0 file\(s\) searched/);
    fx.service.updateSettings({ ...fx.service.settings(), enabled: false });
    expect(await fx.service.runScheduled()).toBe('cross-seeding is disabled');
  });

  it('searches after an import only when onImport is on, once per file', async () => {
    const fx = await setup();
    expect(await fx.service.searchAfterImport('movie', fx.movieId)).toBeNull();
    fx.service.updateSettings({ ...fx.service.settings(), onImport: true });
    expect((await fx.service.searchAfterImport('movie', fx.movieId))!.filesSearched).toBe(1);
    expect(await fx.service.searchAfterImport('movie', fx.movieId)).toBeNull();
  });
});

describe('cross-seed routes', () => {
  async function build() {
    const fx = await setup();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const changed: string[] = [];
    await app.register(crossSeedRoutes(fx.service, { settingsChanged: (s) => changed.push(s.schedule) }), { prefix: '/api/v1' });
    cleanups.push(() => app.close());
    return { ...fx, app, changed };
  }

  it('POST /crossseed/search runs a search; GET /crossseed lists cross-seeds', async () => {
    const { app, fake, data, files } = await build();
    fake.offer('Test.Show.S01E01.1080p.WEB-DL-OTHER', torrentOf('Test.Show.S01E01.1080p.WEB-DL-OTHER.mkv', data.ep).torrent);
    const res = await app.inject({ method: 'POST', url: '/api/v1/crossseed/search', payload: { mediaFileId: files.ep } });
    expect(res.statusCode).toBe(200);
    expect(res.json().added).toHaveLength(1);
    const list = await app.inject({ method: 'GET', url: `/api/v1/crossseed?mediaFileId=${files.ep}` });
    expect(list.json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/v1/crossseed?state=failed' })).json()).toEqual([]);
  });

  it('validates search targets and maps unknown ids to 404', async () => {
    const { app } = await build();
    expect((await app.inject({ method: 'POST', url: '/api/v1/crossseed/search', payload: { seriesId: 1, movieId: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/crossseed/search', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/crossseed/search', payload: { movieId: 999 } })).statusCode).toBe(404);
  });

  it('GET/PUT /settings/crossseed reads and saves settings and reschedules the job', async () => {
    const { app, changed } = await build();
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/crossseed' })).json()).toMatchObject({ enabled: true, sizeTolerancePercent: 0.5 });
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/crossseed', payload: { enabled: true, schedule: '0 2 * * *', onImport: true } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ schedule: '0 2 * * *', onImport: true, category: 'cross-seed' });
    expect(changed).toEqual(['0 2 * * *']);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/crossseed', payload: { sizeTolerancePercent: 50 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/crossseed', payload: { schedule: 'every day' } })).statusCode).toBe(400);
  });
});
