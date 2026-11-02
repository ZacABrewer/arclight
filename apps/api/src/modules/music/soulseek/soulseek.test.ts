import type { LightMyRequestResponse } from 'fastify';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildItems } from '@arclight/profiles-engine';
import { QUALITIES, SECRET_MASK, type SoulseekDownload, type SoulseekSearchResult } from '@arclight/shared';
import { FakeSlskd } from '../../../../../../packages/download-clients/src/slskd/fake-slskd.js';
import { buildApp, type AppContext } from '../../../app.js';
import type { AppConfig } from '../../../config.js';
import type { Db } from '../../../db/index.js';
import { albumReleases, albums, artists, audioFiles, rootFolders, tracks } from '../../../db/schema.js';
import { createTestDb, seedAdmin } from '../../../db/test-utils.js';
import { authServiceFor } from '../../auth/index.js';
import { buildFlac } from '../../imports/audio/fixtures/builders.js';
import { ProfilesService } from '../../profiles/index.js';
import { setSection } from '../../settings/service.js';
import { defaultAlbumTypeProfile } from '../service.js';
import { soulseekDownloads } from './schema.js';
import { localPathOf, searchQueryFor } from './service.js';
import { setSoulseekRuntime, soulseekServiceFor } from './index.js';

// The Soulseek source over the full app against an in-memory slskd (FakeSlskd): no network.
// Finished transfers are simulated by writing tiny tagged FLACs where slskd would put them.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

const TITLES = ['Alpha', 'Beta', 'Gamma'];
const REMOTE_DIR = 'music\\Test Artist\\2001 - Test Album [FLAC]';

interface Harness {
  db: Db;
  ctx: AppContext;
  fake: FakeSlskd;
  root: string;
  downloads: string;
  albumId: number;
  api: (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

let h: Harness;

async function harness(): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  setSection(db, 'features', { music: true, audiobooks: false });
  const root = mkdtempSync(join(tmpdir(), 'arclight-slsk-lib-'));
  const downloads = mkdtempSync(join(tmpdir(), 'arclight-slsk-dl-'));
  db.insert(rootFolders).values({ path: root, mediaType: 'music' }).run();
  const fake = new FakeSlskd();
  fake.peers = [
    {
      username: 'flac-peer',
      files: TITLES.map((t, i) => ({ filename: `${REMOTE_DIR}\\0${i + 1} - ${t}.flac`, size: 1000 + i, bitDepth: 16, sampleRate: 44100, length: 1 })),
    },
    {
      username: 'mp3-peer',
      files: TITLES.map((t, i) => ({ filename: `share\\Test Artist - Test Album\\0${i + 1} ${t}.mp3`, size: 500, bitRate: 320, length: 1 })),
    },
  ];
  let ctxRef: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (ctx) => {
      ctxRef = ctx;
      setSoulseekRuntime(ctx, { fetch: fake.fetch, sleep: async () => {} });
    },
  });
  await app.ready();
  const ctx = ctxRef!;
  const key = authServiceFor(ctx).apiKey();

  const profile = new ProfilesService({ db }).createQualityProfile({
    name: 'Soulseek test',
    upgradeAllowed: true,
    cutoff: QUALITIES['FLAC'].id,
    items: buildItems(['MP3-320', 'FLAC'], 'music'),
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
    mediaDomain: 'music',
  });
  const now = new Date().toISOString();
  const artist = db
    .insert(artists)
    .values({
      mbArtistId: '00000000-0000-4000-8000-000000000001',
      name: 'Test Artist',
      sortName: 'Artist, Test',
      cleanName: 'testartist',
      genres: [],
      images: [],
      links: [],
      aliases: [],
      path: join(root, 'Test Artist'),
      rootFolderPath: root,
      qualityProfileId: profile.id,
      albumTypeProfileId: defaultAlbumTypeProfile(db).id,
      tags: [],
      added: now,
    })
    .returning()
    .get();
  const album = db
    .insert(albums)
    .values({
      artistId: artist.id,
      mbReleaseGroupId: '00000000-0000-4000-8000-000000000002',
      title: 'Test Album',
      cleanTitle: 'testalbum',
      primaryType: 'Album',
      secondaryTypes: [],
      releaseDate: '2001-01-01',
      year: 2001,
      genres: [],
      images: [],
      ratings: {},
      added: now,
    })
    .returning()
    .get();
  const release = db
    .insert(albumReleases)
    .values({
      albumId: album.id,
      mbReleaseId: '00000000-0000-4000-8000-000000000003',
      title: 'Test Album',
      labels: [],
      formats: ['Digital Media'],
      mediumCount: 1,
      trackCount: 3,
      media: [{ position: 1, format: 'Digital Media', trackCount: 3 }] as never,
    })
    .returning()
    .get();
  db.update(albums).set({ selectedReleaseId: release.id }).where(eq(albums.id, album.id)).run();
  TITLES.forEach((title, i) => {
    db.insert(tracks)
      .values({ albumId: album.id, albumReleaseId: release.id, absoluteNumber: i + 1, trackNumber: i + 1, title, durationMs: 1000, artistCredit: 'Test Artist' })
      .run();
  });

  return {
    db,
    ctx,
    fake,
    root,
    downloads,
    albumId: album.id,
    api: (method, url, payload) =>
      app.inject({ method, url: `/api/v1${url}`, headers: { 'x-api-key': key }, ...(payload === undefined ? {} : { payload: payload as object }) }),
    close: async () => {
      await app.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(downloads, { recursive: true, force: true });
    },
  };
}

async function configure(extra: Record<string, unknown> = {}): Promise<void> {
  const res = await h.api('PUT', '/settings/soulseek', {
    enabled: true,
    host: 'slskd.example.com',
    apiKey: 'test-api-key',
    downloadsPath: h.downloads,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Writes the finished files where slskd puts them. */
function landFiles(): void {
  for (const t of h.fake.transfers) {
    const path = localPathOf(h.downloads, t.filename);
    mkdirSync(join(path, '..'), { recursive: true });
    const i = TITLES.findIndex((x) => t.filename.includes(x));
    writeFileSync(
      path,
      buildFlac({ durationMs: 1000, tags: { title: TITLES[i]!, artist: 'Test Artist', albumArtist: 'Test Artist', album: 'Test Album', trackNo: i + 1, trackOf: 3 } }),
    );
  }
}

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.close();
});

describe('soulseek settings and gating', () => {
  it('is off by default, masks the API key and keeps it on a masked update', async () => {
    const initial = (await h.api('GET', '/settings/soulseek')).json();
    expect(initial).toMatchObject({ enabled: false, host: '', port: 5030, apiKey: '', autoSearch: false, importMode: 'copy' });
    await configure();
    expect((await h.api('GET', '/settings/soulseek')).json()).toMatchObject({ enabled: true, apiKey: SECRET_MASK });
    await h.api('PUT', '/settings/soulseek', { apiKey: SECRET_MASK, maxPeerQueue: 10 });
    const test = await h.api('POST', '/soulseek/test', {});
    expect(test.json()).toMatchObject({ ok: true, loggedIn: true, version: '0.22.0' });
  });

  it('reports a wrong key from the test endpoint without failing the request', async () => {
    await configure();
    const res = await h.api('POST', '/soulseek/test', { apiKey: 'wrong' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false });
  });

  it('answers 409 while the source is off and 404 while music is off', async () => {
    const off = await h.api('POST', '/soulseek/search', { albumId: h.albumId });
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe('SOULSEEK_DISABLED');
    setSection(h.db, 'features', { music: false, audiobooks: false });
    const gated = await h.api('GET', '/soulseek/downloads');
    expect(gated.statusCode).toBe(404);
    expect(gated.json().code).toBe('MUSIC_DISABLED');
  });

  it('maps an unreachable slskd to 502', async () => {
    await configure();
    h.fake.networkError = new Error('connect ECONNREFUSED');
    const res = await h.api('POST', '/soulseek/search', { albumId: h.albumId });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('SOULSEEK_UNREACHABLE');
  });
});

describe('soulseek search, grab, monitor and import', () => {
  it('searches, ranks lossless first, grabs, follows the transfers and imports the album', async () => {
    await configure();
    const search = await h.api('POST', '/soulseek/search', { albumId: h.albumId });
    expect(search.statusCode, search.body).toBe(200);
    const result = search.json<SoulseekSearchResult>();
    expect(result.query).toBe('Test Artist Test Album');
    expect(result.candidates.map((c) => [c.username, c.qualityName, c.accepted])).toEqual([
      ['flac-peer', 'FLAC', true],
      ['mp3-peer', 'MP3-320', true],
    ]);
    expect(h.fake.searches.size).toBe(0); // deleted after reading

    const best = result.candidates[0]!;
    const grab = await h.api('POST', '/soulseek/grab', {
      albumId: h.albumId,
      username: best.username,
      directory: best.directory,
      files: best.files.map((f) => ({ filename: f.filename, size: f.size })),
      qualityName: best.qualityName,
    });
    expect(grab.statusCode, grab.body).toBe(201);
    expect(grab.json<SoulseekDownload>()).toMatchObject({ status: 'queued', fileCount: 3, artistName: 'Test Artist', albumTitle: 'Test Album' });
    expect(h.fake.transfers).toHaveLength(3);

    // A second grab for the same album while one is active is refused.
    const again = await h.api('POST', '/soulseek/grab', { albumId: h.albumId, username: best.username, directory: best.directory, files: [{ filename: 'x.flac', size: 1 }] });
    expect(again.statusCode).toBe(409);

    const service = soulseekServiceFor(h.ctx);
    expect(await service.monitor()).toMatch(/1 active, 0 imported/);
    h.fake.setTransferState(h.fake.transfers[0]!.filename, 'InProgress');
    await service.monitor();
    expect((await h.api('GET', '/soulseek/downloads')).json<SoulseekDownload[]>()[0]!.status).toBe('downloading');

    h.fake.completeAll();
    landFiles();
    expect(await service.monitor()).toMatch(/1 imported/);
    const [row] = (await h.api('GET', '/soulseek/downloads')).json<SoulseekDownload[]>();
    expect(row, JSON.stringify(row)).toMatchObject({ status: 'imported', progress: 1, message: null });

    const files = h.db.select().from(audioFiles).where(eq(audioFiles.albumId, h.albumId)).all();
    expect(files).toHaveLength(3);
    expect(files.every((f) => f.path.startsWith(join(h.root, 'Test Artist')))).toBe(true);
    // Copy mode (the default) leaves slskd's files in place.
    expect(readdirSync(join(h.downloads, '2001 - Test Album [FLAC]'))).toHaveLength(3);

    // Now the album is complete in FLAC, the cutoff: nothing on Soulseek is an upgrade.
    const auto = await h.api('POST', `/soulseek/album/${h.albumId}/auto`);
    expect(auto.statusCode, auto.body).toBe(200);
    expect(auto.json()).toMatchObject({ grabbed: null, candidates: 2 });

    const del = await h.api('DELETE', `/soulseek/downloads/${row!.id}`);
    expect(del.statusCode).toBe(204);
    expect((await h.api('GET', '/soulseek/downloads')).json()).toEqual([]);
  });

  it('auto-grabs the best accepted folder and the scheduled search skips albums it just tried', async () => {
    await configure({ autoSearch: true });
    const auto = await h.api('POST', `/soulseek/album/${h.albumId}/auto`);
    expect(auto.json()).toMatchObject({ candidates: 2, grabbed: { username: 'flac-peer', status: 'queued' } });
    expect(await soulseekServiceFor(h.ctx).autoSearchWanted()).toBe('searched 0 albums on Soulseek, 0 queued');
  });

  it('cancels transfers when a running download is removed', async () => {
    await configure();
    await h.api('POST', `/soulseek/album/${h.albumId}/auto`);
    await soulseekServiceFor(h.ctx).monitor(); // learns the transfer ids
    const [row] = (await h.api('GET', '/soulseek/downloads')).json<SoulseekDownload[]>();
    await h.api('DELETE', `/soulseek/downloads/${row!.id}`);
    expect(h.fake.transfers).toHaveLength(0);
  });

  it('fails a download whose files errored on the peer, and one without a downloads folder', async () => {
    await configure();
    await h.api('POST', `/soulseek/album/${h.albumId}/auto`);
    for (const t of h.fake.transfers) h.fake.setTransferState(t.filename, 'Completed, Errored');
    await soulseekServiceFor(h.ctx).monitor();
    let [row] = (await h.api('GET', '/soulseek/downloads')).json<SoulseekDownload[]>();
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.message).toMatch(/3 of 3 files failed/);

    h.db.delete(soulseekDownloads).run();
    h.fake.transfers.length = 0;
    await configure({ downloadsPath: '' });
    await h.api('POST', `/soulseek/album/${h.albumId}/auto`);
    h.fake.completeAll();
    await soulseekServiceFor(h.ctx).monitor();
    [row] = (await h.api('GET', '/soulseek/downloads')).json<SoulseekDownload[]>();
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.message).toMatch(/downloads folder/);
  });

  it('honours per-track wanted: a partial folder with every wanted track is accepted', async () => {
    await configure();
    const trackRows = h.db.select().from(tracks).where(eq(tracks.albumId, h.albumId)).all();
    h.fake.peers[0]!.files = h.fake.peers[0]!.files.slice(0, 2);
    let result = (await h.api('POST', '/soulseek/search', { albumId: h.albumId })).json<SoulseekSearchResult>();
    expect(result.candidates.find((c) => c.username === 'flac-peer')!.rejections).toContain('tooFewTracks');
    h.db.update(tracks).set({ monitored: false }).where(eq(tracks.id, trackRows[2]!.id)).run();
    result = (await h.api('POST', '/soulseek/search', { albumId: h.albumId })).json<SoulseekSearchResult>();
    expect(result.candidates.find((c) => c.username === 'flac-peer')).toMatchObject({ accepted: true, wantedTracks: 2 });
  });
});

describe('helpers', () => {
  it('builds a plain word query and slskd local paths', () => {
    expect(searchQueryFor('AC/DC', 'Back in Black (Remastered)')).toBe('AC DC Back in Black Remastered');
    expect(localPathOf('/downloads', 'music\\A\\B\\01.flac')).toBe(join('/downloads', 'B', '01.flac'));
  });
});
