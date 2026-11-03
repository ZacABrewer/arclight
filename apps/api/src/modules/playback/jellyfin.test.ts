import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QUALITIES, type QualityModel } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor, SESSION_COOKIE } from '../auth/index.js';
import { MediaServersService, setMediaServersService } from '../media-servers/index.js';
import { setSection } from '../settings/service.js';
import { audioTranscoderFor } from './index.js';
import { JellyfinEngine, matchAudioPath, MISS_TTL_MS } from './jellyfin.js';
import type { RunningTranscode } from './transcode.js';

// The player's Jellyfin engine: path matching, the stream proxy (ranges, transcode parameters,
// headers, the key kept server side) and every fallback to Arclight's own engine. The Jellyfin
// server is a fake fetch; nothing leaves the machine.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };
const NOW = '2026-05-01T12:00:00.000Z';
const KEY = 'fake-jellyfin-key';
const quality = (): QualityModel => ({ quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: [...QUALITIES['Bluray-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });
const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const JF_BYTES = Buffer.from('FROM-JELLYFIN-BYTES');

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'arclight-jf-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('matchAudioPath', () => {
  const items = [
    { id: 'a', path: '/data/music/Artist/Album/01 Song.flac' },
    { id: 'b', path: '/data/music/Artist/Other/01 Song.flac' },
    { id: 'c', path: 'D:\\Music\\Artist\\Album\\02 Next.flac' },
  ];
  it('matches exactly, ignoring slashes and case', () => {
    expect(matchAudioPath('d:/music/artist/album/02 next.flac', items)?.id).toBe('c');
  });
  it('matches on the longest unique run of trailing folders (other mounts)', () => {
    expect(matchAudioPath('/mnt/pool/music/Artist/Album/01 Song.flac', items)?.id).toBe('a');
    expect(matchAudioPath('/srv/Album/02 Next.flac', items)?.id).toBe('c');
  });
  it('refuses ties and file-name-only matches', () => {
    expect(matchAudioPath('/x/01 Song.flac', items)).toBeNull();
    expect(matchAudioPath('/x/y/Elsewhere/01 Song.flac', items)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------------------

interface FakeCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
}

/** A fake Jellyfin: System/Info, Items (Path), Audio/{id}/stream[.ext]. */
class FakeJellyfin {
  calls: FakeCall[] = [];
  items: Array<{ Id: string; Path: string; Name?: string }> = [];
  down = false;
  streamStatus: number | null = null;

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new Error('connect ECONNREFUSED');
    const url = new URL(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    this.calls.push({ url, method: init?.method ?? 'GET', headers });
    if (headers['x-emby-token'] !== KEY) return new Response('unauthorized', { status: 401 });
    if (url.pathname === '/System/Info') return Response.json({ ServerName: 'Den', Version: '10.10.0', Id: 'srv1' });
    if (url.pathname === '/Items') {
      const term = url.searchParams.get('SearchTerm');
      const items = term ? this.items.filter((i) => (i.Name ?? '').toLowerCase().includes(term.toLowerCase())) : this.items;
      return Response.json({ Items: items, TotalRecordCount: items.length });
    }
    const stream = /^\/Audio\/([^/]+)\/stream(\.\w+)?$/.exec(url.pathname);
    if (stream) {
      if (!this.items.some((i) => i.Id === stream[1])) return new Response('', { status: 404 });
      if (this.streamStatus) return new Response('', { status: this.streamStatus });
      if (stream[2]) return new Response(JF_BYTES, { status: 200, headers: { 'content-type': 'audio/ogg' } });
      const range = /^bytes=(\d+)-(\d*)$/.exec(headers['range'] ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : JF_BYTES.length - 1;
        return new Response(JF_BYTES.subarray(start, end + 1), {
          status: 206,
          headers: { 'content-type': 'audio/flac', 'content-range': `bytes ${start}-${end}/${JF_BYTES.length}`, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes' },
        });
      }
      return new Response(JF_BYTES, { status: 200, headers: { 'content-type': 'audio/flac', 'content-length': String(JF_BYTES.length), 'accept-ranges': 'bytes' } });
    }
    return new Response('not found', { status: 404 });
  };

  streamCalls() {
    return this.calls.filter((c) => c.url.pathname.startsWith('/Audio/'));
  }
}

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
  fake: FakeJellyfin;
  servers: MediaServersService;
  launches: string[][];
}
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.app.close();
});

async function harness(opts: { server?: boolean; engine?: 'arclight' | 'jellyfin' } = {}): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  const fake = new FakeJellyfin();
  const servers = new MediaServersService({ db, fetch: fake.fetch, newId: () => 'jf1' });
  const launches: string[][] = [];
  let ctx: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (c) => {
      ctx = c;
      setMediaServersService(c, servers);
      audioTranscoderFor(c, {
        locate: async () => '/fake/ffmpeg',
        launcher: (_bin, args): RunningTranscode => {
          launches.push([...args]);
          const out = new PassThrough();
          out.end(Buffer.from('ENCODED'));
          return { stdout: out, done: Promise.resolve(), kill: () => out.destroy() };
        },
      });
    },
  });
  await app.ready();
  if (opts.server !== false) servers.create({ kind: 'jellyfin', name: 'Den', url: 'http://jellyfin.test', apiKey: KEY });
  setSection(db, 'features', { music: true, audiobooks: true, podcasts: false });
  setSection(db, 'player', { enabled: true, backend: opts.engine ?? 'jellyfin' });
  const h = { app, ctx: ctx!, db, fake, servers, launches };
  open.push(h);
  return h;
}

async function signIn(h: Harness, player: unknown = { allowed: true }): Promise<string> {
  const auth = authServiceFor(h.ctx);
  const user = await auth.createUser({ username: `u${Math.random().toString(36).slice(2, 8)}`, password: 'password1', role: 'user', settings: { player } });
  return `${SESSION_COOKIE}=${auth.createSession(user.id).token}`;
}

/** One album with two tracks; the fake server knows track 1 only (under its own mount). */
function seed(h: Harness) {
  const db = h.db;
  const type = db.insert(schema.albumTypeProfiles).values({ name: 'Studio', primaryTypes: ['Album'], secondaryTypes: [], releaseStatuses: ['Official'] }).returning().get();
  const artist = db
    .insert(schema.artists)
    .values({ mbArtistId: 'a1', name: 'The Testers', sortName: 'Testers, The', cleanName: 'testers', genres: [], images: [], links: [], aliases: [], path: tmp, rootFolderPath: tmp, qualityProfileId: 1, albumTypeProfileId: type.id, tags: [], added: NOW })
    .returning()
    .get();
  const album = db
    .insert(schema.albums)
    .values({ artistId: artist.id, mbReleaseGroupId: 'rg1', title: 'Sample Record', cleanTitle: 'samplerecord', primaryType: 'Album', secondaryTypes: [], genres: [], images: [], ratings: {}, added: NOW, year: 2020, releaseDate: '2020-05-01' })
    .returning()
    .get();
  const release = db.insert(schema.albumReleases).values({ albumId: album.id, mbReleaseId: 'r1', title: 'Sample Record', labels: [], formats: [], media: [] }).returning().get();
  const files = [1, 2].map((n) => {
    const path = join(tmp, `${Math.random().toString(36).slice(2, 8)}-0${n}.flac`);
    writeFileSync(path, BYTES);
    const f = db
      .insert(schema.audioFiles)
      .values({ mediaType: 'music', artistId: artist.id, albumId: album.id, path, relativePath: `0${n}.flac`, sizeBytes: BYTES.length, dateAdded: NOW, quality: quality(), codec: 'FLAC', bitrateKbps: 900, channels: 2, trackNumber: n, discNumber: 1, durationMs: 200_000, tags: { title: `Song ${n}` } })
      .returning()
      .get();
    const track = db.insert(schema.tracks).values({ albumId: album.id, albumReleaseId: release.id, absoluteNumber: n, trackNumber: n, title: `Song ${n}`, durationMs: 200_000, hasFile: true, audioFileId: f.id }).returning().get();
    return { fileId: f.id, trackId: track.id, path };
  });
  h.fake.items = [{ Id: 'jf-track-1', Name: 'Song 1', Path: `/data/${basename(tmp)}/${basename(files[0]!.path)}` }];
  return files;
}

const get = (h: Harness, url: string, cookie: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers: { cookie, ...headers } });

describe('stream through Jellyfin', () => {
  it('proxies the original with ranges, keeps the key server side and caches the mapping', async () => {
    const h = await harness();
    const [one] = seed(h);
    const cookie = await signIn(h);
    const res = await get(h, `/api/v1/stream/audio/${one!.fileId}`, cookie, { range: 'bytes=5-9' });
    expect(res.statusCode).toBe(206);
    expect(res.headers['x-arclight-backend']).toBe('jellyfin');
    expect(res.headers['content-range']).toBe(`bytes 5-9/${JF_BYTES.length}`);
    expect(res.rawPayload.equals(JF_BYTES.subarray(5, 10))).toBe(true);
    const [call] = h.fake.streamCalls();
    expect(call!.url.pathname).toBe('/Audio/jf-track-1/stream');
    expect(call!.url.searchParams.get('static')).toBe('true');
    expect(call!.headers['range']).toBe('bytes=5-9');
    expect(JSON.stringify(res.headers)).not.toContain(KEY);

    const lookups = h.fake.calls.filter((c) => c.url.pathname === '/Items').length;
    const again = await get(h, `/api/v1/stream/audio/${one!.fileId}`, cookie);
    expect([again.statusCode, again.headers['content-length']]).toEqual([200, String(JF_BYTES.length)]);
    expect(h.fake.calls.filter((c) => c.url.pathname === '/Items').length).toBe(lookups);
  });

  it('maps transcode format, bitrate and start onto the server and starts no ffmpeg', async () => {
    const h = await harness();
    const [one] = seed(h);
    const cookie = await signIn(h, { allowed: true, maxBitrateKbps: 96 });
    const res = await get(h, `/api/v1/stream/audio/${one!.fileId}?format=opus&bitrateKbps=160&startMs=5000`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-arclight-transcode']).toBe('opus/96');
    expect(res.headers['accept-ranges']).toBe('none');
    expect(res.rawPayload.equals(JF_BYTES)).toBe(true);
    const [call] = h.fake.streamCalls();
    expect(call!.url.pathname).toBe('/Audio/jf-track-1/stream.ogg');
    expect(Object.fromEntries(call!.url.searchParams)).toMatchObject({ audioCodec: 'opus', audioBitRate: '96000', startTimeTicks: '50000000', static: 'false' });
    expect(h.launches).toEqual([]);
  });

  it('keeps access control in front: a user without access never reaches the server', async () => {
    const h = await harness();
    const [one] = seed(h);
    const cookie = await signIn(h, { allowed: false });
    expect((await get(h, `/api/v1/stream/audio/${one!.fileId}`, cookie)).statusCode).toBe(403);
    expect(h.fake.calls).toEqual([]);
  });

  it('falls back to Arclight for files the server does not know, a server that is down, and 404s', async () => {
    const h = await harness();
    const [one, two] = seed(h);
    const cookie = await signIn(h);
    const unknown = await get(h, `/api/v1/stream/audio/${two!.fileId}`, cookie);
    expect([unknown.statusCode, unknown.headers['x-arclight-backend']]).toEqual([200, 'arclight']);
    expect(unknown.rawPayload.equals(BYTES)).toBe(true);

    h.fake.down = true;
    const down = await get(h, `/api/v1/stream/audio/${one!.fileId}`, cookie);
    expect([down.statusCode, down.headers['x-arclight-backend']]).toEqual([200, 'arclight']);

    h.fake.down = false;
    h.fake.streamStatus = 500;
    const failing = await get(h, `/api/v1/stream/audio/${one!.fileId}?format=opus`, cookie);
    expect([failing.statusCode, failing.headers['x-arclight-backend'], failing.body]).toEqual([200, 'arclight', 'ENCODED']);
    expect(h.launches).toHaveLength(1);
  });

  it('streams with Arclight when the engine is Arclight or no Jellyfin server is set up', async () => {
    for (const opts of [{ engine: 'arclight' as const }, { server: false }]) {
      const h = await harness(opts);
      const [one] = seed(h);
      const cookie = await signIn(h);
      const res = await get(h, `/api/v1/stream/audio/${one!.fileId}`, cookie);
      expect(res.headers['x-arclight-backend']).toBe('arclight');
      expect(h.fake.streamCalls()).toEqual([]);
      expect((await get(h, '/api/v1/playback/me', cookie)).json().engine).toBe('arclight');
    }
  });

  it('reports the engine on /playback/me and per link', async () => {
    const h = await harness();
    const [one, two] = seed(h);
    const cookie = await signIn(h);
    expect((await get(h, '/api/v1/playback/me', cookie)).json().engine).toBe('jellyfin');
    const links = async (trackId: number) =>
      (await h.app.inject({ method: 'POST', url: '/api/v1/playback/stream-links', headers: { cookie }, payload: { itemKey: `track:${trackId}` } })).json();
    const known = await links(one!.trackId);
    expect(known.backendInUse).toBe('jellyfin');
    expect(known.links[0].backend).toBe('jellyfin');
    expect(known.links[0].url).not.toContain(KEY);
    expect((await links(two!.trackId)).backendInUse).toBe('arclight');
  });
});

describe('POST /settings/player/engine-test', () => {
  it('checks the server and resolves a sample file', async () => {
    const h = await harness();
    seed(h);
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/settings/player/engine-test', headers: { 'x-api-key': authServiceFor(h.ctx).apiKey() }, payload: { jellyfinServerId: 'jf1' } });
    expect(res.json()).toMatchObject({ ok: true, serverId: 'jf1', serverName: 'Den', version: '10.10.0', sample: { resolved: true, itemId: 'jf-track-1' } });
  });

  it('explains a missing server and an unreachable one', async () => {
    const none = await harness({ server: false });
    const key = authServiceFor(none.ctx).apiKey();
    const missing = await none.app.inject({ method: 'POST', url: '/api/v1/settings/player/engine-test', headers: { 'x-api-key': key }, payload: {} });
    expect(missing.json()).toMatchObject({ ok: false, serverId: null });

    const h = await harness();
    seed(h);
    h.fake.down = true;
    const down = await h.app.inject({ method: 'POST', url: '/api/v1/settings/player/engine-test', headers: { 'x-api-key': authServiceFor(h.ctx).apiKey() }, payload: {} });
    expect(down.json()).toMatchObject({ ok: false, serverName: null });
    expect(down.json().message).toMatch(/Could not reach/);
  });
});

describe('JellyfinEngine cache', () => {
  it('asks again for a miss after MISS_TTL_MS', async () => {
    let now = 0;
    const lookups: string[] = [];
    const client = {
      info: async () => ({ name: 'Den' }),
      audioPaths: async (o?: { searchTerm?: string }) => {
        lookups.push(o?.searchTerm ?? '*');
        return [];
      },
      audioStream: async () => new Response(''),
    };
    const engine = new JellyfinEngine({
      servers: () => [{ id: 's', kind: 'jellyfin', name: 'Den', url: 'http://x.test', apiKey: 'k', enabled: true } as never],
      clientFor: () => client as never,
      log: { warn: () => undefined },
      now: () => now,
    });
    const target = engine.target({ enabled: true, allowRemote: false, remoteMaxBitrateKbps: 0, streamLinkHours: 6, backend: 'jellyfin', jellyfinServerId: null, video: true, videoMaxStreams: 3, videoMaxStreamsPerUser: 1 })!;
    const file = { id: 1, path: '/m/a/b.flac', title: 'B' };
    expect(await engine.resolve(target, file)).toBeNull();
    const first = lookups.length;
    expect(await engine.resolve(target, file)).toBeNull();
    expect(lookups.length).toBe(first);
    now += MISS_TTL_MS;
    await engine.resolve(target, file);
    expect(lookups.length).toBeGreaterThan(first);
  });
});
