import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QUALITIES, type MediaInfo, type QualityModel } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor, SESSION_COOKIE } from '../auth/index.js';
import { parseFfprobeOutput } from '../media-analysis/parse.js';
import { locateFfprobe } from '../media-analysis/runner.js';
import { setSection } from '../settings/service.js';
import { locateFfmpeg } from '../transcode/runner.js';
import { videoPartsFor, videoTranscoderFor } from './index.js';
import type { RunningTranscode } from './transcode.js';
import { ChapterReader } from './video-items.js';

// Movies & TV over HTTP: items, the playback session and its reasons, the video stream (ranges,
// signed links, live remux/transcode through a fake ffmpeg), WebVTT subtitles, artwork, browse,
// "mark watched", search, content restrictions and the Movies & TV switch. A last block runs a
// real ffmpeg on tiny generated files when one is installed.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };
const NOW = '2026-05-01T12:00:00.000Z';
const quality = (): QualityModel => ({ quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: [...QUALITIES['Bluray-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });

const ffmpeg = await locateFfmpeg();
const ffprobe = await locateFfprobe();
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'arclight-video-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const BROWSER = { containers: ['mp4', 'webm'], videoCodecs: ['h264', 'vp9'], audioCodecs: ['aac', 'mp3', 'opus'], maxAudioChannels: 2, maxHeight: 2160 };

const H264_AAC: MediaInfo = {
  container: 'mp4',
  videoFormat: 'h264',
  videoBitDepth: 8,
  width: 1920,
  height: 1080,
  videoFps: 24,
  videoDynamicRangeType: 'SDR',
  overallBitrate: 6_000_000,
  durationMs: 600_000,
  audioStreams: [{ codec: 'aac', channels: 2, language: 'eng', title: null, default: true }],
  subtitleStreams: [],
} as MediaInfo;

const HEVC10_AC3: MediaInfo = {
  container: 'matroska',
  videoFormat: 'hevc',
  videoBitDepth: 10,
  width: 3840,
  height: 2160,
  videoFps: 24,
  videoDynamicRangeType: 'HDR10',
  overallBitrate: 40_000_000,
  durationMs: 1_500_000,
  audioStreams: [
    { codec: 'ac3', channels: 6, language: 'eng', title: null, default: true },
    { codec: 'aac', channels: 2, language: 'ger', title: null, default: false },
  ],
  subtitleStreams: [
    { codec: 'subrip', language: 'eng', forced: false, hearingImpaired: false, default: false, title: null },
    { codec: 'hdmv_pgs_subtitle', language: 'eng', forced: true, hearingImpaired: false, default: false, title: null },
  ],
} as MediaInfo;

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
  launches: string[][];
  converts: string[][];
  probes: string[];
  /** With `hold`, live streams keep their slot until these are called. */
  release: Array<() => void>;
}
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.app.close();
});

async function harness(opts: { real?: boolean; hold?: boolean } = {}): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  const launches: string[][] = [];
  const converts: string[][] = [];
  const probes: string[] = [];
  const release: Array<() => void> = [];
  let ctx: AppContext | undefined;
  const cacheDir = mkdtempSync(join(tmp, 'cache-'));
  const app = await buildApp(config, db, pino({ level: process.env.VT_LOG ?? 'silent' }), {
    probe: false,
    onContext: (c) => {
      ctx = c;
      if (opts.real) {
        videoPartsFor(c, { cache: { dir: cacheDir }, encoders: { detect: async () => ({ hwaccel: 'none', zscale: false }) } });
        return;
      }
      videoTranscoderFor(c, {
        locate: async () => '/fake/ffmpeg',
        launcher: (_bin, args): RunningTranscode => {
          launches.push([...args]);
          const out = new PassThrough();
          out.end(Buffer.from('FMP4DATA'));
          if (!opts.hold) return { stdout: out, done: Promise.resolve(), kill: () => out.destroy() };
          let end!: () => void;
          const done = new Promise<void>((r) => (end = r));
          release.push(end);
          return { stdout: out, done, kill: end };
        },
      });
      videoPartsFor(c, {
        encoders: { detect: async () => ({ hwaccel: 'none', zscale: true }) },
        cache: {
          dir: cacheDir,
          locate: async () => '/fake/ffmpeg',
          exec: async (_bin, args) => {
            converts.push([...args]);
            const out = args.at(-1)!;
            writeFileSync(out, out.endsWith('.vtt') ? 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n' : Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
            return { code: 0, stdout: '' };
          },
        },
        chapters: new ChapterReader(async (path) => {
          probes.push(path);
          return JSON.stringify({ chapters: [{ start_time: 0, end_time: 30, tags: { title: 'Intro' } }, { start_time: 30, end_time: 1400, tags: { title: 'Story' } }, { start_time: 1400, end_time: 1500, tags: { title: 'End Credits' } }] });
        }),
      });
    },
  });
  await app.ready();
  setSection(db, 'player', { enabled: true });
  const h = { app, ctx: ctx!, db, launches, converts, probes, release };
  open.push(h);
  return h;
}

async function signIn(h: Harness, opts: { restrictions?: unknown; role?: 'user' | 'admin'; allowed?: boolean } = {}) {
  const auth = authServiceFor(h.ctx);
  const user = await auth.createUser({
    username: `u${Math.random().toString(36).slice(2, 8)}`,
    password: 'password1',
    role: opts.role ?? 'user',
    settings: { player: { allowed: opts.allowed ?? true }, ...(opts.restrictions ? { contentRestrictions: opts.restrictions } : {}) },
  });
  return { cookie: `${SESSION_COOKIE}=${auth.createSession(user.id).token}`, id: user.id };
}

const BYTES = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 256));
function blob(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, BYTES);
  return path;
}

function addMovie(db: Db, opts: { title: string; tmdbId: number; certification?: string | null; files: Array<{ name: string; info: MediaInfo; tag?: string | null; path?: string }>; genres?: string[] }) {
  const dir = join(tmp, `movie-${opts.tmdbId}`);
  const movie = db
    .insert(schema.movies)
    .values({
      tmdbId: opts.tmdbId,
      title: opts.title,
      originalTitle: opts.title,
      sortTitle: opts.title.toLowerCase(),
      cleanTitle: opts.title.toLowerCase().replace(/\W/g, ''),
      year: 2021,
      status: 'released',
      runtimeMinutes: 100,
      genres: opts.genres ?? ['Drama'],
      images: [
        { coverType: 'poster', url: '/MediaCover/1/poster.jpg', remoteUrl: 'https://image.tmdb.org/t/p/original/poster.jpg' },
        { coverType: 'fanart', url: 'https://image.tmdb.org/t/p/original/fanart.jpg' },
      ],
      ratings: { tmdb: { value: 7.5, votes: 100 } },
      certification: opts.certification ?? 'PG-13',
      originalLanguage: 'en',
      path: dir,
      rootFolderPath: tmp,
      qualityProfileId: 1,
      tags: [],
      added: NOW,
      hasFile: true,
    })
    .returning()
    .get();
  const files = opts.files.map((f) => {
    const path = f.path ?? blob(dir, f.name);
    return db
      .insert(schema.mediaFiles)
      .values({ mediaType: 'movie', movieId: movie.id, relativePath: f.name, path, sizeBytes: statSync(path).size, dateAdded: NOW, quality: quality(), languages: ['English'], mediaInfo: f.info, versionTag: f.tag ?? null })
      .returning()
      .get();
  });
  db.update(schema.movies).set({ movieFileId: files[0]!.id }).run();
  return { movie, files };
}

function addSeries(db: Db, opts: { certification?: string | null; info?: MediaInfo } = {}) {
  const dir = join(tmp, `series-${Math.random().toString(36).slice(2, 8)}`);
  const show = db
    .insert(schema.series)
    .values({
      tmdbId: Math.floor(Math.random() * 1e6),
      title: 'Test Show',
      sortTitle: 'test show',
      cleanTitle: 'testshow',
      year: 2020,
      status: 'continuing',
      genres: ['Comedy'],
      images: [{ coverType: 'fanart', url: 'https://image.tmdb.org/t/p/original/show-fanart.jpg' }],
      ratings: {},
      certification: opts.certification ?? 'TV-14',
      originalLanguage: 'en',
      path: dir,
      rootFolderPath: tmp,
      qualityProfileId: 1,
      tags: [],
      added: NOW,
      runtimeMinutes: 25,
    })
    .returning()
    .get();
  const episodes = [1, 2, 3].map((n) => {
    const hasFile = n !== 3;
    let fileId: number | null = null;
    if (hasFile) {
      const path = blob(join(dir, 'Season 1'), `S01E0${n}.mkv`);
      fileId = db
        .insert(schema.mediaFiles)
        .values({ mediaType: 'series', seriesId: show.id, seasonNumber: 1, relativePath: `Season 1/S01E0${n}.mkv`, path, sizeBytes: BYTES.length, dateAdded: NOW, quality: quality(), languages: ['English'], mediaInfo: opts.info ?? HEVC10_AC3 })
        .returning()
        .get().id;
    }
    return db
      .insert(schema.episodes)
      .values({ seriesId: show.id, seasonNumber: 1, episodeNumber: n, title: `Episode ${n}`, airDate: `2020-01-0${n}`, hasFile, episodeFileId: fileId })
      .returning()
      .get();
  });
  return { show, episodes };
}

const get = (h: Harness, url: string, cookie?: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers: { ...(cookie ? { cookie } : {}), ...headers } });
const post = (h: Harness, url: string, payload: object, cookie?: string) => h.app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });
const session = (h: Harness, cookie: string, body: object) => post(h, '/api/v1/playback/video/session', { profile: BROWSER, ...body }, cookie);
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

describe('items', () => {
  it('a movie item carries its video info, versions best first, chapters and segments', async () => {
    const h = await harness();
    const user = await signIn(h);
    const { movie, files } = addMovie(h.db, { title: 'First Film', tmdbId: 1, files: [{ name: 'a.mp4', info: H264_AAC }, { name: 'b.mkv', info: HEVC10_AC3, tag: '4K' }] });
    const res = await get(h, `/api/v1/playback/item/movie:${movie.id}`, user.cookie);
    expect(res.statusCode).toBe(200);
    const item = res.json();
    expect(item).toMatchObject({ kind: 'movie', title: 'First Film' });
    expect(item.versions.map((v: { mediaFileId: number }) => v.mediaFileId)).toEqual([files[1]!.id, files[0]!.id]);
    expect(item.versions[0].label).toBe('4K HDR');
    expect(item.chapters.length).toBe(3);
    expect(item.segments).toEqual([
      { type: 'intro', startMs: 0, endMs: 30_000 },
      { type: 'credits', startMs: 1_400_000, endMs: 1_500_000 },
    ]);
    expect(h.probes).toHaveLength(1);
    // The batch route uses cached chapters only.
    const batch = await post(h, '/api/v1/playback/items', { itemKeys: [`movie:${movie.id}`, 'movie:999'] }, user.cookie);
    expect(batch.json()).toHaveLength(1);
    expect(h.probes).toHaveLength(1);
  });

  it('episodes link previous and next episodes that have files', async () => {
    const h = await harness();
    const user = await signIn(h);
    const { episodes } = addSeries(h.db);
    const first = (await get(h, `/api/v1/playback/item/episode:${episodes[0]!.id}`, user.cookie)).json();
    expect(first.previous).toBeUndefined();
    expect(first).toMatchObject({ next: `episode:${episodes[1]!.id}` });
    const second = (await get(h, `/api/v1/playback/item/episode:${episodes[1]!.id}`, user.cookie)).json();
    expect(second).toMatchObject({ previous: `episode:${episodes[0]!.id}` });
    expect(second.next).toBeUndefined();
    expect((await get(h, `/api/v1/playback/item/episode:${episodes[2]!.id}`, user.cookie)).statusCode).toBe(404);
  });

  it('content restrictions and the Movies & TV switch hide items', async () => {
    const h = await harness();
    const kid = await signIn(h, { restrictions: { maxCertification: { movie: 'PG', tv: 'TV-PG' } } });
    const { movie } = addMovie(h.db, { title: 'Grown Up', tmdbId: 2, certification: 'R', files: [{ name: 'a.mp4', info: H264_AAC }] });
    const { episodes } = addSeries(h.db, { certification: 'TV-MA' });
    expect((await get(h, `/api/v1/playback/item/movie:${movie.id}`, kid.cookie)).statusCode).toBe(404);
    expect((await get(h, `/api/v1/playback/item/episode:${episodes[0]!.id}`, kid.cookie)).statusCode).toBe(404);
    expect((await session(h, kid.cookie, { itemKey: `movie:${movie.id}` })).statusCode).toBe(404);
    const adult = await signIn(h);
    expect((await get(h, `/api/v1/playback/item/movie:${movie.id}`, adult.cookie)).statusCode).toBe(200);
    setSection(h.db, 'player', { enabled: true, video: false });
    expect((await get(h, `/api/v1/playback/item/movie:${movie.id}`, adult.cookie)).statusCode).toBe(404);
    expect((await get(h, '/api/v1/playback/movies', adult.cookie)).json().code).toBe('SECTION_OFF');
    expect((await get(h, '/api/v1/playback/me', adult.cookie)).json().sections.video).toBe(false);
  });
});

describe('the playback session', () => {
  it('direct plays an MP4 in a browser and serves byte ranges through the signed link', async () => {
    const h = await harness();
    const user = await signIn(h);
    const { movie, files } = addMovie(h.db, { title: 'Direct', tmdbId: 3, files: [{ name: 'a.mp4', info: H264_AAC }] });
    const res = await session(h, user.cookie, { itemKey: `movie:${movie.id}`, startMs: 5000 });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s).toMatchObject({ method: 'direct', reasons: [], mediaFileId: files[0]!.id, mimeType: 'video/mp4', streamStartMs: 0, seekable: true, audioTrack: 0 });
    const url = pathOf(s.url);
    expect(url).toMatch(/^\/api\/v1\/stream\/video\/\d+\?m=direct&u=\d+&exp=\d+&sig=/);
    // Anonymous with the link.
    const range = await get(h, url, undefined, { range: 'bytes=10-19' });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe(`bytes 10-19/${BYTES.length}`);
    expect(range.rawPayload).toEqual(BYTES.subarray(10, 20));
    expect((await h.app.inject({ method: 'HEAD', url })).headers['accept-ranges']).toBe('bytes');
    // A tampered or foreign link fails.
    expect((await get(h, url.replace(/sig=[^&]+/, 'sig=AAAA'))).statusCode).toBe(403);
    expect((await get(h, url.replace(`/video/${files[0]!.id}`, '/video/99999'))).statusCode).toBe(403);
    // Audio links do not open videos (separate signing domain).
    expect((await get(h, url.replace('/stream/video/', '/stream/audio/'))).statusCode).not.toBe(206);
  });

  it('remuxes a 10-bit HEVC file on a TV without MKV and transcodes it for a browser, with reasons', async () => {
    const h = await harness();
    const user = await signIn(h);
    const { movie } = addMovie(h.db, { title: 'Big', tmdbId: 4, files: [{ name: 'b.mkv', info: HEVC10_AC3 }] });
    const tv = { containers: ['mp4'], videoCodecs: ['h264', 'hevc'], hevc10bit: true, hdr: ['hdr10'], audioCodecs: ['aac', 'ac3'], maxAudioChannels: 6, maxHeight: 2160 };
    const remux = (await post(h, '/api/v1/playback/video/session', { itemKey: `movie:${movie.id}`, profile: tv, startMs: 60_000 }, user.cookie)).json();
    expect(remux).toMatchObject({ method: 'remux', reasons: ['container'], mimeType: 'video/mp4', streamStartMs: 60_000, seekable: false });
    expect(remux.url).toContain('m=remux&a=0&s=60000&ac=copy');
    const body = await get(h, pathOf(remux.url));
    expect(body.statusCode).toBe(200);
    expect(body.headers['content-type']).toBe('video/mp4');
    expect(body.body).toBe('FMP4DATA');
    const remuxArgs = h.launches.at(-1)!.join(' ');
    expect(remuxArgs).toContain('-ss 60.000');
    expect(remuxArgs).toContain('-c:v copy -tag:v hvc1');
    expect(remuxArgs).toContain('-c:a copy');
    expect(remuxArgs).toContain('empty_moov+delay_moov');

    const tx = (await session(h, user.cookie, { itemKey: `movie:${movie.id}`, audioTrack: 1, subtitle: 'e1' })).json();
    expect(tx.method).toBe('transcode');
    // Track 1 is stereo AAC, so audio is not a reason.
    expect(tx.reasons).toEqual(['container', 'video-codec', 'hdr', 'burn-subtitle']);
    expect(tx).toMatchObject({ audioTrack: 1, burnedSubtitle: 'e1' });
    expect(tx.url).toContain('m=transcode&a=1');
    expect(tx.url).toContain('vc=h264');
    expect(tx.url).toContain('b=e1');
    await get(h, pathOf(tx.url));
    const txArgs = h.launches.at(-1)!.join(' ');
    expect(txArgs).toContain('-map 0:a:1?');
    expect(txArgs).toContain('[0:s:1][0:v:0]scale2ref');
    expect(txArgs).toContain('zscale=t=linear');
    expect(txArgs).toContain('-c:v libx264');
    // Only the text subtitle is offered as WebVTT.
    expect(tx.subtitles.map((s: { id: string; label: string }) => [s.id, s.label])).toEqual([['e0', 'English']]);
  });

  it('picks the version that direct plays, honours an explicit version and rejects unknown subtitles', async () => {
    const h = await harness();
    const user = await signIn(h);
    const { movie, files } = addMovie(h.db, { title: 'Two', tmdbId: 5, files: [{ name: 'a.mp4', info: H264_AAC }, { name: 'b.mkv', info: HEVC10_AC3, tag: '4K' }] });
    expect((await session(h, user.cookie, { itemKey: `movie:${movie.id}` })).json()).toMatchObject({ method: 'direct', mediaFileId: files[0]!.id });
    expect((await session(h, user.cookie, { itemKey: `movie:${movie.id}`, mediaFileId: files[1]!.id })).json()).toMatchObject({ method: 'transcode', mediaFileId: files[1]!.id });
    expect((await session(h, user.cookie, { itemKey: `movie:${movie.id}`, mediaFileId: 99999 })).statusCode).toBe(404);
    expect((await session(h, user.cookie, { itemKey: `movie:${movie.id}`, subtitle: 'e7' })).json().code).toBe('NO_SUBTITLE');
    expect((await session(h, user.cookie, { itemKey: 'track:1' })).json().code).toBe('NOT_VIDEO');
  });

  it('the remote bitrate cap forces a transcode, also on a link that asked for direct play', async () => {
    const h = await harness();
    setSection(h.db, 'player', { enabled: true, allowRemote: true, remoteMaxBitrateKbps: 2000 });
    const user = await signIn(h);
    const { movie } = addMovie(h.db, { title: 'Far', tmdbId: 6, files: [{ name: 'a.mp4', info: H264_AAC }] });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/playback/video/session', payload: { itemKey: `movie:${movie.id}`, profile: BROWSER }, headers: { cookie: user.cookie }, remoteAddress: '203.0.113.9' });
    const s = res.json();
    expect(s).toMatchObject({ method: 'transcode', reasons: ['bitrate'] });
    const direct = pathOf(s.url).replace(/m=transcode[^&]*(&[ahkbs]=[^&]*|&ac=[^&]*|&vc=[^&]*)*/, 'm=direct');
    const forced = await h.app.inject({ method: 'GET', url: direct, remoteAddress: '203.0.113.9' });
    expect(forced.headers['content-type']).toBe('video/mp4');
    expect(forced.headers['accept-ranges']).toBe('none');
    expect(h.launches.at(-1)!.join(' ')).toMatch(/-b:v (\d+)k/);
    const kbps = Number(/-b:v (\d+)k/.exec(h.launches.at(-1)!.join(' '))![1]);
    expect(kbps).toBeLessThanOrEqual(2000);
  });

  it('live video slots: the newest of a user replaces their oldest; others get 503 and HEAD reports it', async () => {
    const h = await harness({ hold: true });
    setSection(h.db, 'player', { enabled: true, videoMaxStreams: 1, videoMaxStreamsPerUser: 1 });
    const a = await signIn(h);
    const b = await signIn(h);
    const { movie } = addMovie(h.db, { title: 'Busy', tmdbId: 7, files: [{ name: 'b.mkv', info: HEVC10_AC3 }] });
    const transcoder = videoTranscoderFor(h.ctx);
    const sa = pathOf((await session(h, a.cookie, { itemKey: `movie:${movie.id}` })).json().url);
    const sb = pathOf((await session(h, b.cookie, { itemKey: `movie:${movie.id}` })).json().url);
    expect((await h.app.inject({ method: 'HEAD', url: sa })).statusCode).toBe(200);
    // b holds the only slot (a stream still playing).
    await transcoder.startArgs(['-i', 'x', 'pipe:1'], b.id);
    expect(transcoder.activeFor(b.id)).toBe(1);
    // a is turned away while b plays; HEAD says so without starting anything.
    const launched = h.launches.length;
    expect((await h.app.inject({ method: 'HEAD', url: sa })).statusCode).toBe(503);
    expect((await get(h, sa)).json().code).toBe('TRANSCODE_BUSY');
    expect(h.launches.length).toBe(launched);
    // b starting again (a seek) replaces b's own stream rather than being refused.
    expect((await get(h, sb)).statusCode).toBe(200);
    expect(transcoder.active).toBeLessThanOrEqual(1);
    for (const r of h.release) r();
    await new Promise((r) => setImmediate(r));
    expect(transcoder.active).toBe(0);
    expect((await h.app.inject({ method: 'HEAD', url: sa })).statusCode).toBe(200);
  });
});

describe('subtitles', () => {
  it('converts embedded and external text subtitles to WebVTT once, behind the signed link', async () => {
    const h = await harness();
    const user = await signIn(h);
    const { movie, files } = addMovie(h.db, { title: 'Subs', tmdbId: 8, files: [{ name: 'b.mkv', info: HEVC10_AC3 }] });
    const srt = join(tmp, 'movie-8', 'b.de.srt');
    writeFileSync(srt, '1\n00:00:01,000 --> 00:00:02,000\nHallo\n');
    const sub = h.db.insert(schema.subtitleFiles).values({ mediaFileId: files[0]!.id, language: 'ger', path: srt, codec: 'srt', added: NOW }).returning().get();
    const s = (await post(h, '/api/v1/playback/video/session', { itemKey: `movie:${movie.id}`, profile: { ...BROWSER, containers: ['mkv'], videoCodecs: ['hevc'], hevc10bit: true, hdr: ['hdr10'], audioCodecs: ['ac3'], maxAudioChannels: 6 } }, user.cookie)).json();
    expect(s.method).toBe('direct');
    expect(s.subtitles.map((t: { id: string; label: string }) => [t.id, t.label])).toEqual([
      ['e0', 'English'],
      [`x${sub.id}`, 'German'],
    ]);
    const embedded = await get(h, pathOf(s.subtitles[0].url));
    expect(embedded.statusCode).toBe(200);
    expect(embedded.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(embedded.headers['access-control-allow-origin']).toBe('*');
    expect(embedded.body).toContain('WEBVTT');
    expect(h.converts.at(-1)!.join(' ')).toContain('-map 0:s:0 -c:s webvtt');
    await get(h, pathOf(s.subtitles[0].url));
    expect(h.converts).toHaveLength(1);
    const external = await get(h, pathOf(s.subtitles[1].url));
    expect(external.statusCode).toBe(200);
    expect(h.converts.at(-1)!.join(' ')).toContain(`-i ${srt}`);
    // The picture subtitle and unknown ids are not served as text.
    const base = pathOf(s.subtitles[0].url);
    expect((await get(h, base.replace('/e0.vtt', '/e1.vtt'))).statusCode).toBe(404);
    expect((await get(h, base.replace('/e0.vtt', '/x999.vtt'))).statusCode).toBe(404);
    expect((await get(h, base.replace(/sig=[^&]+/, 'sig=AAAA'))).statusCode).toBe(403);
  });
});

describe('artwork', () => {
  it('redirects to sized TMDB images and makes episode thumbnails, falling back to the series backdrop', async () => {
    const h = await harness();
    const user = await signIn(h);
    const { movie } = addMovie(h.db, { title: 'Art', tmdbId: 9, files: [{ name: 'a.mp4', info: H264_AAC }] });
    const poster = await get(h, `/api/v1/playback/artwork/movie/${movie.id}?w=342`, user.cookie);
    expect(poster.statusCode).toBe(302);
    expect(poster.headers.location).toBe('https://image.tmdb.org/t/p/w342/poster.jpg');
    const fanart = await get(h, `/api/v1/playback/artwork/movie/${movie.id}?type=fanart&w=1280`, user.cookie);
    expect(fanart.headers.location).toBe('https://image.tmdb.org/t/p/w1280/fanart.jpg');
    expect((await get(h, `/api/v1/playback/artwork/movie/${movie.id}?type=logo`, user.cookie)).statusCode).toBe(404);
    const { show, episodes } = addSeries(h.db);
    expect((await get(h, `/api/v1/playback/artwork/series/${show.id}?type=fanart`, user.cookie)).headers.location).toBe('https://image.tmdb.org/t/p/original/show-fanart.jpg');
    const thumb = await get(h, `/api/v1/playback/artwork/episode/${episodes[0]!.id}`, user.cookie);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    expect(h.converts.at(-1)!.join(' ')).toContain('-ss 225.000');
    const missing = await get(h, `/api/v1/playback/artwork/episode/${episodes[2]!.id}`, user.cookie);
    expect(missing.headers.location).toBe('https://image.tmdb.org/t/p/w780/show-fanart.jpg');
    // Restricted titles have no artwork; album artwork still uses the generic route.
    const kid = await signIn(h, { restrictions: { maxCertification: { movie: 'G', tv: null } } });
    expect((await get(h, `/api/v1/playback/artwork/movie/${movie.id}`, kid.cookie)).statusCode).toBe(404);
    expect((await get(h, '/api/v1/playback/artwork/album/1', user.cookie)).statusCode).toBe(404);
  });
});

describe('browse, watched and search', () => {
  it('lists movies and series, details, home rows, and marks watched', async () => {
    const h = await harness();
    const user = await signIn(h);
    const { movie } = addMovie(h.db, { title: 'Alpha', tmdbId: 10, files: [{ name: 'a.mp4', info: H264_AAC }], genres: ['Action'] });
    addMovie(h.db, { title: 'Beta', tmdbId: 11, files: [{ name: 'b.mkv', info: HEVC10_AC3 }] });
    const { show, episodes } = addSeries(h.db);
    const page = (await get(h, '/api/v1/playback/movies?sort=title', user.cookie)).json();
    expect(page).toMatchObject({ total: 2, page: 1 });
    expect(page.items.map((m: { title: string }) => m.title)).toEqual(['Alpha', 'Beta']);
    expect(page.items[0]).toMatchObject({ itemKey: `movie:${movie.id}`, rating: 7.5, played: false, posterUrl: expect.stringContaining(`/api/v1/playback/artwork/movie/${movie.id}`) });
    expect(page.items[1].badges).toEqual(['4K', 'HDR']);
    expect((await get(h, '/api/v1/playback/movies?genre=Action', user.cookie)).json().total).toBe(1);
    const details = (await get(h, `/api/v1/playback/movies/${movie.id}`, user.cookie)).json();
    expect(details.versions).toHaveLength(1);
    expect((await get(h, '/api/v1/playback/movies/99999', user.cookie)).statusCode).toBe(404);

    const shows = (await get(h, '/api/v1/playback/series', user.cookie)).json();
    expect(shows.items[0]).toMatchObject({ id: show.id, episodeCount: 2, playedCount: 0 });
    const sd = (await get(h, `/api/v1/playback/series/${show.id}`, user.cookie)).json();
    expect(sd.seasons[0].episodes).toHaveLength(2);
    expect(sd.nextUp).toBe(`episode:${episodes[0]!.id}`);

    const marked = await post(h, '/api/v1/playback/watched', { itemKeys: [`episode:${episodes[0]!.id}`], played: true }, user.cookie);
    expect(marked.json()).toEqual({ updated: 1 });
    expect((await get(h, `/api/v1/playback/series/${show.id}`, user.cookie)).json()).toMatchObject({ playedCount: 1, nextUp: `episode:${episodes[1]!.id}` });
    const home = (await get(h, '/api/v1/playback/video/home', user.cookie)).json();
    expect(home.recentMovies.length).toBe(2);
    expect(home.nextUp.map((c: { itemKey: string }) => c.itemKey)).toEqual([`episode:${episodes[1]!.id}`]);
    expect(home.genres).toEqual(expect.arrayContaining(['Action', 'Comedy', 'Drama']));
    expect((await post(h, '/api/v1/playback/watched', { seriesId: show.id, played: true }, user.cookie)).json()).toEqual({ updated: 2 });

    const search = (await get(h, '/api/v1/playback/search?q=alp', user.cookie)).json();
    expect(search.movies.map((m: { title: string }) => m.title)).toEqual(['Alpha']);
    expect((await get(h, '/api/v1/playback/search?q=test', user.cookie)).json().series.map((s: { id: number }) => s.id)).toEqual([show.id]);
    // Video progress stays out of the audio "continue" row.
    await h.app.inject({ method: 'PUT', url: `/api/v1/playback/progress/movie:${movie.id}`, headers: { cookie: user.cookie }, payload: { event: 'progress', positionMs: 60_000, durationMs: 600_000, deviceId: 'test', clientTime: NOW } });
    expect((await get(h, '/api/v1/playback/continue', user.cookie)).json().items).toEqual([]);
    expect((await get(h, '/api/v1/playback/video/home', user.cookie)).json().continueWatching.map((c: { itemKey: string }) => c.itemKey)).toEqual([`movie:${movie.id}`]);
  });

  it('restrictions apply to lists and search', async () => {
    const h = await harness();
    addMovie(h.db, { title: 'Kids', tmdbId: 12, certification: 'G', files: [{ name: 'a.mp4', info: H264_AAC }] });
    addMovie(h.db, { title: 'Adults', tmdbId: 13, certification: 'R', files: [{ name: 'a.mp4', info: H264_AAC }] });
    const kid = await signIn(h, { restrictions: { maxCertification: { movie: 'PG', tv: null } } });
    expect((await get(h, '/api/v1/playback/movies', kid.cookie)).json().items.map((m: { title: string }) => m.title)).toEqual(['Kids']);
    expect((await get(h, '/api/v1/playback/search?q=adults', kid.cookie)).json().movies).toEqual([]);
  });

  it('non-player users are turned away', async () => {
    const h = await harness();
    const nope = await signIn(h, { allowed: false });
    expect((await get(h, '/api/v1/playback/movies', nope.cookie)).statusCode).toBe(403);
    expect((await session(h, nope.cookie, { itemKey: 'movie:1' })).statusCode).toBe(403);
  });
});

// ---- real ffmpeg --------------------------------------------------------------------------------

function make(args: string[]) {
  execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}
function probe(path: string): MediaInfo {
  return parseFfprobeOutput(execFileSync(ffprobe!, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]).toString());
}

describe('with a real ffmpeg', () => {
  it.skipIf(!ffmpeg || !ffprobe)('remuxes an MKV to fragmented MP4, transcodes it, and extracts an embedded SRT', { timeout: 120_000 }, async () => {
    const dir = join(tmp, 'real');
    mkdirSync(dir, { recursive: true });
    const srt = join(dir, 'in.srt');
    writeFileSync(srt, '1\n00:00:00,500 --> 00:00:01,500\nHello there\n');
    const mkv = join(dir, 'film.mkv');
    make(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-i', srt, '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-c:s', 'srt', '-metadata:s:s:0', 'language=eng', mkv]);
    const h = await harness({ real: true });
    const user = await signIn(h);
    const { movie } = addMovie(h.db, { title: 'Real', tmdbId: 20, files: [{ name: 'film.mkv', info: probe(mkv), path: mkv }] });
    const s = (await session(h, user.cookie, { itemKey: `movie:${movie.id}` })).json();
    expect(s).toMatchObject({ method: 'remux', reasons: ['container', 'audio-codec'] });
    const remux = await get(h, pathOf(s.url));
    expect(remux.statusCode).toBe(200);
    expect(remux.rawPayload.subarray(4, 8).toString()).toBe('ftyp');
    const out = join(dir, 'remux.mp4');
    writeFileSync(out, remux.rawPayload);
    const info = probe(out);
    expect(info.videoFormat).toBe('h264');
    expect(info.audioStreams?.[0]?.codec).toBe('aac');

    // A TV that plays AC-3: the audio is copied into the fragmented MP4 (needs delay_moov).
    const tv = { containers: ['mp4'], videoCodecs: ['h264'], audioCodecs: ['aac', 'ac3'], maxAudioChannels: 6, maxHeight: 1080 };
    const copy = (await post(h, '/api/v1/playback/video/session', { itemKey: `movie:${movie.id}`, profile: tv }, user.cookie)).json();
    expect(copy).toMatchObject({ method: 'remux', reasons: ['container'] });
    const copyOut = join(dir, 'copy.mp4');
    writeFileSync(copyOut, (await get(h, pathOf(copy.url))).rawPayload);
    expect(probe(copyOut).audioStreams?.[0]?.codec).toBe('ac3');

    const tx = (await session(h, user.cookie, { itemKey: `movie:${movie.id}`, quality: '480p', profile: { ...BROWSER, maxHeight: 180 } })).json();
    expect(tx.method).toBe('transcode');
    const txBody = await get(h, pathOf(tx.url));
    const txOut = join(dir, 'tx.mp4');
    writeFileSync(txOut, txBody.rawPayload);
    expect(probe(txOut).height).toBeLessThanOrEqual(180);

    const vtt = await get(h, pathOf(s.subtitles[0].url));
    expect(vtt.statusCode).toBe(200);
    expect(vtt.body).toContain('WEBVTT');
    expect(vtt.body).toContain('Hello there');
    expect(vtt.body).toContain('00:00:00.500');
  });
});
