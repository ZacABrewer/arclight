import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '@arclight/metadata';
import { buildItems } from '@arclight/profiles-engine';
import { QUALITIES, SECRET_MASK, type ArtistDetails, type MusicPlaylist, type MusicPlaylistEntry } from '@arclight/shared';
import { buildApp, type AppContext } from '../../../app.js';
import type { AppConfig } from '../../../config.js';
import type { Db } from '../../../db/index.js';
import { albums, rootFolders } from '../../../db/schema.js';
import { createTestDb, seedAdmin } from '../../../db/test-utils.js';
import { authServiceFor } from '../../auth/index.js';
import { buildFlac } from '../../imports/audio/fixtures/builders.js';
import { musicRefresherFor, setMusicProviders } from '../../metadata/index.js';
import { ProfilesService } from '../../profiles/index.js';
import { setSection } from '../../settings/service.js';
import { playlistServiceFor, setPlaylistProviders } from './index.js';

// Playlists over the full app. Every outside service is a fake behind one injected fetch:
// MusicBrainz (the recorded Radiohead fixtures plus recording/ISRC/search answers built from
// them), Deezer, ListenBrainz (playlists and the labs similar-artist host) and a Jellyfin
// server. No network; the rate limiters run on a virtual clock.

const FIXTURES = new URL('../../../../../../packages/metadata/fixtures/musicbrainz/', import.meta.url);
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

const ARTIST = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const RELEASE = '0b6b4ba0-d36f-47bd-b4ea-6a5b91842d29';
const RELEASE_2DISC = '2629071c-1d8f-43f1-be99-712d931e3bf1';
const OTHER_ARTIST = '33333333-3333-4333-8333-333333333333';
const OTHER_RG = '11111111-1111-4111-8111-111111111111';
const SIM_A = '66666666-6666-4666-8666-666666666666';
const LB_PLAYLIST = '77777777-7777-4777-8777-777777777777';

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

interface ReleaseFixture {
  media: Array<{ position: number; tracks: Array<{ title: string; position: number; length?: number; recording: { id: string } }> }>;
}
const release = fixture('release.json') as ReleaseFixture;
const okTrack = (title: string) => release.media[0]!.tracks.find((t) => t.title === title)!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const radioheadCredit = [{ name: 'Radiohead', joinphrase: '', artist: { id: ARTIST, name: 'Radiohead' } }];
const okRelease = {
  id: RELEASE,
  title: 'OK Computer',
  status: 'Official',
  date: '1997-07-01',
  country: 'US',
  'release-group': { id: OK_COMPUTER, title: 'OK Computer', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '1997-05-21' },
};
const okRecording = (title: string) => {
  const t = okTrack(title);
  return { id: t.recording.id, title: t.title, length: t.length ?? null, 'artist-credit': radioheadCredit, releases: [okRelease] };
};
const otherRecording = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Example Song',
  length: 201500,
  'artist-credit': [{ name: 'Example Band', joinphrase: '', artist: { id: OTHER_ARTIST, name: 'Example Band' } }],
  releases: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      title: 'Example Album',
      status: 'Official',
      date: '2024-03-01',
      'release-group': { id: OTHER_RG, title: 'Example Album', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2024-03-01' },
    },
  ],
};

const deezerTrack = (n: number, title: string, artist: string, album: string, isrc = '') => ({ id: 1000 + n, type: 'track', title, duration: 200, isrc, artist: { name: artist }, album: { title: album } });

interface Fake {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ method: string; url: URL }>;
  jellyfinPlaylists: Map<string, string[]>;
  similarFails: boolean;
}

function createFake(): Fake {
  const calls: Fake['calls'] = [];
  const jellyfinPlaylists = new Map<string, string[]>();
  const fake: Fake = {
    calls,
    jellyfinPlaylists,
    similarFails: false,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      const q = url.searchParams;
      if (url.hostname === 'musicbrainz.org') {
        const path = url.pathname.replace(/^\/ws\/2/, '');
        if (path === `/artist/${ARTIST}`) return json(fixture('artist.json'));
        if (path === '/release-group' && q.get('artist') === ARTIST) {
          return json(q.get('offset') !== '100' ? fixture('release-groups-page-1.json') : fixture('release-groups-page-2.json'));
        }
        if (path === '/release' && q.get('release-group') === OK_COMPUTER) return json(fixture('releases.json'));
        if (path === `/release/${RELEASE}`) return json(fixture('release.json'));
        if (path === `/release/${RELEASE_2DISC}`) return json(fixture('release-2disc.json'));
        if (path === '/isrc/GBAYE9700001') return json({ isrc: 'GBAYE9700001', recordings: [okRecording('Airbag')] });
        if (path === `/recording/${okTrack('Lucky').recording.id}`) return json(okRecording('Lucky'));
        if (path === '/recording' && q.has('query')) {
          const query = q.get('query') ?? '';
          if (query.includes('Paranoid Android')) return json({ count: 1, offset: 0, recordings: [{ ...okRecording('Paranoid Android'), score: 100 }] });
          if (query.includes('Example Song')) return json({ count: 1, offset: 0, recordings: [{ ...otherRecording, score: 95 }] });
          return json({ count: 0, offset: 0, recordings: [] });
        }
        return json({ error: 'Not Found' }, 404);
      }
      if (url.hostname === 'api.deezer.com') {
        if (url.pathname === '/playlist/42') return json({ id: 42, title: 'Road Trip', description: 'Songs for the car', creator: { name: 'example-user' } });
        if (url.pathname === '/playlist/42/tracks') {
          return json({
            data: [
              deezerTrack(1, 'Airbag', 'Radiohead', 'OK Computer', 'GBAYE9700001'),
              deezerTrack(2, 'Paranoid Android', 'Radiohead', 'OK Computer'),
              deezerTrack(3, 'Unheard Song', 'Example Band', 'Nowhere'),
              deezerTrack(4, 'Example Song', 'Example Band', 'Example Album'),
            ],
            total: 4,
          });
        }
        return json({ error: { type: 'DataException', message: 'no data', code: 800 } });
      }
      if (url.hostname === 'api.listenbrainz.org' && url.pathname === `/1/playlist/${LB_PLAYLIST}`) {
        return json({
          playlist: {
            title: 'Weekly Exploration for example-user',
            identifier: `https://listenbrainz.org/playlist/${LB_PLAYLIST}`,
            creator: 'listenbrainz',
            track: [{ title: 'Lucky', creator: 'Radiohead', album: 'OK Computer', duration: 259000, identifier: [`https://musicbrainz.org/recording/${okTrack('Lucky').recording.id}`] }],
          },
        });
      }
      if (url.hostname === 'labs.api.listenbrainz.org') {
        if (fake.similarFails) return json({ error: 'down' }, 503);
        if (q.get('artist_mbids') === SIM_A) return json([{ artist_mbid: ARTIST, name: 'Radiohead', comment: '', type: 'Group', score: 12, reference_mbid: SIM_A }]);
        return json([
          { artist_mbid: SIM_A, name: 'Band A', comment: '', type: 'Group', score: 40, reference_mbid: ARTIST },
          { artist_mbid: ARTIST, name: 'Radiohead', comment: '', type: 'Group', score: 99, reference_mbid: ARTIST },
        ]);
      }
      if (url.hostname === 'jellyfin.example.com') {
        if (url.pathname === '/Users') return json([{ Id: 'u1', Policy: { IsAdministrator: true } }]);
        if (url.pathname === '/Users/u1/Items') {
          return json({
            Items: [
              { Id: 'jf-airbag', Name: 'Airbag', ProviderIds: { MusicBrainzTrack: okTrack('Airbag').recording.id } },
              { Id: 'jf-paranoid', Name: 'Paranoid Android', Path: '/music/Radiohead/OK Computer (1997)/02 - Paranoid Android.flac', ProviderIds: {} },
            ],
            TotalRecordCount: 2,
          });
        }
        const items = /^\/Playlists\/([^/]+)\/Items$/.exec(url.pathname);
        if (url.pathname === '/Playlists' && method === 'POST') {
          jellyfinPlaylists.set('pl9', (q.get('Ids') ?? '').split(',').filter(Boolean));
          return json({ Id: 'pl9' });
        }
        if (items) {
          const list = jellyfinPlaylists.get(items[1]!);
          if (!list) return json({}, 404);
          if (method === 'GET') return json({ Items: list.map((id, i) => ({ Id: id, PlaylistItemId: `e${i}` })) });
          if (method === 'DELETE') {
            jellyfinPlaylists.set(items[1]!, []);
            return new Response(null, { status: 204 });
          }
          if (method === 'POST') {
            jellyfinPlaylists.set(items[1]!, [...list, ...(q.get('Ids') ?? '').split(',').filter(Boolean)]);
            return new Response(null, { status: 204 });
          }
        }
        return json({}, 404);
      }
      return json({ error: 'not found' }, 404);
    },
  };
  return fake;
}

function instantClock() {
  let t = Date.parse('2026-11-01T00:00:00Z');
  return { now: () => t, sleep: async (ms: number) => void (t += Math.max(0, ms)) };
}

interface Harness {
  db: Db;
  ctx: AppContext;
  root: string;
  profileId: number;
  fake: Fake;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
  api: (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => Promise<{ statusCode: number; body: string; json<T = any>(): T }>;
  close: () => Promise<void>;
}

const open: Harness[] = [];
let h: Harness;

async function harness(): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  setSection(db, 'features', { music: true, audiobooks: false });
  setSection(db, 'musicMetadata', { baseUrl: 'https://musicbrainz.org/ws/2/', rateLimitPerSecond: 1, preferredCountries: ['US'], preferredFormats: ['CD'] });
  setSection(db, 'mediaServers', {
    servers: [
      { id: 'jf1', kind: 'jellyfin', name: 'Example Jellyfin', url: 'http://jellyfin.example.com', apiKey: 'test-key', enabled: true },
      { id: 'abs1', kind: 'audiobookshelf', name: 'Books', url: 'http://abs.example.com', apiKey: 'k', enabled: true },
    ],
  } as never);
  const root = mkdtempSync(join(tmpdir(), 'arclight-playlists-'));
  db.insert(rootFolders).values({ path: root, mediaType: 'music' }).run();
  const fake = createFake();
  let ctxRef: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (ctx) => {
      ctxRef = ctx;
      const rateLimiter = new RateLimiter({ clock: instantClock() });
      setMusicProviders(ctx, { fetchImpl: fake.fetchImpl, rateLimiter });
      setPlaylistProviders(ctx, { fetchImpl: fake.fetchImpl, rateLimiter });
    },
  });
  await app.ready();
  const ctx = ctxRef!;
  const key = authServiceFor(ctx).apiKey();
  const profile = new ProfilesService({ db }).createQualityProfile({
    name: 'Music test',
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
  const value: Harness = {
    db,
    ctx,
    root,
    profileId: profile.id,
    fake,
    api: (method, url, payload) => app.inject({ method, url: `/api/v1${url}`, headers: { 'x-api-key': key }, ...(payload === undefined ? {} : { payload: payload as object }) }),
    close: async () => {
      await musicRefresherFor(ctx)?.whenIdle();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  open.push(value);
  return value;
}

afterEach(async () => {
  for (const x of open.splice(0)) await x.close();
});

/** OK Computer on disk without "Lucky", then Radiohead added with nothing monitored. */
async function addRadiohead(): Promise<ArtistDetails> {
  const folder = join(h.root, 'Radiohead', 'OK Computer (1997)');
  mkdirSync(folder, { recursive: true });
  for (const t of release.media[0]!.tracks) {
    if (t.title === 'Lucky') continue;
    const name = `${String(t.position).padStart(2, '0')} - ${t.title.replace(/[()]/g, '')}.flac`;
    writeFileSync(
      join(folder, name),
      buildFlac({ durationMs: 1000, tags: { title: t.title, artist: 'Radiohead', albumArtist: 'Radiohead', album: 'OK Computer', trackNo: t.position, trackOf: 12, mbRecordingId: t.recording.id, mbReleaseGroupId: OK_COMPUTER } }),
    );
  }
  const res = await h.api('POST', '/artist', { mbArtistId: ARTIST, rootFolderPath: h.root, qualityProfileId: h.profileId, monitorOption: 'none' });
  expect(res.statusCode, res.body).toBe(201);
  await musicRefresherFor(h.ctx)!.whenIdle();
  return (await h.api('GET', `/artist/${res.json().id}`)).json<ArtistDetails>();
}

async function createPlaylist(body: Record<string, unknown>): Promise<MusicPlaylist> {
  const res = await h.api('POST', '/music/playlist', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<MusicPlaylist>();
}

describe('music playlists', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('syncs a Deezer playlist: matches by ISRC, the library, search and not at all, wants albums, writes the .m3u8 and pushes to Jellyfin', async () => {
    const artist = await addRadiohead();
    const ok = artist.albums.find((a) => a.title === 'OK Computer')!;
    expect(ok.monitored).toBe(false);

    const playlist = await createPlaylist({ name: 'Road Trip', source: { kind: 'deezer', url: 'https://www.deezer.com/en/playlist/42' }, want: 'albums', targets: ['server:jf1'] });
    expect(playlist).toMatchObject({ lastSyncStatus: 'never', counts: { total: 0 }, writeM3u: true });

    const report = await playlistServiceFor(h.ctx).sync(playlist.id);
    expect(report.status, report.message).toBe('ok');

    const entries = (await h.api('GET', `/music/playlist/${playlist.id}/entries`)).json<MusicPlaylistEntry[]>();
    expect(entries.map((e) => [e.title, e.status, e.matchMethod])).toEqual([
      ['Airbag', 'available', 'isrc'],
      // Found in the library by artist + title before any MusicBrainz search.
      ['Paranoid Android', 'available', 'library'],
      ['Unheard Song', 'unmatched', null],
      ['Example Song', 'matched', 'search'],
    ]);
    expect(entries[0]).toMatchObject({ albumTitle: 'OK Computer', artistName: 'Radiohead', releaseGroupMbid: OK_COMPUTER, artistMbid: ARTIST });
    expect(entries[3]).toMatchObject({ artistMbid: OTHER_ARTIST, artistId: null, releaseGroupMbid: OTHER_RG });

    // want=albums monitors the album the listed tracks are on.
    expect(h.db.select({ monitored: albums.monitored }).from(albums).all().filter((a) => a.monitored)).toHaveLength(1);

    const after = (await h.api('GET', `/music/playlist/${playlist.id}`)).json<MusicPlaylist>();
    expect(after).toMatchObject({ sourceTitle: 'Road Trip', lastSyncStatus: 'ok', counts: { total: 4, matched: 3, available: 2, wanted: 0 } });

    const m3u = readFileSync(join(h.root, 'Road Trip.m3u8'), 'utf8');
    expect(m3u).toMatch(/^#EXTM3U/);
    expect(m3u).toContain('Radiohead/OK Computer (1997)/01 - Airbag.flac');
    expect(m3u).toContain('02 - Paranoid Android.flac');

    // Jellyfin: one by recording id, one by path tail.
    expect(h.fake.jellyfinPlaylists.get('pl9')).toEqual(['jf-airbag', 'jf-paranoid']);

    // A second sync replaces the remote playlist's items instead of creating another one.
    await playlistServiceFor(h.ctx).sync(playlist.id);
    expect(h.fake.calls.filter((c) => c.url.pathname === '/Playlists' && c.method === 'POST')).toHaveLength(1);
    expect(h.fake.calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/Playlists/pl9/Items')).toBe(true);
    expect(h.fake.jellyfinPlaylists.get('pl9')).toEqual(['jf-airbag', 'jf-paranoid']);
    // Recording lookups came from the cache the second time.
    expect(h.fake.calls.filter((c) => c.url.pathname === '/ws/2/isrc/GBAYE9700001')).toHaveLength(1);
  });

  it('a ListenBrainz playlist matches by recording id; a missing track on a wanted album reads as wanted', async () => {
    await addRadiohead();
    const playlist = await createPlaylist({ name: 'Weekly', source: { kind: 'listenbrainz', url: `https://listenbrainz.org/playlist/${LB_PLAYLIST}` }, want: 'albums', writeM3u: false });
    const report = await playlistServiceFor(h.ctx).sync(playlist.id);
    expect(report.status, report.message).toBe('ok');
    const [lucky] = (await h.api('GET', `/music/playlist/${playlist.id}/entries`)).json<MusicPlaylistEntry[]>();
    expect(lucky).toMatchObject({ title: 'Lucky', status: 'wanted', matchMethod: 'recording', albumTitle: 'OK Computer' });
  });

  it('want=none only matches; the sync route answers 202 and runs as a job', async () => {
    await addRadiohead();
    const playlist = await createPlaylist({ name: 'Just looking', source: { kind: 'deezer', url: '42' }, writeM3u: false });
    const res = await h.api('POST', `/music/playlist/${playlist.id}/sync`);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ status: 'running' });
    for (let i = 0; i < 200 && (await h.api('GET', `/music/playlist/${playlist.id}`)).json().lastSyncStatus === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    const after = (await h.api('GET', `/music/playlist/${playlist.id}`)).json<MusicPlaylist>();
    expect(after.lastSyncStatus).toBe('ok');
    expect(after.counts).toMatchObject({ total: 4, available: 2 });
    expect(h.db.select({ monitored: albums.monitored }).from(albums).all().some((a) => a.monitored)).toBe(false);
    expect(h.ctx.scheduler.listRecent(50).some((j) => j.name === 'MusicPlaylistSync')).toBe(true);
  });

  it('a failing source marks the sync failed with the reason', async () => {
    const playlist = await createPlaylist({ name: 'Gone', source: { kind: 'deezer', url: '999' }, writeM3u: false });
    const report = await playlistServiceFor(h.ctx).sync(playlist.id);
    expect(report.status).toBe('failed');
    expect((await h.api('GET', `/music/playlist/${playlist.id}`)).json()).toMatchObject({ lastSyncStatus: 'failed', lastSyncMessage: expect.stringMatching(/not found/i) });
  });

  it('previews sources; Spotify and Last.fm need keys first', async () => {
    const preview = await h.api('POST', '/music/playlist/preview', { source: { kind: 'deezer', url: 'https://deezer.com/playlist/42' } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ title: 'Road Trip', owner: 'example-user', trackCount: 4, tracks: [{ title: 'Airbag', artist: 'Radiohead', album: 'OK Computer' }, {}, {}, {}] });

    const spotify = await h.api('POST', '/music/playlist/preview', { source: { kind: 'spotify', url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' } });
    expect(spotify.statusCode).toBe(409);
    expect(spotify.json()).toMatchObject({ code: 'NOT_CONFIGURED' });
    const lastfm = await h.api('POST', '/music/playlist/preview', { source: { kind: 'lastfm', user: 'example-user' } });
    expect(lastfm.statusCode).toBe(409);

    const missing = await h.api('POST', '/music/playlist/preview', { source: { kind: 'deezer', url: '999' } });
    expect(missing.statusCode).toBe(404);
  });

  it('settings mask secrets and keep them on a masked update', async () => {
    const put = await h.api('PUT', '/settings/musicplaylists', { spotifyClientId: 'client', spotifyClientSecret: 'shh', navidromePassword: 'pw', m3uPaths: 'absolute' });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ spotifyClientId: 'client', spotifyClientSecret: SECRET_MASK, navidromePassword: SECRET_MASK, m3uPaths: 'absolute' });
    await h.api('PUT', '/settings/musicplaylists', { spotifyClientSecret: SECRET_MASK, similarSource: 'listenbrainz' });
    const stored = playlistServiceFor(h.ctx).settings();
    expect(stored).toMatchObject({ spotifyClientSecret: 'shh', similarSource: 'listenbrainz' });
    expect((await h.api('GET', '/settings/musicplaylists')).json().spotifyClientSecret).toBe(SECRET_MASK);
  });

  it('validates targets, root folders and profiles; a new source clears the entries; delete is 204', async () => {
    const base = { name: 'X', source: { kind: 'deezer', url: '42' } };
    expect((await h.api('POST', '/music/playlist', { ...base, targets: ['server:nope'] })).statusCode).toBe(400);
    expect((await h.api('POST', '/music/playlist', { ...base, targets: ['server:abs1'] })).statusCode).toBe(400);
    expect((await h.api('POST', '/music/playlist', { ...base, rootFolderPath: '/elsewhere' })).statusCode).toBe(400);
    expect((await h.api('POST', '/music/playlist', { ...base, qualityProfileId: 9999 })).statusCode).toBe(400);
    expect((await h.api('POST', '/music/playlist', { ...base, source: { kind: 'deezer', url: '' } })).statusCode).toBe(400);

    const p = await createPlaylist({ ...base, writeM3u: false, targets: ['navidrome'] });
    await playlistServiceFor(h.ctx).sync(p.id);
    const synced = (await h.api('GET', `/music/playlist/${p.id}`)).json<MusicPlaylist>();
    // Navidrome is not set up: the push fails, the rest still counts.
    expect(synced.lastSyncStatus).toBe('partial');
    expect(synced.lastSyncMessage).toMatch(/Navidrome is not set up/);
    expect(synced.counts.total).toBe(4);

    const updated = (await h.api('PUT', `/music/playlist/${p.id}`, { source: { kind: 'listenbrainz', url: LB_PLAYLIST }, name: 'Y' })).json<MusicPlaylist>();
    expect(updated).toMatchObject({ name: 'Y', lastSyncStatus: 'never', counts: { total: 0 } });

    expect((await h.api('GET', '/music/playlist')).json()).toHaveLength(1);
    expect((await h.api('DELETE', `/music/playlist/${p.id}`)).statusCode).toBe(204);
    expect((await h.api('GET', `/music/playlist/${p.id}`)).statusCode).toBe(404);
    expect((await h.api('GET', `/music/playlist/${p.id}/entries`)).statusCode).toBe(404);
  });

  it('similar artists come from ListenBrainz, cached for a day, with library ids', async () => {
    const artist = await addRadiohead();
    const res = await h.api('GET', `/artist/${artist.id}/similar`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items).toEqual([{ mbid: SIM_A, name: 'Band A', score: expect.any(Number), source: 'listenbrainz', artistId: null }]);
    await h.api('GET', `/artist/${artist.id}/similar`);
    expect(h.fake.calls.filter((c) => c.url.hostname === 'labs.api.listenbrainz.org')).toHaveLength(1);
    expect((await h.api('GET', '/artist/9999/similar')).statusCode).toBe(404);
  });

  it('the request portal shows similar artists as artist cards with library status', async () => {
    await addRadiohead();
    const res = await h.api('GET', `/discover/music/artist/${SIM_A}/similar`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items).toEqual([expect.objectContaining({ kind: 'artist', foreignId: ARTIST, title: 'Radiohead', libraryId: expect.any(Number) })]);
    h.fake.similarFails = true;
    // Not cached for this id and the source is down: an empty strip, not an error.
    expect((await h.api('GET', `/discover/music/artist/${OTHER_ARTIST}/similar`)).json()).toEqual({ items: [] });
  });

  it('similar artists answer 502 when every source is down and nothing is cached', async () => {
    const artist = await addRadiohead();
    h.fake.similarFails = true;
    const res = await h.api('GET', `/artist/${artist.id}/similar`);
    expect(res.statusCode, res.body).toBe(502);
  });

  it('hides every route while music is off', async () => {
    setSection(h.db, 'features', { music: false, audiobooks: false });
    const res = await h.api('GET', '/music/playlist');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'MUSIC_DISABLED' });
  });
});
