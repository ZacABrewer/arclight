import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QUALITIES, type PlayableItem, type QualityModel } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor, SESSION_COOKIE } from '../auth/index.js';
import { locateFfmpeg } from '../transcode/runner.js';
import { setSection } from '../settings/service.js';
import { audioTranscoderFor } from './index.js';
import type { RunningTranscode } from './transcode.js';

// The player over HTTP: the access guard, the stream (ranges, signed links, transcodes with a
// fake ffmpeg), items and the audiobook timeline, progress, queue, bookmarks, playlists and
// browse. Files are small byte blobs in a temp folder; nothing leaves the machine.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };
const NOW = '2026-05-01T12:00:00.000Z';
const REMOTE = '203.0.113.9';
const quality = (): QualityModel => ({ quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: [...QUALITIES['Bluray-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });

const ffmpeg = await locateFfmpeg();
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'arclight-player-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
  launches: string[][];
}
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.app.close();
});

async function harness(): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  const launches: string[][] = [];
  let ctx: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (c) => {
      ctx = c;
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
  setSection(db, 'features', { music: true, audiobooks: true, podcasts: false });
  setSection(db, 'player', { enabled: true });
  const h = { app, ctx: ctx!, db, launches };
  open.push(h);
  return h;
}

async function signIn(h: Harness, opts: { player?: unknown; role?: 'user' | 'admin' } = {}): Promise<{ cookie: string; id: number }> {
  const auth = authServiceFor(h.ctx);
  const user = await auth.createUser({
    username: `u${Math.random().toString(36).slice(2, 8)}`,
    password: 'password1',
    role: opts.role ?? 'user',
    ...(opts.player === undefined ? {} : { settings: { player: opts.player } }),
  });
  return { cookie: `${SESSION_COOKIE}=${auth.createSession(user.id).token}`, id: user.id };
}

const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

function file(name: string): string {
  const path = join(tmp, `${Math.random().toString(36).slice(2, 8)}-${name}`);
  writeFileSync(path, BYTES);
  return path;
}

/** One artist, one album with two tracks (FLAC 16/44.1), one book in three parts. */
function seed(db: Db, opts: { bitrateKbps?: number; bookChapters?: Array<{ title: string; startMs: number }>; embedded?: boolean } = {}) {
  const type = db.insert(schema.albumTypeProfiles).values({ name: 'Studio', primaryTypes: ['Album'], secondaryTypes: [], releaseStatuses: ['Official'] }).returning().get();
  const artist = db
    .insert(schema.artists)
    .values({ mbArtistId: 'a1', name: 'The Testers', sortName: 'Testers, The', cleanName: 'testers', genres: ['Rock'], images: [], links: [], aliases: [], path: join(tmp, 'Testers'), rootFolderPath: tmp, qualityProfileId: 1, albumTypeProfileId: type.id, tags: [], added: NOW })
    .returning()
    .get();
  const album = db
    .insert(schema.albums)
    .values({ artistId: artist.id, mbReleaseGroupId: 'rg1', title: 'Sample Record', cleanTitle: 'samplerecord', primaryType: 'Album', secondaryTypes: [], genres: ['Rock'], images: [], ratings: {}, added: NOW, year: 2020, releaseDate: '2020-05-01' })
    .returning()
    .get();
  const release = db.insert(schema.albumReleases).values({ albumId: album.id, mbReleaseId: 'r1', title: 'Sample Record', labels: [], formats: [], media: [] }).returning().get();
  const trackIds = [1, 2].map((n) => {
    const f = db
      .insert(schema.audioFiles)
      .values({
        mediaType: 'music',
        artistId: artist.id,
        albumId: album.id,
        path: file(`0${n}.flac`),
        relativePath: `0${n}.flac`,
        sizeBytes: BYTES.length,
        dateAdded: NOW,
        quality: quality(),
        codec: 'FLAC',
        bitrateKbps: opts.bitrateKbps ?? 900,
        sampleRateHz: 44_100,
        bitDepth: 16,
        channels: 2,
        trackNumber: n,
        discNumber: 1,
        durationMs: 200_000,
        mediaInfo: { replayGainTrackDb: -6.5 },
      })
      .returning()
      .get();
    return db.insert(schema.tracks).values({ albumId: album.id, albumReleaseId: release.id, absoluteNumber: n, trackNumber: n, title: `Song ${n}`, durationMs: 200_000, hasFile: true, audioFileId: f.id }).returning().get().id;
  });
  // A track without a file never shows up.
  db.insert(schema.tracks).values({ albumId: album.id, albumReleaseId: release.id, absoluteNumber: 3, trackNumber: 3, title: 'Missing Song', hasFile: false }).run();
  const author = db
    .insert(schema.authors)
    .values({ name: 'A. Writer', sortName: 'Writer, A.', cleanName: 'awriter', images: [], genres: [], aliases: [], path: join(tmp, 'Writer'), rootFolderPath: tmp, qualityProfileId: 1, languages: [], tags: [], added: NOW })
    .returning()
    .get();
  const book = db
    .insert(schema.books)
    .values({ authorId: author.id, title: 'Long Story', sortTitle: 'Long Story', cleanTitle: 'longstory', authorCredits: [{ name: 'A. Writer' }], narrators: ['N. Reader'], genres: [], images: [], chapters: opts.bookChapters ?? [], ratings: {}, hasFile: true, added: NOW })
    .returning()
    .get();
  const series = db.insert(schema.bookSeries).values({ name: 'The Saga', cleanName: 'thesaga' }).returning().get();
  db.insert(schema.bookSeriesEntries).values({ seriesId: series.id, bookId: book.id, position: '2', positionSort: 2, isPrimary: true }).run();
  // Inserted out of order on purpose: the timeline sorts by part number.
  const partIds = [3, 1, 2].map(
    (n) =>
      db
        .insert(schema.audioFiles)
        .values({
          mediaType: 'audiobook',
          authorId: author.id,
          bookId: book.id,
          path: file(`part${n}.mp3`),
          relativePath: `Long Story/Part ${n}.mp3`,
          sizeBytes: BYTES.length,
          dateAdded: NOW,
          quality: quality(),
          codec: 'MPEG 1 Layer 3',
          bitrateKbps: 64,
          partNumber: n,
          durationMs: n * 60_000,
          tags: { title: `Part ${n}` },
          ...(opts.embedded ? { mediaInfo: { chapters: [{ title: `P${n} start`, startMs: 0 }, { title: `P${n} middle`, startMs: 30_000 }] } } : {}),
        })
        .returning()
        .get().id,
  );
  return { artist, album, trackIds, book, partIds };
}

const get = (h: Harness, url: string, cookie?: string, extra: Record<string, string> = {}, remoteAddress?: string) =>
  h.app.inject({ method: 'GET', url, headers: { ...(cookie ? { cookie } : {}), ...extra }, ...(remoteAddress ? { remoteAddress } : {}) });

describe('access guard', () => {
  it('reports capabilities and refuses player routes while disabled, not allowed or remote', async () => {
    const h = await harness();
    const { trackIds } = seed(h.db);
    const url = `/api/v1/playback/item/track:${trackIds[0]}`;
    const allowed = await signIn(h, { player: { allowed: true } });
    const denied = await signIn(h);
    const admin = await signIn(h, { role: 'admin' });

    expect((await get(h, url, allowed.cookie)).statusCode).toBe(200);
    expect((await get(h, url, admin.cookie)).statusCode).toBe(200);
    const notAllowed = await get(h, url, denied.cookie);
    expect([notAllowed.statusCode, notAllowed.json().code]).toEqual([403, 'PLAYER_NOT_ALLOWED']);
    expect((await get(h, '/api/v1/playback/me', denied.cookie)).json()).toMatchObject({ enabled: true, allowed: false, canStream: false });

    const remote = await get(h, url, allowed.cookie, {}, REMOTE);
    expect([remote.statusCode, remote.json().code]).toEqual([403, 'REMOTE_NOT_ALLOWED']);
    expect((await get(h, '/api/v1/playback/me', allowed.cookie, {}, REMOTE)).json()).toMatchObject({ remote: true, allowed: true, canStream: false, maxBitrateKbps: 320 });
    setSection(h.db, 'player', { enabled: true, allowRemote: true });
    expect((await get(h, url, allowed.cookie, {}, REMOTE)).statusCode).toBe(200);

    setSection(h.db, 'player', { enabled: false });
    const off = await get(h, url, admin.cookie);
    expect([off.statusCode, off.json().code]).toEqual([403, 'PLAYER_DISABLED']);
    expect((await get(h, '/api/v1/playback/me', admin.cookie)).json()).toEqual({
      enabled: false,
      allowed: false,
      remote: false,
      canStream: false,
      maxBitrateKbps: 0,
      engine: 'arclight',
      sections: { music: false, audiobooks: false, podcasts: false, books: false, video: false },
    });
  });

  it('sections follow the feature flags; API-key callers have no per-user state', async () => {
    const h = await harness();
    const admin = await signIn(h, { role: 'admin' });
    setSection(h.db, 'features', { music: true, audiobooks: false, podcasts: false });
    expect((await get(h, '/api/v1/playback/me', admin.cookie)).json().sections).toEqual({ music: true, audiobooks: false, podcasts: false, books: false, video: true });
    expect((await get(h, '/api/v1/playback/audiobooks/home', admin.cookie)).json().code).toBe('SECTION_OFF');
    const key = authServiceFor(h.ctx).apiKey();
    expect((await get(h, '/api/v1/playback/music/albums', undefined, { 'x-api-key': key })).statusCode).toBe(200);
    expect((await get(h, '/api/v1/playback/queue', undefined, { 'x-api-key': key })).json().code).toBe('NO_USER');
  });

  it('admins manage player access through the user route; users cannot set it themselves', async () => {
    const h = await harness();
    const admin = await signIn(h, { role: 'admin' });
    const user = await signIn(h);
    const put = (url: string, cookie: string, payload: unknown) => h.app.inject({ method: 'PUT', url, headers: { cookie }, payload: payload as object });
    expect((await put(`/api/v1/user/${user.id}`, admin.cookie, { settings: { player: { allowed: 'yes' } } })).statusCode).toBe(400);
    expect((await put(`/api/v1/user/${user.id}`, admin.cookie, { settings: { player: { allowed: true } } })).statusCode).toBe(200);
    const stored = h.db.select().from(schema.users).all().find((u) => u.id === user.id)!;
    expect((stored.settings as Record<string, unknown>)['player']).toEqual({ allowed: true, allowRemote: true, maxBitrateKbps: 0 });
    await put('/api/v1/user/me', user.cookie, { settings: { player: { allowed: false } } });
    const after = h.db.select().from(schema.users).all().find((u) => u.id === user.id)!;
    expect((after.settings as Record<string, unknown>)['player']).toMatchObject({ allowed: true });
  });

  it('users cannot point their media-server link at another account through PUT /user/me', async () => {
    const h = await harness();
    const { book } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const key = `audiobook:${book.id}`;
    setSection(h.db, 'mediaServers', { servers: [{ id: 'jf1', kind: 'jellyfin', name: 'Media', url: 'http://media.invalid', apiKey: 'k' }] });
    const victim = h.db.insert(schema.mediaServerUsers).values({ serverId: 'jf1', externalId: 'victim1', name: 'someone', firstSeenAt: NOW, updatedAt: NOW }).returning().get();
    h.db
      .insert(schema.watchState)
      .values({ serverId: 'jf1', mediaServerUserId: victim.id, jellyfinItemId: 'x1', itemType: 'other', itemKey: key, title: 'Long Story', positionMs: 42_000, updatedAt: new Date().toISOString() })
      .run();
    const res = await h.app.inject({ method: 'PUT', url: '/api/v1/user/me', headers: { cookie: user.cookie }, payload: { settings: { mediaServerLink: { kind: 'jellyfin', externalId: 'victim1' }, theme: 'light' } } });
    expect(res.statusCode).toBe(200);
    const stored = h.db.select().from(schema.users).all().find((u) => u.id === user.id)!.settings as Record<string, unknown>;
    expect(stored['mediaServerLink']).toBeUndefined();
    expect(stored['theme']).toBe('light');
    expect((await get(h, `/api/v1/playback/progress?itemKeys=${key}`, user.cookie)).json().items).toEqual([]);
    // A link stored by the link routes (patchUserSettings) survives a later PUT /user/me.
    const { patchUserSettings } = await import('../requests/users.js');
    patchUserSettings(h.db, user.id, { mediaServerLink: { kind: 'jellyfin', externalId: 'mine' } }, NOW);
    await h.app.inject({ method: 'PUT', url: '/api/v1/user/me', headers: { cookie: user.cookie }, payload: { settings: { mediaServerLink: { kind: 'jellyfin', externalId: 'victim1' } } } });
    const after = h.db.select().from(schema.users).all().find((u) => u.id === user.id)!.settings as Record<string, unknown>;
    expect(after['mediaServerLink']).toEqual({ kind: 'jellyfin', externalId: 'mine' });
  });

  it('item, stream and artwork routes 404 while their section is off', async () => {
    const h = await harness();
    const { trackIds, book, album, partIds } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const musicFile = h.db.select().from(schema.audioFiles).all().find((f) => f.albumId === album.id)!.id;
    setSection(h.db, 'features', { music: false, audiobooks: true, podcasts: false });
    expect((await get(h, `/api/v1/playback/item/track:${trackIds[0]}`, user.cookie)).statusCode).toBe(404);
    expect((await get(h, `/api/v1/stream/audio/${musicFile}`, user.cookie)).statusCode).toBe(404);
    expect((await get(h, `/api/v1/playback/artwork/album/${album.id}`, user.cookie)).statusCode).toBe(404);
    const links = await h.app.inject({ method: 'POST', url: '/api/v1/playback/stream-links', headers: { cookie: user.cookie }, payload: { itemKey: `track:${trackIds[0]}` } });
    expect(links.statusCode).toBe(404);
    expect((await get(h, `/api/v1/playback/item/audiobook:${book.id}`, user.cookie)).statusCode).toBe(200);
    expect((await get(h, `/api/v1/stream/audio/${partIds[0]}`, user.cookie)).statusCode).toBe(200);
    setSection(h.db, 'features', { music: true, audiobooks: false, podcasts: false });
    expect((await get(h, `/api/v1/playback/item/audiobook:${book.id}`, user.cookie)).statusCode).toBe(404);
    expect((await get(h, `/api/v1/stream/audio/${partIds[0]}`, user.cookie)).statusCode).toBe(404);
    expect((await get(h, `/api/v1/stream/audio/${musicFile}`, user.cookie)).statusCode).toBe(200);
  });

  it('player settings are admin only', async () => {
    const h = await harness();
    const user = await signIn(h, { player: { allowed: true } });
    const admin = await signIn(h, { role: 'admin' });
    expect((await get(h, '/api/v1/settings/player', user.cookie)).statusCode).toBe(403);
    const saved = await h.app.inject({ method: 'PUT', url: '/api/v1/settings/player', headers: { cookie: admin.cookie }, payload: { enabled: true, allowRemote: true, remoteMaxBitrateKbps: 256, streamLinkHours: 2 } });
    expect(saved.json()).toEqual({ enabled: true, allowRemote: true, remoteMaxBitrateKbps: 256, streamLinkHours: 2, backend: 'arclight', jellyfinServerId: null, video: true, videoMaxStreams: 3, videoMaxStreamsPerUser: 1, trickplay: 'on-play', segmentDetection: true, segmentDetectionRecaps: true });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/settings/player/engine-test', headers: { cookie: user.cookie }, payload: {} })).statusCode).toBe(403);
  });
});

describe('stream', () => {
  it('serves the original with ranges, validators and HEAD', async () => {
    const h = await harness();
    const { album } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const fileId = h.db.select().from(schema.audioFiles).all().find((f) => f.albumId === album.id)!.id;
    const url = `/api/v1/stream/audio/${fileId}`;

    const full = await get(h, url, user.cookie);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('audio/flac');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-length']).toBe('1000');
    expect(full.rawPayload.equals(BYTES)).toBe(true);
    const etag = full.headers['etag'] as string;
    expect(etag).toMatch(/^"/);
    expect(full.headers['last-modified']).toBeTruthy();

    const part = await get(h, url, user.cookie, { range: 'bytes=10-19' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 10-19/1000');
    expect(part.rawPayload.equals(BYTES.subarray(10, 20))).toBe(true);

    const suffix = await get(h, url, user.cookie, { range: 'bytes=-5' });
    expect([suffix.statusCode, suffix.headers['content-range']]).toEqual([206, 'bytes 995-999/1000']);
    expect(suffix.rawPayload.equals(BYTES.subarray(995))).toBe(true);

    const bad = await get(h, url, user.cookie, { range: 'bytes=5000-' });
    expect([bad.statusCode, bad.headers['content-range']]).toEqual([416, 'bytes */1000']);

    expect((await get(h, url, user.cookie, { 'if-none-match': etag })).statusCode).toBe(304);
    // If-Range with a stale validator: the whole file.
    expect((await get(h, url, user.cookie, { range: 'bytes=0-9', 'if-range': '"stale"' })).statusCode).toBe(200);

    const head = await h.app.inject({ method: 'HEAD', url, headers: { cookie: user.cookie, range: 'bytes=0-99' } });
    expect([head.statusCode, head.headers['content-range'], head.headers['content-length'], head.rawPayload.length]).toEqual([206, 'bytes 0-99/1000', '100', 0]);

    expect((await get(h, '/api/v1/stream/audio/99999', user.cookie)).statusCode).toBe(404);
    expect((await get(h, url)).statusCode).toBe(401);
  });

  it('transcodes on request and on its own over the remote cap', async () => {
    const h = await harness();
    const { album } = seed(h.db, { bitrateKbps: 900 });
    const user = await signIn(h, { player: { allowed: true } });
    const fileId = h.db.select().from(schema.audioFiles).all().find((f) => f.albumId === album.id)!.id;

    const asked = await get(h, `/api/v1/stream/audio/${fileId}?format=mp3&bitrateKbps=128&startMs=1500`, user.cookie);
    expect([asked.statusCode, asked.headers['content-type'], asked.body]).toEqual([200, 'audio/mpeg', 'ENCODED']);
    expect(h.launches[0]).toEqual(expect.arrayContaining(['-ss', '1.500', '-c:a', 'libmp3lame', '-b:a', '128k']));
    // HEAD (the player's probe after a failed stream) answers without starting ffmpeg.
    const probe = await h.app.inject({ method: 'HEAD', url: `/api/v1/stream/audio/${fileId}?format=mp3`, headers: { cookie: user.cookie } });
    expect([probe.statusCode, h.launches.length]).toEqual([200, 1]);

    // Local: no cap, the original.
    expect((await get(h, `/api/v1/stream/audio/${fileId}`, user.cookie)).headers['content-type']).toBe('audio/flac');
    setSection(h.db, 'player', { enabled: true, allowRemote: true, remoteMaxBitrateKbps: 320 });
    const remote = await get(h, `/api/v1/stream/audio/${fileId}`, user.cookie, {}, REMOTE);
    expect([remote.headers['content-type'], remote.headers['x-arclight-transcode']]).toEqual(['audio/ogg', 'opus/320']);
    // An asked-for bitrate above the cap is clamped.
    const clamped = await get(h, `/api/v1/stream/audio/${fileId}?format=aac&bitrateKbps=512`, user.cookie, {}, REMOTE);
    expect(clamped.headers['x-arclight-transcode']).toBe('aac/320');
  });

  it('signed links: valid, expired, tampered, wrong file, revoked, access lost', async () => {
    const h = await harness();
    const { book, album } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/playback/stream-links', headers: { cookie: user.cookie }, payload: { itemKey: `audiobook:${book.id}` } });
    const links = res.json().links as Array<{ fileId: number; url: string; expiresAt: string }>;
    expect(links).toHaveLength(3);
    const path = (u: string) => {
      const p = new URL(u);
      return p.pathname + p.search;
    };
    const first = path(links[0]!.url);
    expect((await get(h, first)).statusCode).toBe(200);
    expect((await get(h, first, undefined, { range: 'bytes=0-0' })).statusCode).toBe(206);

    const tampered = first.replace(/sig=([A-Za-z0-9_-])/, (_m, c: string) => `sig=${c === 'A' ? 'B' : 'A'}`);
    expect((await get(h, tampered)).json().code).toBe('LINK_BAD_SIGNATURE');
    const otherFile = h.db.select().from(schema.audioFiles).all().find((f) => f.albumId === album.id)!.id;
    expect((await get(h, first.replace(`/audio/${links[0]!.fileId}?`, `/audio/${otherFile}?`))).json().code).toBe('LINK_BAD_SIGNATURE');
    const expired = first.replace(/exp=\d+/, 'exp=1000');
    expect((await get(h, expired)).statusCode).toBe(403);

    // Access taken away: the link stops working.
    await h.app.inject({ method: 'PUT', url: `/api/v1/user/${user.id}`, headers: { cookie: (await signIn(h, { role: 'admin' })).cookie }, payload: { settings: { player: { allowed: false } } } });
    expect((await get(h, first)).json().code).toBe('PLAYER_NOT_ALLOWED');
    await h.app.inject({ method: 'PUT', url: `/api/v1/user/${user.id}`, headers: { cookie: (await signIn(h, { role: 'admin' })).cookie }, payload: { settings: { player: { allowed: true } } } });
    expect((await get(h, first)).statusCode).toBe(200);
    // Every session ended: so are the links.
    authServiceFor(h.ctx).revokeAllSessions(user.id);
    expect((await get(h, first)).json().code).toBe('LINK_REVOKED');
  });

  it.skipIf(!ffmpeg)('live ffmpeg transcode (needs ffmpeg on PATH)', async () => {
    // Runs only where ffmpeg is installed; the fake launcher covers the route everywhere else.
    const { AudioTranscoder } = await import('./transcode.js');
    const { buildWav } = await import('../imports/audio/fixtures/builders.js');
    const path = join(tmp, 'tone.wav');
    writeFileSync(path, buildWav({ durationMs: 1000 }));
    const proc = await new AudioTranscoder().start(path, { format: 'mp3', bitrateKbps: 128 });
    const chunks: Buffer[] = [];
    for await (const c of proc.stdout) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).length).toBeGreaterThan(100);
  });
});

describe('items', () => {
  it('a track is its one file', async () => {
    const h = await harness();
    const { trackIds, album, artist } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const item = (await get(h, `/api/v1/playback/item/track:${trackIds[0]}`, user.cookie)).json() as PlayableItem;
    expect(item).toMatchObject({ kind: 'track', title: 'Song 1', subtitle: 'The Testers', context: 'Sample Record', albumId: album.id, artistId: artist.id, durationMs: 200_000, chapters: [] });
    expect(item.parts).toHaveLength(1);
    expect(item.parts[0]).toMatchObject({ startMs: 0, mimeType: 'audio/flac', bitDepth: 16 });
    expect(item.replayGain).toEqual({ trackGainDb: -6.5, albumGainDb: null });
    expect(item.artworkUrl).toBe(`/api/v1/playback/artwork/album/${album.id}`);
    expect((await get(h, '/api/v1/playback/item/track:99999', user.cookie)).statusCode).toBe(404);
    expect((await get(h, '/api/v1/playback/item/movie:1', user.cookie)).statusCode).toBe(404);
    expect((await get(h, '/api/v1/playback/item/bogus:1', user.cookie)).statusCode).toBe(400);
  });

  it('an audiobook is every file on one timeline; chapters fall back to one per file', async () => {
    const h = await harness();
    const { book, partIds } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const item = (await get(h, `/api/v1/playback/item/audiobook:${book.id}`, user.cookie)).json() as PlayableItem;
    expect(item.parts.map((p) => [p.fileId, p.startMs, p.durationMs])).toEqual([
      [partIds[1], 0, 60_000],
      [partIds[2], 60_000, 120_000],
      [partIds[0], 180_000, 180_000],
    ]);
    expect(item.durationMs).toBe(360_000);
    expect(item.subtitle).toBe('A. Writer');
    expect(item.context).toBe('The Saga, book 2');
    expect(item.chapters).toEqual([
      { title: 'Part 1', startMs: 0, durationMs: 60_000 },
      { title: 'Part 2', startMs: 60_000, durationMs: 120_000 },
      { title: 'Part 3', startMs: 180_000, durationMs: 180_000 },
    ]);
  });

  it('embedded chapters are offset by each file; stored book chapters win', async () => {
    const h = await harness();
    const embedded = seed(h.db, { embedded: true });
    const user = await signIn(h, { player: { allowed: true } });
    const item = (await get(h, `/api/v1/playback/item/audiobook:${embedded.book.id}`, user.cookie)).json() as PlayableItem;
    expect(item.chapters.map((c) => [c.title, c.startMs, c.durationMs])).toEqual([
      ['P1 start', 0, 30_000],
      ['P1 middle', 30_000, 30_000],
      ['P2 start', 60_000, 30_000],
      ['P2 middle', 90_000, 90_000],
      ['P3 start', 180_000, 30_000],
      ['P3 middle', 210_000, 150_000],
    ]);

    const h2 = await harness();
    const stored = seed(h2.db, { bookChapters: [{ title: 'Opening', startMs: 0 }, { title: 'Close', startMs: 300_000 }], embedded: true });
    const user2 = await signIn(h2, { player: { allowed: true } });
    const item2 = (await get(h2, `/api/v1/playback/item/audiobook:${stored.book.id}`, user2.cookie)).json() as PlayableItem;
    expect(item2.chapters).toEqual([
      { title: 'Opening', startMs: 0, durationMs: 300_000 },
      { title: 'Close', startMs: 300_000, durationMs: 60_000 },
    ]);
  });
});

describe('progress', () => {
  const report = (positionMs: number, clientTime: string, event = 'progress') => ({ event, positionMs, durationMs: 200_000, deviceId: 'dev-1', clientTime });

  it('stores reports, ignores stale ones and counts a play at the threshold', async () => {
    const h = await harness();
    const { trackIds } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const key = `track:${trackIds[0]}`;
    const put = (body: unknown) => h.app.inject({ method: 'PUT', url: `/api/v1/playback/progress/${key}`, headers: { cookie: user.cookie }, payload: body as object });
    const t = (s: number) => new Date(Date.now() - 600_000 + s * 1000).toISOString();

    expect((await put(report(50_000, t(10)))).json()).toMatchObject({ positionMs: 50_000, played: false, source: 'arclight' });
    expect((await put(report(10_000, t(5)))).json()).toMatchObject({ positionMs: 50_000 });
    expect((await put(report(190_000, t(20)))).json()).toMatchObject({ played: true, playCount: 1 });
    expect((await put(report(199_000, t(30), 'stop'))).json()).toMatchObject({ played: true, playCount: 1 });
    expect(h.db.select().from(schema.playbackPlays).all()).toHaveLength(1);

    const patched = await h.app.inject({ method: 'PATCH', url: `/api/v1/playback/progress/${key}`, headers: { cookie: user.cookie }, payload: { favorite: true, played: false } });
    expect(patched.json()).toMatchObject({ favorite: true, played: false, positionMs: 0, playCount: 1 });

    const list = await get(h, `/api/v1/playback/progress?itemKeys=${key},track:${trackIds[1]}`, user.cookie);
    expect(list.json().items).toHaveLength(1);
    expect((await get(h, '/api/v1/playback/progress?itemKeys=movie:1', user.cookie)).statusCode).toBe(200);
    expect((await get(h, '/api/v1/playback/progress?itemKeys=bogus:1', user.cookie)).statusCode).toBe(400);
  });

  it('a favourite or speed PATCH does not make the next reports look stale', async () => {
    const h = await harness();
    const { trackIds } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const key = `track:${trackIds[0]}`;
    const put = (body: unknown) => h.app.inject({ method: 'PUT', url: `/api/v1/playback/progress/${key}`, headers: { cookie: user.cookie }, payload: body as object });
    const patch = (body: unknown) => h.app.inject({ method: 'PATCH', url: `/api/v1/playback/progress/${key}`, headers: { cookie: user.cookie }, payload: body as object });
    // The device clock runs a little behind the server.
    const behind = (s: number) => new Date(Date.now() - 30_000 + s * 1000).toISOString();
    // A PATCH before any report.
    await patch({ favorite: true });
    expect((await put(report(20_000, behind(1)))).json()).toMatchObject({ positionMs: 20_000, favorite: true });
    await patch({ prefs: { speed: 1.5 } });
    expect((await put(report(30_000, behind(2)))).json()).toMatchObject({ positionMs: 30_000, prefs: { speed: 1.5 } });
    // Marking played still orders: an older report cannot undo it.
    await patch({ played: true });
    expect((await put(report(40_000, behind(3)))).json()).toMatchObject({ played: true });
  });

  it('accepts sendBeacon posts (text/plain JSON)', async () => {
    const h = await harness();
    const { book } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const key = `audiobook:${book.id}`;
    const beacon = await h.app.inject({
      method: 'POST',
      url: '/api/v1/playback/progress/beacon',
      headers: { cookie: user.cookie, 'content-type': 'text/plain;charset=UTF-8' },
      payload: JSON.stringify({ itemKey: key, ...report(120_000, new Date().toISOString(), 'stop'), durationMs: 360_000, speed: 1.25 }),
    });
    expect(beacon.statusCode).toBe(204);
    const bad = await h.app.inject({ method: 'POST', url: '/api/v1/playback/progress/beacon', headers: { cookie: user.cookie, 'content-type': 'text/plain' }, payload: 'not json' });
    expect(bad.statusCode).toBe(400);
    expect((await get(h, `/api/v1/playback/progress?itemKeys=${key}`, user.cookie)).json().items[0]).toMatchObject({ positionMs: 120_000, prefs: { speed: 1.25 } });
    // Other routes do not parse text/plain as JSON.
    const plain = await h.app.inject({ method: 'PUT', url: `/api/v1/playback/progress/${key}`, headers: { cookie: user.cookie, 'content-type': 'text/plain' }, payload: '{}' });
    expect(plain.statusCode).toBe(400);

    const cont = (await get(h, '/api/v1/playback/continue', user.cookie)).json();
    expect(cont.items).toHaveLength(1);
    expect(cont.items[0].item.itemKey).toBe(key);
    const home = (await get(h, '/api/v1/playback/audiobooks/home', user.cookie)).json();
    expect(home.continueListening.map((b: { id: number }) => b.id)).toEqual([book.id]);
    expect(home.series[0]).toMatchObject({ title: 'The Saga' });
  });

  it('merges a linked media-server account (newest wins)', async () => {
    const h = await harness();
    const { book } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const key = `audiobook:${book.id}`;
    setSection(h.db, 'mediaServers', { servers: [{ id: 'jf1', kind: 'jellyfin', name: 'Media', url: 'http://media.invalid', apiKey: 'k' }] });
    const account = h.db.insert(schema.mediaServerUsers).values({ serverId: 'jf1', externalId: 'abc123', name: 'listener', firstSeenAt: NOW, updatedAt: NOW }).returning().get();
    const stored = h.db.select().from(schema.users).all().find((u) => u.id === user.id)!;
    h.db
      .update(schema.users)
      .set({ settings: { ...(stored.settings as object), mediaServerLink: { kind: 'jellyfin', externalId: 'ABC-123' } } })
      .where((await import('drizzle-orm')).eq(schema.users.id, user.id))
      .run();
    await h.app.inject({ method: 'PUT', url: `/api/v1/playback/progress/${key}`, headers: { cookie: user.cookie }, payload: report(10_000, new Date(Date.now() - 3_600_000).toISOString()) });
    h.db
      .insert(schema.watchState)
      .values({ serverId: 'jf1', mediaServerUserId: account.id, jellyfinItemId: 'x1', itemType: 'other', itemKey: key, title: 'Long Story', positionMs: 99_000, updatedAt: new Date().toISOString() })
      .run();
    expect((await get(h, `/api/v1/playback/progress?itemKeys=${key}`, user.cookie)).json().items[0]).toMatchObject({ positionMs: 99_000, source: 'jellyfin' });
  });
});

describe('queue, bookmarks and playlists', () => {
  it('queue: last write wins by updatedAt', async () => {
    const h = await harness();
    const { trackIds } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const put = (body: object) => h.app.inject({ method: 'PUT', url: '/api/v1/playback/queue', headers: { cookie: user.cookie }, payload: body });
    const q = { items: trackIds.map((id) => `track:${id}`), index: 1, positionMs: 5000, shuffle: false, order: null, repeat: 'all', source: 'album:1' };
    expect((await get(h, '/api/v1/playback/queue', user.cookie)).json()).toMatchObject({ items: [], index: 0 });
    const saved = (await put({ ...q, updatedAt: new Date(Date.now() - 1000).toISOString(), deviceId: 'a' })).json();
    expect(saved).toMatchObject({ index: 1, repeat: 'all', deviceId: 'a' });
    const stale = (await put({ ...q, index: 0, updatedAt: new Date(Date.now() - 60_000).toISOString(), deviceId: 'b' })).json();
    expect(stale).toMatchObject({ index: 1, deviceId: 'a' });
    expect((await put({ ...q, index: 0, deviceId: 'b' })).json()).toMatchObject({ index: 0, deviceId: 'b' });
    expect((await get(h, '/api/v1/playback/queue', user.cookie)).json()).toMatchObject({ index: 0, deviceId: 'b' });
  });

  it('bookmarks belong to their user', async () => {
    const h = await harness();
    const { book } = seed(h.db);
    const a = await signIn(h, { player: { allowed: true } });
    const b = await signIn(h, { player: { allowed: true } });
    const key = `audiobook:${book.id}`;
    const created = await h.app.inject({ method: 'POST', url: '/api/v1/playback/bookmarks', headers: { cookie: a.cookie }, payload: { itemKey: key, positionMs: 1234 } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as number;
    expect(created.json()).toMatchObject({ note: '', positionMs: 1234 });
    const moved = await h.app.inject({ method: 'PUT', url: `/api/v1/playback/bookmarks/${id}`, headers: { cookie: a.cookie }, payload: { note: 'good bit' } });
    expect(moved.json()).toMatchObject({ note: 'good bit', positionMs: 1234 });
    expect((await get(h, `/api/v1/playback/bookmarks?itemKey=${key}`, a.cookie)).json()).toHaveLength(1);
    expect((await get(h, `/api/v1/playback/bookmarks?itemKey=${key}`, b.cookie)).json()).toHaveLength(0);
    expect((await h.app.inject({ method: 'PUT', url: `/api/v1/playback/bookmarks/${id}`, headers: { cookie: b.cookie }, payload: { note: 'x' } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/playback/bookmarks/${id}`, headers: { cookie: b.cookie } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/playback/bookmarks/${id}`, headers: { cookie: a.cookie } })).statusCode).toBe(204);
  });

  it('playlists belong to their owner and keep order and repeats', async () => {
    const h = await harness();
    const { trackIds, album } = seed(h.db);
    const a = await signIn(h, { player: { allowed: true } });
    const b = await signIn(h, { player: { allowed: true } });
    const created = await h.app.inject({ method: 'POST', url: '/api/v1/playback/playlists', headers: { cookie: a.cookie }, payload: { name: 'Mix', trackIds: [trackIds[1], trackIds[0], trackIds[1], 99999] } });
    expect(created.statusCode).toBe(201);
    const pl = created.json();
    expect(pl.tracks.map((t: { id: number }) => t.id)).toEqual([trackIds[1], trackIds[0], trackIds[1]]);
    expect(pl).toMatchObject({ trackCount: 3, durationMs: 600_000, artworkUrls: [`/api/v1/playback/artwork/album/${album.id}`] });
    expect((await get(h, `/api/v1/playback/playlists/${pl.id}`, b.cookie)).statusCode).toBe(404);
    expect((await get(h, '/api/v1/playback/playlists', b.cookie)).json()).toEqual([]);
    const renamed = await h.app.inject({ method: 'PUT', url: `/api/v1/playback/playlists/${pl.id}`, headers: { cookie: a.cookie }, payload: { name: 'Renamed', trackIds: [trackIds[0]] } });
    expect(renamed.json()).toMatchObject({ name: 'Renamed', trackCount: 1 });
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/playback/playlists/${pl.id}`, headers: { cookie: b.cookie } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/playback/playlists/${pl.id}`, headers: { cookie: a.cookie } })).statusCode).toBe(204);
    expect(h.db.select().from(schema.userPlaylistTracks).all()).toHaveLength(0);
    expect((await get(h, '/api/v1/playback/music/home', a.cookie)).json().playlists).toEqual([]);
  });
});

describe('playlist track edits', () => {
  async function setup() {
    const h = await harness();
    const { trackIds } = seed(h.db);
    const missing = h.db.select().from(schema.tracks).all().find((t) => !t.hasFile)!.id;
    const user = await signIn(h, { player: { allowed: true } });
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
      h.app.inject({ method, url: `/api/v1/playback/playlists${url}`, headers: { cookie: user.cookie }, ...(payload ? { payload } : {}) });
    const [t0, t1] = trackIds as [number, number];
    const created = (await call('POST', '', { name: 'Mix', trackIds: [t0, missing, t1] })).json();
    return { h, t0, t1, missing, call, id: created.id as number };
  }

  it('GET reports every track id, file or not, and the entry id of each playable track', async () => {
    const { call, id, t0, t1, missing } = await setup();
    const pl = (await call('GET', `/${id}`)).json();
    expect(pl.trackIds).toEqual([t0, missing, t1]);
    expect(pl.tracks.map((t: { id: number }) => t.id)).toEqual([t0, t1]);
    expect(pl.entryIds).toHaveLength(2);
    expect(pl.trackCount).toBe(2);
  });

  it('adds at the end or at a position, keeping tracks without files', async () => {
    const { call, id, t0, t1, missing } = await setup();
    const appended = (await call('POST', `/${id}/tracks`, { trackIds: [t0] })).json();
    expect(appended.trackIds).toEqual([t0, missing, t1, t0]);
    const inserted = (await call('POST', `/${id}/tracks`, { trackIds: [t1], position: 0 })).json();
    expect(inserted.trackIds).toEqual([t1, t0, missing, t1, t0]);
    expect((await call('POST', `/${id}/tracks`, { trackIds: [] })).statusCode).toBe(400);
  });

  it('removes and moves single entries; edits from a stale view both land', async () => {
    const { call, id, t0, t1, missing } = await setup();
    const first = (await call('GET', `/${id}`)).json().entryIds[0] as number;
    // Two edits made from the same view: neither undoes the other.
    await call('POST', `/${id}/tracks`, { trackIds: [t0] });
    const removed = (await call('DELETE', `/${id}/tracks/${first}`)).json();
    expect(removed.trackIds).toEqual([missing, t1, t0]);
    const [a, b] = removed.entryIds as [number, number];
    const moved = (await call('PATCH', `/${id}/tracks/${b}`, { beforeEntryId: a })).json();
    expect(moved.trackIds).toEqual([missing, t0, t1]);
    expect(moved.entryIds).toEqual([b, a]);
    const back = (await call('PATCH', `/${id}/tracks/${b}`, { afterEntryId: a })).json();
    expect(back.trackIds).toEqual([missing, t1, t0]);
    expect((await call('DELETE', `/${id}/tracks/${first}`)).statusCode).toBe(404);
    expect((await call('PATCH', `/${id}/tracks/${b}`, {})).statusCode).toBe(400);
    expect((await call('PATCH', `/${id}/tracks/${b}`, { beforeEntryId: 99999 })).statusCode).toBe(404);
  });

  it('only the owner edits; the size cap holds', async () => {
    const { h, call, id, t0, t1 } = await setup();
    const other = await signIn(h, { player: { allowed: true } });
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/playback/playlists/${id}/tracks`, headers: { cookie: other.cookie }, payload: { trackIds: [t0] } });
    expect(res.statusCode).toBe(404);
    const big = await call('POST', '', { name: 'Big', trackIds: Array.from({ length: 4999 }, () => t0) });
    const full = await call('POST', `/${big.json().id}/tracks`, { trackIds: [t0, t1] });
    expect([full.statusCode, full.json().code]).toEqual([400, 'PLAYLIST_FULL']);
  });
});

describe('browse', () => {
  it('lists only items with files, with format labels', async () => {
    const h = await harness();
    const { album, artist, book } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const albums = (await get(h, '/api/v1/playback/music/albums', user.cookie)).json();
    expect(albums).toMatchObject({ total: 1, page: 1, pageSize: 60 });
    expect(albums.items[0]).toMatchObject({ id: album.id, trackCount: 2, durationMs: 400_000, formatLabel: 'FLAC 16/44.1', lossless: true, artistName: 'The Testers', genres: ['Rock'] });
    const details = (await get(h, `/api/v1/playback/music/albums/${album.id}`, user.cookie)).json();
    expect(details.tracks.map((t: { title: string }) => t.title)).toEqual(['Song 1', 'Song 2']);
    expect(details.discCount).toBe(1);
    const tracks = (await get(h, '/api/v1/playback/music/tracks?sort=name&desc=true', user.cookie)).json();
    expect(tracks.items.map((t: { title: string }) => t.title)).toEqual(['Song 2', 'Song 1']);
    expect((await get(h, '/api/v1/playback/music/tracks?desc=false', user.cookie)).json().items[0].title).toBe('Song 1');
    expect((await get(h, '/api/v1/playback/music/artists?letter=T', user.cookie)).json().total).toBe(1);
    expect((await get(h, '/api/v1/playback/music/artists?letter=A', user.cookie)).json().total).toBe(0);
    const art = (await get(h, `/api/v1/playback/music/artists/${artist.id}`, user.cookie)).json();
    expect(art).toMatchObject({ albumCount: 1, trackCount: 2 });
    expect(art.topTracks).toHaveLength(2);
    expect((await get(h, '/api/v1/playback/music/albums?genre=jazz', user.cookie)).json().total).toBe(0);
    const books = (await get(h, '/api/v1/playback/audiobooks', user.cookie)).json();
    expect(books.items[0]).toMatchObject({ id: book.id, authors: ['A. Writer'], narrators: ['N. Reader'], seriesTitle: 'The Saga', seriesPosition: '2', durationMs: 360_000, progress: null });
    const bookDetails = (await get(h, `/api/v1/playback/audiobooks/${book.id}`, user.cookie)).json();
    expect(bookDetails.chapters).toHaveLength(3);
    const home = (await get(h, '/api/v1/playback/music/home', user.cookie)).json();
    expect(home.recentlyAdded).toHaveLength(1);
  });

  it('search is typo tolerant across music and audiobooks', async () => {
    const h = await harness();
    seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const res = (await get(h, '/api/v1/playback/search?q=smple', user.cookie)).json();
    expect(res.albums.map((a: { title: string }) => a.title)).toEqual(['Sample Record']);
    const story = (await get(h, '/api/v1/playback/search?q=lng%20stry', user.cookie)).json();
    expect(story.audiobooks.map((b: { title: string }) => b.title)).toEqual(['Long Story']);
    expect((await get(h, '/api/v1/playback/search?q=song', user.cookie)).json().tracks).toHaveLength(2);
  });

  it('artwork falls back to the folder image, then 404', async () => {
    const h = await harness();
    const { album, book } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    expect((await get(h, `/api/v1/playback/artwork/book/${book.id}`, user.cookie)).statusCode).toBe(404);
    const dir = mkdtempSync(join(tmp, 'cover-'));
    writeFileSync(join(dir, 'Cover.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    writeFileSync(join(dir, '01.flac'), BYTES);
    const { eq } = await import('drizzle-orm');
    const first = h.db.select().from(schema.tracks).all().find((t) => t.trackNumber === 1)!.audioFileId!;
    h.db.update(schema.audioFiles).set({ path: join(dir, '01.flac') }).where(eq(schema.audioFiles.id, first)).run();
    const img = await get(h, `/api/v1/playback/artwork/album/${album.id}`, user.cookie);
    expect([img.statusCode, img.headers['content-type'], img.rawPayload.length]).toEqual([200, 'image/jpeg', 4]);
    const denied = await signIn(h);
    expect((await get(h, `/api/v1/playback/artwork/album/${album.id}`, denied.cookie)).statusCode).toBe(403);
    // A folder image over the size cap is skipped, never read.
    const { MAX_ARTWORK_BYTES } = await import('./artwork.js');
    writeFileSync(join(dir, 'Cover.JPG'), Buffer.alloc(MAX_ARTWORK_BYTES + 1));
    expect((await get(h, `/api/v1/playback/artwork/album/${album.id}`, user.cookie)).statusCode).toBe(404);
  });
});

describe('Arclight app additions', () => {
  /** A player user signed in through the app; returns their device token and id. */
  async function appUser(h: Harness): Promise<{ token: string; id: number; cookie: string }> {
    const { appAuthServiceFor } = await import('../app-auth/index.js');
    const auth = authServiceFor(h.ctx);
    const username = `app${Math.random().toString(36).slice(2, 8)}`;
    const user = await auth.createUser({ username, password: 'password1', settings: { player: { allowed: true } } });
    const signed = await appAuthServiceFor(h.ctx).signIn({ username, password: 'password1', deviceName: 'Phone', platform: 'ios', appVersion: '1.0.0' });
    return { token: signed.token, id: user.id, cookie: `${SESSION_COOKIE}=${auth.createSession(user.id).token}` };
  }

  it('the device token works on player routes and streams without a cookie', async () => {
    const h = await harness();
    const { trackIds } = seed(h.db);
    const u = await appUser(h);
    const auth = { authorization: `Bearer ${u.token}` };
    expect((await get(h, `/api/v1/playback/item/track:${trackIds[0]}`, undefined, auth)).statusCode).toBe(200);
    const fileId = h.db.select().from(schema.tracks).all().find((t) => t.id === trackIds[0])!.audioFileId!;
    const stream = await get(h, `/api/v1/stream/audio/${fileId}`, undefined, { ...auth, range: 'bytes=0-9' });
    expect([stream.statusCode, stream.rawPayload.length]).toEqual([206, 10]);
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/playback/progress/track:${trackIds[0]}`,
      headers: auth,
      payload: { event: 'progress', positionMs: 1000, durationMs: 200_000, deviceId: 'app-1', clientTime: new Date().toISOString() },
    });
    expect(put.statusCode).toBe(200);
    // Signed links made with the token keep working while only the device is signed in.
    const links = (await h.app.inject({ method: 'POST', url: '/api/v1/playback/stream-links', headers: auth, payload: { itemKey: `track:${trackIds[0]}` } })).json().links;
    const url = new URL(links[0].url);
    h.db.delete(schema.sessions).run();
    expect((await get(h, url.pathname + url.search)).statusCode).toBe(200);
    authServiceFor(h.ctx).revokeAllSessions(u.id);
    expect((await get(h, url.pathname + url.search)).json().code).toBe('LINK_REVOKED');
    expect((await get(h, `/api/v1/playback/item/track:${trackIds[0]}`, undefined, auth)).statusCode).toBe(401);
  });

  it('POST /playback/items returns playable items in order, skipping missing ones', async () => {
    const h = await harness();
    const { trackIds, book } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const keys = [`track:${trackIds[1]}`, 'track:99999', `audiobook:${book.id}`, `track:${trackIds[1]}`];
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/playback/items', headers: { cookie: user.cookie }, payload: { itemKeys: keys } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as PlayableItem[]).map((i) => i.itemKey)).toEqual([`track:${trackIds[1]}`, `audiobook:${book.id}`]);
    const tooMany = Array.from({ length: 201 }, (_, i) => `track:${i + 1}`);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/playback/items', headers: { cookie: user.cookie }, payload: { itemKeys: tooMany } })).statusCode).toBe(400);
    const denied = await signIn(h);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/playback/items', headers: { cookie: denied.cookie }, payload: { itemKeys: keys } })).statusCode).toBe(403);
  });

  it('?download=1 answers as an attachment with a safe file name; transcodes get their extension', async () => {
    const h = await harness();
    const { partIds, trackIds } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const { eq } = await import('drizzle-orm');
    const odd = join(mkdtempSync(join(tmp, 'dl-')), 'Ünïcode; 100% part.mp3');
    writeFileSync(odd, BYTES);
    h.db.update(schema.audioFiles).set({ path: odd }).where(eq(schema.audioFiles.id, partIds[0]!)).run();
    const plain = await get(h, `/api/v1/stream/audio/${partIds[0]}?download=1`, user.cookie);
    expect(plain.statusCode).toBe(200);
    const cd = String(plain.headers['content-disposition']);
    expect(cd).toMatch(/^attachment; filename="Unicode_ 100_ part\.mp3"; filename\*=UTF-8''/);
    expect(decodeURIComponent(cd.split("UTF-8''")[1]!)).toBe('Ünïcode; 100% part.mp3');
    const { downloadDisposition } = await import('./format.js');
    expect(downloadDisposition('C:\\music\\A\\x.flac', 'opus')).toBe(`attachment; filename="x.opus"; filename*=UTF-8''x.opus`);
    expect(downloadDisposition('/music/Say "Hi".flac', null)).toBe(`attachment; filename="Say _Hi_.flac"; filename*=UTF-8''Say%20%22Hi%22.flac`);
    expect((await get(h, `/api/v1/stream/audio/${partIds[0]}`, user.cookie)).headers['content-disposition']).toBeUndefined();
    const aac = await get(h, `/api/v1/stream/audio/${partIds[0]}?download=1&format=aac&bitrateKbps=96`, user.cookie);
    expect([aac.statusCode, aac.headers['content-type'], aac.headers['x-arclight-transcode']]).toEqual([200, 'audio/aac', 'aac/96']);
    expect(String(aac.headers['content-disposition'])).toContain('part.aac"');
    // Stream links can ask for downloads.
    const links = (await h.app.inject({ method: 'POST', url: '/api/v1/playback/stream-links', headers: { cookie: user.cookie }, payload: { itemKey: `track:${trackIds[0]}`, download: true } })).json().links;
    expect(links[0].url).toContain('download=1&');
    const url = new URL(links[0].url);
    expect(String((await get(h, url.pathname + url.search)).headers['content-disposition'])).toMatch(/^attachment; filename="[^"]+\.flac"/);
  });

  it('POST /playback/progress/batch applies an offline queue newest-wins and answers in request order', async () => {
    const h = await harness();
    const { trackIds } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const t = (s: number) => new Date(Date.now() - 600_000 + s * 1000).toISOString();
    const r = (key: string, positionMs: number, clientTime: string) => ({ itemKey: key, event: 'progress', positionMs, durationMs: 200_000, deviceId: 'app-1', clientTime });
    const a = `track:${trackIds[0]}`;
    const b = `track:${trackIds[1]}`;
    const batch = (reports: unknown[]) => h.app.inject({ method: 'POST', url: '/api/v1/playback/progress/batch', headers: { cookie: user.cookie }, payload: { reports } });
    const res = await batch([r(a, 30_000, t(30)), r(a, 10_000, t(10)), r(b, 5_000, t(5))]);
    expect(res.statusCode).toBe(200);
    const results = res.json().results as Array<{ itemKey: string; accepted: boolean; progress: { positionMs: number } }>;
    // Applied oldest first, so the t(30) report is the one that stays.
    expect(results.map((x) => [x.itemKey, x.accepted])).toEqual([
      [a, true],
      [a, true],
      [b, true],
    ]);
    const list = (await get(h, `/api/v1/playback/progress?itemKeys=${a},${b}`, user.cookie)).json().items as Array<{ itemKey: string; positionMs: number }>;
    expect(list.find((p) => p.itemKey === a)!.positionMs).toBe(30_000);
    expect(list.find((p) => p.itemKey === b)!.positionMs).toBe(5_000);
    // A report older than what is stored is not applied.
    const stale = await batch([r(a, 1_000, t(1))]);
    expect(stale.json().results[0]).toMatchObject({ accepted: false, progress: { positionMs: 30_000 } });
    expect((await batch([])).statusCode).toBe(400);
  });

  it('artwork links open artwork URLs without credentials until revoked', async () => {
    const h = await harness();
    const { album, trackIds } = seed(h.db);
    const user = await signIn(h, { player: { allowed: true } });
    const dir = mkdtempSync(join(tmp, 'cover-'));
    writeFileSync(join(dir, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    writeFileSync(join(dir, '01.flac'), BYTES);
    const { eq } = await import('drizzle-orm');
    const first = h.db.select().from(schema.tracks).all().find((t) => t.id === trackIds[0])!.audioFileId!;
    h.db.update(schema.audioFiles).set({ path: join(dir, '01.flac') }).where(eq(schema.audioFiles.id, first)).run();

    const made = await h.app.inject({ method: 'POST', url: '/api/v1/playback/artwork-link', headers: { cookie: user.cookie } });
    expect(made.statusCode).toBe(200);
    const { query } = made.json() as { query: string; expiresAt: string };
    expect(query).toMatch(/^u=\d+&exp=\d+&sig=[A-Za-z0-9_-]{43}$/);
    const url = `/api/v1/playback/artwork/album/${album.id}?${query}`;
    expect((await get(h, url)).statusCode).toBe(200);
    expect((await get(h, `/api/v1/playback/artwork/album/${album.id}`)).statusCode).toBe(401);
    expect((await get(h, url.replace(/exp=\d+/, 'exp=1000'))).json().code).toBe('LINK_BAD_SIGNATURE');
    // A stream signature is not an artwork signature.
    const links = (await h.app.inject({ method: 'POST', url: '/api/v1/playback/stream-links', headers: { cookie: user.cookie }, payload: { itemKey: `track:${trackIds[0]}` } })).json().links;
    const streamQuery = new URL(links[0].url).search.replace(/^\?/, '');
    expect((await get(h, `/api/v1/playback/artwork/album/${album.id}?${streamQuery}`)).statusCode).toBe(403);
    authServiceFor(h.ctx).revokeAllSessions(user.id);
    expect((await get(h, url)).json().code).toBe('LINK_REVOKED');
  });
});
