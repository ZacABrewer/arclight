import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ActiveStreamsResponse, QUALITIES, type MediaInfo, type QualityModel } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor, SESSION_COOKIE } from '../auth/index.js';
import { setSection } from '../settings/service.js';
import { AUDIO_TS, fragment, initSegment, VIDEO_TS } from './hls/fmp4.fixtures.js';
import type { HlsProc } from './hls/jobs.js';
import { IDLE_MS } from './active-streams.js';
import { activeStreamsFor, audioTranscoderFor, hlsPartsFor } from './index.js';
import type { RunningTranscode } from './transcode.js';

// GET /api/v1/activity/streams over HTTP: who may read it, rows from heartbeats (music,
// audiobooks), audio streams and HLS sessions, how they end, the client address behind a trusted
// proxy, and that no link or token leaks into it. A fake ffmpeg; nothing leaves the machine.

const base: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };
const NOW = '2026-05-01T12:00:00.000Z';
const quality = (): QualityModel => ({ quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: [...QUALITIES['Bluray-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });
const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const BROWSER = { containers: ['mp4', 'webm'], videoCodecs: ['h264', 'vp9'], audioCodecs: ['aac', 'mp3', 'opus'], maxAudioChannels: 2, maxHeight: 2160 };
const HEVC10_AC3 = {
  container: 'matroska',
  videoFormat: 'hevc',
  videoBitDepth: 10,
  width: 3840,
  height: 2160,
  videoFps: 24,
  videoDynamicRangeType: 'HDR10',
  overallBitrate: 40_000_000,
  durationMs: 1_500_000,
  audioStreams: [{ codec: 'ac3', channels: 6, language: 'eng', title: null, default: true }],
  subtitleStreams: [],
} as unknown as MediaInfo;

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'arclight-streams-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
  clock: { t: number };
}
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.app.close();
});

async function harness(config: Partial<AppConfig> = {}): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  const clock = { t: Date.now() };
  let ctx: AppContext | undefined;
  const cacheDir = mkdtempSync(join(tmp, 'cache-'));
  const app = await buildApp({ ...base, ...config }, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (c) => {
      ctx = c;
      activeStreamsFor(c, { now: () => clock.t });
      audioTranscoderFor(c, {
        locate: async () => '/fake/ffmpeg',
        launcher: (): RunningTranscode => {
          const out = new PassThrough();
          out.end(Buffer.from('ENCODED'));
          return { stdout: out, done: Promise.resolve(), kill: () => out.destroy() };
        },
      });
      hlsPartsFor(c, {
        sessions: {
          root: () => join(cacheDir, 'hls'),
          locate: async () => '/fake/ffmpeg',
          launcher: (): HlsProc => {
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            let finish!: (code: number | null) => void;
            const done = new Promise<number | null>((r) => (finish = r));
            setImmediate(() => {
              stdout.write(initSegment());
              for (let k = 0; k < 3; k++) stdout.write(fragment(BigInt(k * 6 * VIDEO_TS), BigInt(k * 6 * AUDIO_TS)));
              stdout.end();
              stderr.end();
              finish(0);
            });
            return { stdout, stderr, done, pause: () => false, resume: () => undefined, kill: () => finish(null) };
          },
        },
        keyframes: { dir: join(cacheDir, 'keyframes'), locateProbe: async () => null },
        capacityFile: null,
        cpus: 8,
      });
    },
  });
  await app.ready();
  setSection(db, 'features', { music: true, audiobooks: true, podcasts: false });
  setSection(db, 'player', { enabled: true });
  const h = { app, ctx: ctx!, db, clock };
  open.push(h);
  return h;
}

async function signIn(h: Harness, role: 'user' | 'admin' = 'user') {
  const auth = authServiceFor(h.ctx);
  const username = `u${Math.random().toString(36).slice(2, 8)}`;
  const user = await auth.createUser({ username, password: 'password1', role, settings: { player: { allowed: true } } });
  return { cookie: `${SESSION_COOKIE}=${auth.createSession(user.id).token}`, id: user.id, username };
}

function file(name: string): string {
  const path = join(tmp, `${Math.random().toString(36).slice(2, 8)}-${name}`);
  writeFileSync(path, BYTES);
  return path;
}

/** One album with one track, one book (two chapters, one part) and one 4K HEVC movie. */
function seed(db: Db) {
  const type = db.insert(schema.albumTypeProfiles).values({ name: 'Studio', primaryTypes: ['Album'], secondaryTypes: [], releaseStatuses: ['Official'] }).returning().get();
  const artist = db
    .insert(schema.artists)
    .values({ mbArtistId: 'a1', name: 'The Testers', sortName: 'Testers, The', cleanName: 'testers', genres: [], images: [], links: [], aliases: [], path: join(tmp, 'Testers'), rootFolderPath: tmp, qualityProfileId: 1, albumTypeProfileId: type.id, tags: [], added: NOW })
    .returning()
    .get();
  const album = db
    .insert(schema.albums)
    .values({ artistId: artist.id, mbReleaseGroupId: 'rg1', title: 'Sample Record', cleanTitle: 'samplerecord', primaryType: 'Album', secondaryTypes: [], genres: [], images: [], ratings: {}, added: NOW, year: 2020 })
    .returning()
    .get();
  const release = db.insert(schema.albumReleases).values({ albumId: album.id, mbReleaseId: 'r1', title: 'Sample Record', labels: [], formats: [], media: [] }).returning().get();
  const audio = db
    .insert(schema.audioFiles)
    .values({ mediaType: 'music', artistId: artist.id, albumId: album.id, path: file('01.flac'), relativePath: '01.flac', sizeBytes: BYTES.length, dateAdded: NOW, quality: quality(), codec: 'FLAC', bitrateKbps: 900, channels: 2, trackNumber: 1, discNumber: 1, durationMs: 200_000 })
    .returning()
    .get();
  const track = db.insert(schema.tracks).values({ albumId: album.id, albumReleaseId: release.id, absoluteNumber: 1, trackNumber: 1, title: 'Song 1', durationMs: 200_000, hasFile: true, audioFileId: audio.id }).returning().get();
  const author = db
    .insert(schema.authors)
    .values({ name: 'A. Writer', sortName: 'Writer, A.', cleanName: 'awriter', images: [], genres: [], aliases: [], path: join(tmp, 'Writer'), rootFolderPath: tmp, qualityProfileId: 1, languages: [], tags: [], added: NOW })
    .returning()
    .get();
  const book = db
    .insert(schema.books)
    .values({
      authorId: author.id,
      title: 'Long Story',
      sortTitle: 'Long Story',
      cleanTitle: 'longstory',
      authorCredits: [{ name: 'A. Writer' }],
      narrators: [],
      genres: [],
      images: [],
      chapters: [
        { title: 'Opening', startMs: 0 },
        { title: 'The Middle', startMs: 60_000 },
      ],
      ratings: {},
      hasFile: true,
      added: NOW,
    })
    .returning()
    .get();
  db.insert(schema.audioFiles)
    .values({ mediaType: 'audiobook', authorId: author.id, bookId: book.id, path: file('part1.mp3'), relativePath: 'Long Story/Part 1.mp3', sizeBytes: BYTES.length, dateAdded: NOW, quality: quality(), codec: 'MPEG 1 Layer 3', bitrateKbps: 64, partNumber: 1, durationMs: 120_000 })
    .run();
  const dir = join(tmp, `movie-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const moviePath = join(dir, 'a.mkv');
  writeFileSync(moviePath, BYTES);
  const movie = db
    .insert(schema.movies)
    .values({ tmdbId: 50, title: 'Big Film', originalTitle: 'Big Film', sortTitle: 'big film', cleanTitle: 'bigfilm', year: 2021, status: 'released', runtimeMinutes: 25, genres: [], images: [], ratings: {}, originalLanguage: 'en', path: dir, rootFolderPath: tmp, qualityProfileId: 1, tags: [], added: NOW, hasFile: true })
    .returning()
    .get();
  const mf = db
    .insert(schema.mediaFiles)
    .values({ mediaType: 'movie', movieId: movie.id, relativePath: 'a.mkv', path: moviePath, sizeBytes: BYTES.length, dateAdded: NOW, quality: quality(), languages: ['English'], mediaInfo: HEVC10_AC3 })
    .returning()
    .get();
  db.update(schema.movies).set({ movieFileId: mf.id }).run();
  return { track, audio, book, movie };
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (h: Harness, method: Method, url: string, opts: { cookie?: string; payload?: object; headers?: Record<string, string>; remoteAddress?: string } = {}) =>
  h.app.inject({
    method,
    url,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
    ...(opts.payload ? { payload: opts.payload } : {}),
    ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
  });

const heartbeat = (h: Harness, cookie: string, itemKey: string, body: Record<string, unknown> = {}, extra: { headers?: Record<string, string>; remoteAddress?: string } = {}) =>
  call(h, 'PUT', `/api/v1/playback/progress/${itemKey}`, {
    cookie,
    payload: { event: 'progress', positionMs: 10_000, durationMs: 200_000, deviceId: 'web-abc', deviceName: 'Firefox', clientTime: new Date(h.clock.t).toISOString(), ...body },
    ...extra,
  });

async function streams(h: Harness, cookie: string) {
  const res = await call(h, 'GET', '/api/v1/activity/streams', { cookie });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return ActiveStreamsResponse.parse(res.json());
}

describe('GET /activity/streams', () => {
  it('is for admins only: portal users and non-owner profiles get 403', async () => {
    const h = await harness();
    const admin = await signIn(h, 'admin');
    const user = await signIn(h);
    expect((await call(h, 'GET', '/api/v1/activity/streams')).statusCode).toBe(401);
    expect((await call(h, 'GET', '/api/v1/activity/streams', { cookie: user.cookie })).statusCode).toBe(403);
    expect(await streams(h, admin.cookie)).toEqual({ streams: [], idleSec: 90, pausedIdleSec: 600 });
    // The admin's own non-owner profile is not an admin.
    const kid = await call(h, 'POST', '/api/v1/households/profiles', { cookie: admin.cookie, payload: { name: 'Kids' } });
    expect(kid.statusCode, kid.body).toBe(201);
    const kidCookie = `${SESSION_COOKIE}=${authServiceFor(h.ctx).createSession(admin.id).token}`;
    expect((await call(h, 'POST', `/api/v1/households/profiles/${kid.json().id}/select`, { cookie: kidCookie, payload: {} })).statusCode).toBe(200);
    expect((await call(h, 'GET', '/api/v1/activity/streams', { cookie: kidCookie })).statusCode).toBe(403);
  });

  it('app tokens: an admin device reads it and shows as the app; a non-admin device gets 403', async () => {
    const h = await harness();
    const { track } = seed(h.db);
    const admin = await signIn(h, 'admin');
    const user = await signIn(h);
    const device = { deviceName: 'Pixel Test', platform: 'android', appVersion: '0.25.0' };
    const token = async (username: string) => {
      const res = await call(h, 'POST', '/api/v1/app/sign-in', { payload: { username, password: 'password1', ...device } });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().token}` };
    };
    const adminApp = await token(admin.username);
    expect((await call(h, 'GET', '/api/v1/activity/streams', { headers: await token(user.username) })).statusCode).toBe(403);
    const res = await call(h, 'GET', '/api/v1/activity/streams', { headers: adminApp });
    expect(res.statusCode).toBe(200);
    // The app's own heartbeat: the row names the device as it signed in.
    const hb = await call(h, 'PUT', `/api/v1/playback/progress/track:${track.id}`, {
      headers: adminApp,
      payload: { event: 'start', positionMs: 0, durationMs: 200_000, deviceId: 'app-1', clientTime: new Date(h.clock.t).toISOString() },
    });
    expect(hb.statusCode, hb.body).toBe(200);
    const [row] = (await streams(h, admin.cookie)).streams;
    expect(row!.client).toEqual({ kind: 'app', deviceName: 'Pixel Test', platform: 'android', appVersion: '0.25.0' });
  });

  it('music and audiobook heartbeats make rows with the user, profile, item, client and address', async () => {
    const h = await harness();
    const { track, book } = seed(h.db);
    const admin = await signIn(h, 'admin');
    const user = await signIn(h);
    expect((await heartbeat(h, user.cookie, `track:${track.id}`, { event: 'start', positionMs: 0 })).statusCode).toBe(200);
    h.clock.t += 1_000;
    expect((await heartbeat(h, admin.cookie, `audiobook:${book.id}`, { positionMs: 70_000, durationMs: 120_000, deviceId: 'web-xyz' })).statusCode).toBe(200);
    const list = await streams(h, admin.cookie);
    expect(list.streams).toHaveLength(2);
    // Newest first.
    const [bookRow, trackRow] = list.streams;
    expect(trackRow).toMatchObject({
      state: 'playing',
      user: { id: user.id },
      profile: { isOwner: true },
      item: { itemKey: `track:${track.id}`, kind: 'track', title: 'Song 1', artist: 'The Testers', album: 'Sample Record' },
      client: { kind: 'web', deviceName: 'Firefox' },
      address: { ip: '127.0.0.1', remote: false },
      durationMs: 200_000,
    });
    // Extrapolated: 1 s later.
    expect(trackRow!.positionMs).toBe(1_000);
    expect(bookRow!.item).toMatchObject({ kind: 'audiobook', title: 'Long Story', chapter: 'The Middle' });
    expect(bookRow!.user.id).not.toBe(user.id);
  });

  it('pause, stop and the idle timeout', async () => {
    const h = await harness();
    const { track } = seed(h.db);
    const admin = await signIn(h, 'admin');
    const key = `track:${track.id}`;
    await heartbeat(h, admin.cookie, key);
    await heartbeat(h, admin.cookie, key, { event: 'pause', positionMs: 12_000 });
    expect((await streams(h, admin.cookie)).streams[0]).toMatchObject({ state: 'paused', positionMs: 12_000 });
    await heartbeat(h, admin.cookie, key, { event: 'stop', positionMs: 12_000 });
    expect((await streams(h, admin.cookie)).streams).toHaveLength(0);
    // A player that just goes away (tab closed, network gone) drops out after the timeout.
    await heartbeat(h, admin.cookie, key);
    h.clock.t += IDLE_MS + 1_000;
    expect((await streams(h, admin.cookie)).streams).toHaveLength(0);
  });

  it('an audio stream says how it plays; a download is not a stream', async () => {
    const h = await harness();
    const { track, audio } = seed(h.db);
    const admin = await signIn(h, 'admin');
    expect((await call(h, 'GET', `/api/v1/stream/audio/${audio.id}?download=1`, { cookie: admin.cookie })).statusCode).toBe(200);
    expect((await streams(h, admin.cookie)).streams).toHaveLength(0);
    const res = await call(h, 'GET', `/api/v1/stream/audio/${audio.id}?format=opus&bitrateKbps=128`, { cookie: admin.cookie });
    expect(res.statusCode).toBe(200);
    await heartbeat(h, admin.cookie, `track:${track.id}`);
    const rows = (await streams(h, admin.cookie)).streams;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.playback).toMatchObject({ method: 'transcode', delivery: 'progressive', backend: 'arclight', audioFormat: 'opus', bitrateKbps: 128, hwaccel: null });
  });

  it('a signed link stream counts for the link user', async () => {
    const h = await harness();
    const { track, audio } = seed(h.db);
    const admin = await signIn(h, 'admin');
    const links = await call(h, 'POST', '/api/v1/playback/stream-links', { cookie: admin.cookie, payload: { itemKey: `track:${track.id}`, format: 'original' } });
    expect(links.statusCode, links.body).toBe(200);
    const url = (links.json().links[0].url as string).replace(/^https?:\/\/[^/]+/, '');
    expect(url).toContain(`/stream/audio/${audio.id}`);
    expect((await call(h, 'GET', url)).statusCode).toBe(200);
    const rows = (await streams(h, admin.cookie)).streams;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user: { id: admin.id }, item: { itemKey: `track:${track.id}` }, client: { kind: 'other' }, playback: { method: 'direct', bitrateKbps: 900 } });
  });

  it('an HLS session shows with its device, rung and encoder until DELETE', async () => {
    const h = await harness();
    const { movie } = seed(h.db);
    const admin = await signIn(h, 'admin');
    const res = await call(h, 'POST', '/api/v1/playback/video/session', {
      cookie: admin.cookie,
      payload: { itemKey: `movie:${movie.id}`, profile: BROWSER, deliveries: ['hls', 'progressive'], deviceKey: 'tv-1', startMs: 30_000 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json();
    expect(s.delivery).toBe('hls');
    const [row] = (await streams(h, admin.cookie)).streams;
    expect(row).toMatchObject({ item: { kind: 'movie', title: 'Big Film', year: 2021 }, positionMs: 30_000, durationMs: 1_500_000 });
    expect(row!.playback).toMatchObject({ method: 'transcode', delivery: 'hls', hwaccel: 'none' });
    expect(row!.playback.rung).toMatchObject({ codec: 'h264' });
    expect(row!.playback.bitrateKbps).toBe(row!.playback.rung!.videoKbps);
    // Segment requests keep it alive past the idle timeout.
    h.clock.t += IDLE_MS - 5_000;
    expect((await call(h, 'GET', s.url.replace(/^https?:\/\/[^/]+/, ''))).statusCode).toBe(200);
    h.clock.t += 10_000;
    expect((await streams(h, admin.cookie)).streams).toHaveLength(1);
    // Nothing in the list carries a link, signature or token.
    const raw = (await call(h, 'GET', '/api/v1/activity/streams', { cookie: admin.cookie })).body;
    expect(raw).not.toMatch(/sig=|exp=|m3u8|token|stream\//);
    expect((await call(h, 'DELETE', `/api/v1/playback/video/session/${s.sessionId}`, { cookie: admin.cookie })).statusCode).toBe(204);
    expect((await streams(h, admin.cookie)).streams).toHaveLength(0);
  });
});

describe('client address', () => {
  it('uses X-Forwarded-For only from a trusted proxy', async () => {
    const h = await harness({ trustedProxies: '192.0.2.1' });
    const { track } = seed(h.db);
    const admin = await signIn(h, 'admin');
    const key = `track:${track.id}`;
    setSection(h.db, 'player', { enabled: true, allowRemote: true });
    await heartbeat(h, admin.cookie, key, {}, { remoteAddress: '192.0.2.1', headers: { 'x-forwarded-for': '198.51.100.20' } });
    expect((await call(h, 'GET', '/api/v1/activity/streams', { cookie: admin.cookie, remoteAddress: '192.0.2.1' })).json().streams[0].address).toEqual({ ip: '198.51.100.20', remote: true });
    // From an untrusted peer the header is ignored: the peer's own address shows.
    await heartbeat(h, admin.cookie, key, { deviceId: 'web-2' }, { remoteAddress: '203.0.113.7', headers: { 'x-forwarded-for': '10.0.0.5' } });
    const rows = (await call(h, 'GET', '/api/v1/activity/streams', { cookie: admin.cookie, remoteAddress: '192.0.2.1' })).json().streams as Array<{ address: { ip: string } }>;
    expect(rows.map((r) => r.address.ip).sort()).toEqual(['198.51.100.20', '203.0.113.7']);
  });
});
