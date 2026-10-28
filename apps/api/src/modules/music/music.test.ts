import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '@arclight/metadata';
import { buildItems } from '@arclight/profiles-engine';
import { QUALITIES, type Album, type AlbumDetails, type ArtistDetails, type CalendarItem, type Job } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import { albums, artists, audioFiles, metadataCache, rootFolders, tracks } from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor } from '../auth/index.js';
import { buildFlac } from '../imports/audio/fixtures/builders.js';
import { musicRefresherFor, setMusicProviders, REFRESH_ARTISTS_JOB, SEARCH_NOT_AVAILABLE } from '../metadata/index.js';
import { ProfilesService } from '../profiles/index.js';
import { setSection } from '../settings/service.js';
import { albumsToMonitor, monitorNewAlbum, nextRefreshAt } from './monitoring.js';
import { audioCodecOf, musicQualityFor } from './quality.js';

// The music module over the full app: MusicBrainz answers come from the recorded fixtures in
// packages/metadata/fixtures/musicbrainz through an injected fetch (no network), the rate limiter
// runs on a virtual clock, and artist folders are temp directories of tiny tagged FLAC files.

const FIXTURES = new URL('../../../../../packages/metadata/fixtures/musicbrainz/', import.meta.url);
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

const ARTIST = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const RELEASE = '0b6b4ba0-d36f-47bd-b4ea-6a5b91842d29';
const RELEASE_2DISC = '2629071c-1d8f-43f1-be99-712d931e3bf1';

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

interface ReleaseFixture {
  media: Array<{ position: number; tracks: Array<{ title: string; position: number; recording: { id: string } }> }>;
}
const release = fixture('release.json') as ReleaseFixture;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Serves the MusicBrainz fixtures; everything else (Wikidata, Commons) answers 404. */
function createFixtureFetch() {
  const calls: string[] = [];
  const extraGroups: unknown[] = [];
  const fetchImpl = async (input: string) => {
    const url = new URL(input);
    calls.push(`${url.pathname}${url.search}`);
    if (url.hostname !== 'musicbrainz.org') return json({ error: 'not found' }, 404);
    const path = url.pathname.replace(/^\/ws\/2/, '');
    const q = url.searchParams;
    if (path === '/artist' && q.has('query')) return json(fixture('search-artist.json'));
    if (path === `/artist/${ARTIST}`) return json(fixture('artist.json'));
    if (path === '/release-group' && q.get('artist') === ARTIST) {
      if (q.get('offset') !== '100') return json(fixture('release-groups-page-1.json'));
      const page = fixture('release-groups-page-2.json') as { 'release-groups': unknown[]; 'release-group-count': number };
      return json({ ...page, 'release-groups': [...page['release-groups'], ...extraGroups], 'release-group-count': page['release-group-count'] + extraGroups.length });
    }
    if (path === '/release' && q.get('release-group') === OK_COMPUTER) return json(fixture('releases.json'));
    if (path === `/release/${RELEASE}`) return json(fixture('release.json'));
    if (path === `/release/${RELEASE_2DISC}`) return json(fixture('release-2disc.json'));
    return json(fixture('error-404.json'), 404);
  };
  return { fetchImpl, calls, extraGroups };
}

/** A clock whose sleeps return at once (the limiter's 1 req/s costs no wall time). */
function instantClock() {
  let t = Date.parse('2026-10-01T00:00:00Z');
  return { now: () => t, sleep: async (ms: number) => void (t += Math.max(0, ms)) };
}

interface Harness {
  db: Db;
  ctx: AppContext;
  root: string;
  profileId: number;
  calls: string[];
  extraGroups: unknown[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
  api: (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => Promise<{ statusCode: number; body: string; json<T = any>(): T }>;
  idle: () => Promise<void>;
  close: () => Promise<void>;
}

const open: Harness[] = [];
let h: Harness;

async function harness(opts: { music?: boolean } = {}): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  setSection(db, 'features', { music: opts.music ?? true, audiobooks: false });
  // US CD editions: the fixtures record the 1997 US CD (and the 2017 two-disc reissue).
  setSection(db, 'musicMetadata', {
    baseUrl: 'https://musicbrainz.org/ws/2/',
    rateLimitPerSecond: 1,
    preferredCountries: ['US'],
    preferredFormats: ['CD'],
  });
  const root = mkdtempSync(join(tmpdir(), 'arclight-music-'));
  db.insert(rootFolders).values({ path: root, mediaType: 'music' }).run();
  const { fetchImpl, calls, extraGroups } = createFixtureFetch();
  let ctxRef: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (ctx) => {
      ctxRef = ctx;
      setMusicProviders(ctx, { fetchImpl, rateLimiter: new RateLimiter({ clock: instantClock() }) });
    },
  });
  await app.ready();
  const ctx = ctxRef!;
  const key = authServiceFor(ctx).apiKey();
  const profiles = new ProfilesService({ db });
  const items = buildItems(['MP3-320', 'FLAC', 'FLAC-24bit'], 'music');
  const profile = profiles.createQualityProfile({
    name: 'Hi-Res test',
    upgradeAllowed: true,
    cutoff: QUALITIES['FLAC-24bit'].id,
    items,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
    mediaDomain: 'music',
  });
  const harnessValue: Harness = {
    db,
    ctx,
    root,
    profileId: profile.id,
    calls,
    extraGroups,
    api: (method, url, payload) =>
      app.inject({ method, url: `/api/v1${url}`, headers: { 'x-api-key': key }, ...(payload === undefined ? {} : { payload: payload as object }) }),
    idle: () => musicRefresherFor(ctx)!.whenIdle(),
    close: async () => {
      await musicRefresherFor(ctx)?.whenIdle();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  open.push(harnessValue);
  return harnessValue;
}

afterEach(async () => {
  for (const x of open.splice(0)) await x.close();
});

/** Writes the twelve tracks of the 1997 US CD as tiny FLACs tagged with their recording ids. */
function writeOkComputer(artistFolder: string, opts: { skip?: number[] } = {}): string {
  const folder = join(artistFolder, 'OK Computer (1997)');
  mkdirSync(folder, { recursive: true });
  for (const t of release.media[0]!.tracks) {
    if (opts.skip?.includes(t.position)) continue;
    const name = `${String(t.position).padStart(2, '0')} - ${t.title.replace(/[()]/g, '')}.flac`;
    writeFileSync(
      join(folder, name),
      buildFlac({
        durationMs: 1000,
        tags: { title: t.title, artist: 'Radiohead', albumArtist: 'Radiohead', album: 'OK Computer', trackNo: t.position, trackOf: 12, mbRecordingId: t.recording.id, mbReleaseGroupId: OK_COMPUTER },
      }),
    );
  }
  return folder;
}

async function addRadiohead(body: Record<string, unknown> = {}): Promise<ArtistDetails> {
  const res = await h.api('POST', '/artist', { mbArtistId: ARTIST, rootFolderPath: h.root, qualityProfileId: h.profileId, ...body });
  expect(res.statusCode, res.body).toBe(201);
  const created = res.json();
  await h.idle();
  return (await h.api('GET', `/artist/${created.id}`)).json<ArtistDetails>();
}

const album = (a: ArtistDetails, title: string): Album => {
  const found = a.albums.find((x) => x.title === title);
  if (!found) throw new Error(`no album ${title} in ${a.albums.map((x) => x.title).join(', ')}`);
  return found;
};

function latestJob(name: string): Job | undefined {
  return h.ctx.scheduler.listRecent(200).find((j) => j.name === name);
}

describe('adding an artist', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('answers at once with the artist, then the ArtistAdd job fills albums, editions and tracks', async () => {
    const res = await h.api('POST', '/artist', { mbArtistId: ARTIST.toUpperCase(), rootFolderPath: h.root, qualityProfileId: h.profileId });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ mbArtistId: ARTIST, name: 'Radiohead', path: join(h.root, 'Radiohead'), monitored: true, monitorNewAlbums: 'all' });
    await h.idle();

    const job = latestJob('ArtistAdd');
    expect(job?.status, job?.message ?? '').toBe('completed');

    const details = (await h.api('GET', `/artist/${res.json().id}`)).json<ArtistDetails>();
    const titles = details.albums.map((a) => a.title);
    // "Studio albums": albums and EPs without secondary types.
    expect(titles).toEqual(expect.arrayContaining(['OK Computer', 'Kid A', 'Pablo Honey', 'In Rainbows', 'My Iron Lung']));
    expect(titles).not.toContain('Paranoid Android'); // single
    expect(titles).not.toContain('KID A MNESIA'); // compilation
    expect(titles).not.toContain('I Might Be Wrong: Live Recordings'); // live
    expect(details.albums.every((a) => a.monitored)).toBe(true);
    expect(details.lastRefreshed).toBeTruthy();
    expect(details.nextRefreshAt).toBeTruthy();

    const ok = album(details, 'OK Computer');
    expect(ok.images[0]?.url).toBe(`https://coverartarchive.org/release-group/${OK_COMPUTER}/front-500`);
    const okDetails = (await h.api('GET', `/album/${ok.id}`)).json<AlbumDetails>();
    expect(okDetails.releases).toHaveLength(39);
    const selected = okDetails.releases.find((r) => r.id === okDetails.selectedReleaseId);
    expect(selected?.mbReleaseId).toBe(RELEASE);
    expect(okDetails.tracks.map((t) => t.title).slice(0, 2)).toEqual(['Airbag', 'Paranoid Android']);
    expect(okDetails.tracks).toHaveLength(12);
    expect(okDetails.artist.name).toBe('Radiohead');
    expect(okDetails.statistics).toMatchObject({ trackCount: 12, trackFileCount: 0, totalTrackCount: 12, percentOfTracks: 0 });

    // The background calls stay within the recorded fixtures and are cached persistently.
    const cached = h.db.select().from(metadataCache).all().map((r) => r.key);
    expect(cached).toEqual(expect.arrayContaining([`artist/${ARTIST}`, `release/${RELEASE}`, `releases/${OK_COMPUTER}`]));
  });

  it('rejects a second add, a video profile and an unknown root folder', async () => {
    await addRadiohead();
    expect((await h.api('POST', '/artist', { mbArtistId: ARTIST, rootFolderPath: h.root, qualityProfileId: h.profileId })).statusCode).toBe(409);
    const video = new ProfilesService({ db: h.db }).listQualityProfiles('video')[0]!;
    const other = '0383dadf-2a4e-4d10-a46a-e9e041da8eb3';
    expect((await h.api('POST', '/artist', { mbArtistId: other, rootFolderPath: h.root, qualityProfileId: video.id })).json().error).toMatch(/video profile/);
    expect((await h.api('POST', '/artist', { mbArtistId: other, rootFolderPath: join(h.root, 'nope'), qualityProfileId: h.profileId })).statusCode).toBe(400);
  });

  it('looks artists up on MusicBrainz and marks the ones already added', async () => {
    const before = (await h.api('GET', '/artist/lookup?term=radiohead')).json();
    expect(before[0]).toMatchObject({ mbArtistId: ARTIST, name: 'Radiohead', artistId: null });
    const added = await addRadiohead();
    const after = (await h.api('GET', '/artist/lookup?term=radiohead')).json();
    expect(after[0]).toMatchObject({ mbArtistId: ARTIST, artistId: added.id });
    const byId = (await h.api('GET', `/artist/lookup?term=mbid:${ARTIST}`)).json();
    expect(byId).toEqual([expect.objectContaining({ mbArtistId: ARTIST, score: 100, artistId: added.id })]);
  });
});

describe('monitoring', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('applies the monitor option on add and on update', async () => {
    const latest = await addRadiohead({ monitorOption: 'latest' });
    expect(latest.albums.filter((a) => a.monitored).map((a) => a.title)).toEqual(['A Moon Shaped Pool']);

    const first = (await h.api('PUT', `/artist/${latest.id}`, { monitorOption: 'first' })).json();
    expect(first.statistics.monitoredAlbumCount).toBe(1);
    const afterFirst = (await h.api('GET', `/album?artistId=${latest.id}&monitored=true`)).json<Album[]>();
    expect(afterFirst.map((a) => a.title)).toEqual(['Drill']);

    // `future` with everything released: nothing monitored.
    await h.api('PUT', `/artist/${latest.id}`, { monitorOption: 'future' });
    expect((await h.api('GET', `/album?artistId=${latest.id}&monitored=true`)).json()).toEqual([]);
    // monitored=false is read as false, not coerced to true.
    expect((await h.api('GET', `/album?artistId=${latest.id}&monitored=false`)).json().length).toBe(latest.albums.length);

    const ids = latest.albums.slice(0, 2).map((a) => a.id);
    const bulk = (await h.api('PUT', '/album/monitor', { albumIds: ids, monitored: true })).json<Album[]>();
    expect(bulk.every((a) => a.monitored)).toBe(true);
    expect((await h.api('PUT', `/album/${ids[0]}`, { monitored: false })).json().monitored).toBe(false);
  });

  it('none leaves the artist and its albums unmonitored', async () => {
    const none = await addRadiohead({ monitorOption: 'none' });
    expect(none.monitored).toBe(false);
    expect(none.albums.some((a) => a.monitored)).toBe(false);
  });

  it('a refresh applies monitorNewAlbums to release groups that appeared since', async () => {
    const added = await addRadiohead({ monitorNewAlbums: 'none' });
    h.extraGroups.push({
      id: 'c0ffee00-0000-4000-8000-000000000001',
      title: 'Brand New Record',
      'primary-type': 'Album',
      'secondary-types': [],
      'first-release-date': '2026-11-20',
      disambiguation: '',
    });
    const res = await h.api('POST', '/command', { name: 'RefreshArtist', artistIds: [added.id] });
    expect(res.statusCode, res.body).toBe(202);
    await h.idle();
    expect(latestJob('RefreshArtist')?.status).toBe('completed');
    const after = (await h.api('GET', `/artist/${added.id}`)).json<ArtistDetails>();
    expect(album(after, 'Brand New Record').monitored).toBe(false);

    await h.api('PUT', `/artist/${added.id}`, { monitorNewAlbums: 'future' });
    h.extraGroups.push({ id: 'c0ffee00-0000-4000-8000-000000000002', title: 'Later Record', 'primary-type': 'EP', 'secondary-types': [], 'first-release-date': '2027-02', disambiguation: '' });
    musicRefresherFor(h.ctx)!.refresh([added.id]);
    await h.idle();
    const later = (await h.api('GET', `/artist/${added.id}`)).json<ArtistDetails>();
    expect(album(later, 'Later Record').monitored).toBe(true);
    // An upcoming release means a refresh again tomorrow.
    expect(Date.parse(later.nextRefreshAt!) - Date.now()).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it('pure rules: monitor options, new albums and the refresh interval', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const list = [
      { id: 1, releaseDate: '1997-05-21', hasFiles: true },
      { id: 2, releaseDate: '2016', hasFiles: false },
      { id: 3, releaseDate: '2026-12-01', hasFiles: false },
      { id: 4, releaseDate: null, hasFiles: false },
    ];
    expect([...albumsToMonitor('latest', list, now)]).toEqual([2]);
    expect([...albumsToMonitor('first', list, now)]).toEqual([1]);
    expect([...albumsToMonitor('future', list, now)].sort()).toEqual([3, 4]);
    expect([...albumsToMonitor('missing', list, now)].sort()).toEqual([2, 3, 4]);
    expect([...albumsToMonitor('existing', list, now)]).toEqual([1]);
    expect(monitorNewAlbum('future', '2026-05-01', now)).toBe(false);
    expect(monitorNewAlbum('future', null, now)).toBe(true);
    const days = (iso: string) => Math.round((Date.parse(iso) - now.getTime()) / 86_400_000);
    expect(days(nextRefreshAt('continuing', ['2026-04-01'], now))).toBe(1);
    expect(days(nextRefreshAt('continuing', ['2001-01-01'], now))).toBe(7);
    expect(days(nextRefreshAt('ended', ['2001-01-01'], now))).toBe(30);
  });
});

describe('rescan, statistics and editions', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('rescans an existing folder on add and writes audio_files, has_file and audio_file_id', async () => {
    const folder = writeOkComputer(join(h.root, 'Radiohead'));
    const added = await addRadiohead();
    expect(latestJob('ArtistAdd')?.message).toMatch(/12 track files/);
    const ok = album(added, 'OK Computer');
    expect(ok.statistics).toMatchObject({ trackCount: 12, trackFileCount: 12, percentOfTracks: 100 });
    expect(ok.statistics!.sizeOnDisk).toBeGreaterThan(0);

    const details = (await h.api('GET', `/album/${ok.id}`)).json<AlbumDetails>();
    expect(details.files).toHaveLength(12);
    expect(details.files[0]).toMatchObject({ mediaType: 'music', artistId: added.id, albumId: ok.id, codec: 'FLAC', quality: { quality: { name: 'FLAC' } } });
    expect(details.files[0]!.relativePath).toMatch(/^OK Computer \(1997\)[\\/]01 - Airbag\.flac$/);
    expect(details.tracks.every((t) => t.hasFile && t.audioFileId !== null)).toBe(true);

    // Artist and library statistics.
    expect(added.statistics).toMatchObject({ trackFileCount: 12, completeAlbumCount: 1 });
    const list = (await h.api('GET', '/artist')).json();
    expect(list[0].statistics.trackFileCount).toBe(12);
    const lib = (await h.api('GET', '/library/statistics')).json();
    expect(lib).toMatchObject({ artistCount: 1, monitoredArtistCount: 1, albumCount: added.albums.length, trackCount: 12, trackFileCount: 12 });
    expect(lib.audioSizeOnDisk).toBe(ok.statistics!.sizeOnDisk);

    // A removed file is dropped on the next rescan.
    rmSync(join(folder, '12 - The Tourist.flac'));
    const res = await h.api('POST', '/command', { name: 'RescanArtist', artistIds: [added.id] });
    expect(res.statusCode, res.body).toBe(202);
    await h.idle();
    expect(latestJob('RescanArtist')?.message).toMatch(/11 track files, 1 removed/);
    expect(h.db.select().from(audioFiles).all()).toHaveLength(11);
    const tourist = h.db.select().from(tracks).where(eq(tracks.title, 'The Tourist')).get();
    expect(tourist).toMatchObject({ hasFile: false, audioFileId: null });
  });

  it('switching the edition reloads tracks and re-links files by recording id', async () => {
    writeOkComputer(join(h.root, 'Radiohead'));
    const added = await addRadiohead();
    const ok = album(added, 'OK Computer');
    const before = (await h.api('GET', `/album/${ok.id}`)).json<AlbumDetails>();
    const reissue = before.releases.find((r) => r.mbReleaseId === RELEASE_2DISC)!;

    const switched = await h.api('PUT', `/album/${ok.id}`, { selectedReleaseId: reissue.id });
    expect(switched.statusCode, switched.body).toBe(200);
    const after = switched.json<AlbumDetails>();
    expect(after.selectedReleaseId).toBe(reissue.id);
    expect(after.tracks).toHaveLength(23);
    expect(after.tracks.filter((t) => t.mediumNumber === 1).every((t) => t.hasFile)).toBe(true);
    expect(after.tracks.filter((t) => t.mediumNumber === 2).some((t) => t.hasFile)).toBe(false);
    expect(after.statistics).toMatchObject({ trackCount: 23, trackFileCount: 12 });
    // The same files, now on the reissue's track rows.
    const fileIds = (d: AlbumDetails) => d.tracks.filter((t) => t.hasFile).map((t) => t.audioFileId).sort();
    expect(fileIds(after)).toEqual(fileIds(before));

    const back = (await h.api('PUT', `/album/${ok.id}`, { selectedReleaseId: before.selectedReleaseId })).json<AlbumDetails>();
    expect(back.tracks).toHaveLength(12);
    expect(fileIds(back)).toEqual(fileIds(before));

    // An edition of another album is refused.
    const kidA = album(added, 'Kid A');
    expect((await h.api('PUT', `/album/${kidA.id}`, { selectedReleaseId: reissue.id })).statusCode).toBe(400);
  });

  it('wanted: missing albums until the files are there, then cutoff unmet below the profile cutoff', async () => {
    const added = await addRadiohead();
    const missing = (await h.api('GET', '/wanted/missing/albums?pageSize=100')).json();
    const ok = album(added, 'OK Computer');
    expect(missing.records.map((r: { id: number }) => r.id)).toContain(ok.id);
    expect(missing.records.find((r: { id: number }) => r.id === ok.id)).toMatchObject({ artistName: 'Radiohead', mbArtistId: ARTIST, qualityProfileId: h.profileId });
    expect(missing.totalRecords).toBe(added.albums.length);
    expect((await h.api('GET', '/wanted/cutoff/albums')).json().totalRecords).toBe(0);

    writeOkComputer(added.path);
    await h.api('POST', '/command', { name: 'RescanArtist', artistIds: [added.id] });
    await h.idle();
    const stillMissing = (await h.api('GET', '/wanted/missing/albums?pageSize=100')).json();
    expect(stillMissing.records.map((r: { id: number }) => r.id)).not.toContain(ok.id);
    // 16-bit FLAC is below the FLAC-24bit cutoff.
    const cutoff = (await h.api('GET', '/wanted/cutoff/albums')).json();
    expect(cutoff.records.map((r: { title: string }) => r.title)).toEqual(['OK Computer']);

    // Unmonitoring the artist removes its albums from wanted.
    await h.api('PUT', `/artist/${added.id}`, { monitored: false });
    expect((await h.api('GET', '/wanted/missing/albums')).json().totalRecords).toBe(0);
  });

  it('deleteFiles=false keeps the folder; deleteFiles=true removes it', async () => {
    const folder = writeOkComputer(join(h.root, 'Radiohead'));
    const added = await addRadiohead();
    expect((await h.api('DELETE', `/artist/${added.id}?deleteFiles=false`)).statusCode).toBe(204);
    expect(existsSync(folder)).toBe(true);
    expect(h.db.select().from(albums).all()).toHaveLength(0);
    expect(h.db.select().from(audioFiles).all()).toHaveLength(0);
    const again = await addRadiohead();
    expect((await h.api('DELETE', `/artist/${again.id}?deleteFiles=true`)).statusCode).toBe(204);
    expect(existsSync(join(h.root, 'Radiohead'))).toBe(false);
  });
});

describe('scheduled refresh and the persistent cache', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('RefreshArtists refreshes due artists from the cache without re-fetching cached entities', async () => {
    const added = await addRadiohead();
    h.db.update(artists).set({ nextRefreshAt: '2000-01-01T00:00:00.000Z' }).where(eq(artists.id, added.id)).run();
    h.calls.length = 0;
    const job = await h.ctx.scheduler.run(REFRESH_ARTISTS_JOB, 'manual');
    expect(job.status, job.message ?? '').toBe('completed');
    expect(job.message).toMatch(/refreshed 1 of 1 due artists/);
    expect(h.calls.filter((c) => c.startsWith(`/ws/2/artist/${ARTIST}`))).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith('/ws/2/release-group'))).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith(`/ws/2/release/${RELEASE}`))).toEqual([]);
    const row = h.db.select().from(artists).where(eq(artists.id, added.id)).get()!;
    expect(row.nextRefreshAt! > new Date().toISOString()).toBe(true);
    // Not due any more: the next run skips it.
    expect((await h.ctx.scheduler.run(REFRESH_ARTISTS_JOB, 'manual')).message).toMatch(/refreshed 0 of 0/);

    const cleanup = await h.ctx.scheduler.run('MetadataCacheCleanup', 'manual');
    expect(cleanup.message).toMatch(/pruned 0/);
  });
});

describe('calendar', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('lists album release dates as album items and in the iCal feed', async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    h.extraGroups.push({ id: 'c0ffee00-0000-4000-8000-000000000003', title: 'Soon Record', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': soon, disambiguation: '' });
    await addRadiohead();
    const items = (await h.api('GET', '/calendar?start=1997-05-01&end=1997-06-30')).json<CalendarItem[]>();
    const albumItems = items.filter((i) => i.type === 'album');
    expect(albumItems.map((i) => (i.type === 'album' ? `${i.artistName} - ${i.album.title}` : ''))).toEqual(['Radiohead - OK Computer']);
    expect(albumItems[0]).toMatchObject({ date: '1997-05-21', artist: { name: 'Radiohead', monitored: true }, album: { statistics: { trackCount: 12 } } });
    expect((await h.api('GET', '/calendar?start=1997-05-01&end=1997-06-30&mediaType=series')).json()).toEqual([]);
    expect((await h.api('GET', '/calendar?start=1997-05-01&end=1997-06-30&mediaType=music')).json()).toHaveLength(1);

    const feed = (await h.api('GET', '/calendar/feed')).json();
    const ics = await h.api('GET', `/calendar/feed.ics?token=${feed.token}`);
    expect(ics.statusCode).toBe(200);
    expect(ics.body).toContain('SUMMARY:Radiohead - Soon Record (Album)');
    expect(ics.body).toContain(`DTSTART;VALUE=DATE:${soon.replace(/-/g, '')}`);
    expect(ics.body).toMatch(/UID:arclight-album-\d+@arclight/);
  });
});

describe('commands and album-type profiles', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('search commands report that search is not available yet; unknown ids are 404', async () => {
    const added = await addRadiohead();
    const res = await h.api('POST', '/command', { name: 'ArtistSearch', artistIds: [added.id] });
    expect(res.statusCode).toBe(202);
    await h.idle();
    expect(latestJob('ArtistSearch')).toMatchObject({ status: 'completed', message: SEARCH_NOT_AVAILABLE });
    expect((await h.api('POST', '/command', { name: 'AlbumSearch', albumIds: [added.albums[0]!.id] })).statusCode).toBe(202);
    await h.idle();
    expect(latestJob('AlbumSearch')?.message).toBe(SEARCH_NOT_AVAILABLE);
    expect((await h.api('POST', '/command', { name: 'RefreshArtist', artistIds: [9999] })).statusCode).toBe(404);
    expect((await h.api('POST', '/command', { name: 'Nope' })).statusCode).toBe(400);
  });

  it('bulk-edits artists through the editor', async () => {
    const added = await addRadiohead();
    const tag = (await h.api('POST', '/tag', { label: 'rock' })).json();
    const res = await h.api('PUT', '/artist/editor', { ids: [added.id], monitored: false, tags: { add: [tag.id] }, monitorNewAlbums: 'future' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()[0]).toMatchObject({ monitored: false, tags: [tag.id], monitorNewAlbums: 'future' });
    // Deleting the tag strips it from the artist too.
    await h.api('DELETE', `/tag/${tag.id}`);
    expect((await h.api('GET', `/artist/${added.id}`)).json().tags).toEqual([]);
  });

  it('creates, updates and deletes album-type profiles; the default and used ones stay', async () => {
    const list = (await h.api('GET', '/albumtypeprofile')).json();
    expect(list.map((p: { name: string }) => p.name)).toEqual(['Studio albums', 'Everything']);
    const created = await h.api('POST', '/albumtypeprofile', { name: 'Singles too', primaryTypes: ['Album', 'EP', 'Single'] });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ secondaryTypes: [], releaseStatuses: ['Official'], isDefault: false });
    const id = created.json().id;
    expect((await h.api('POST', '/albumtypeprofile', { name: 'singles TOO', primaryTypes: ['Album'] })).statusCode).toBe(409);
    const updated = (await h.api('PUT', `/albumtypeprofile/${id}`, { name: 'Singles too', primaryTypes: ['Single'], isDefault: true })).json();
    expect(updated.isDefault).toBe(true);
    expect((await h.api('GET', '/albumtypeprofile')).json().filter((p: { isDefault: boolean }) => p.isDefault)).toHaveLength(1);
    expect((await h.api('DELETE', `/albumtypeprofile/${id}`)).statusCode).toBe(400); // default

    // Adding without a profile uses the default: singles only.
    const added = await addRadiohead();
    expect(added.albumTypeProfileId).toBe(id);
    expect(added.albums.every((a) => a.primaryType === 'Single')).toBe(true);
    await h.api('PUT', `/albumtypeprofile/${list[0].id}`, { ...list[0], isDefault: true });
    expect((await h.api('DELETE', `/albumtypeprofile/${id}`)).statusCode).toBe(409); // in use
  });
});

describe('the music feature flag', () => {
  beforeEach(async () => {
    h = await harness({ music: false });
  });

  it('hides every music route, calendar item, statistic and job while off', async () => {
    for (const [method, url, body] of [
      ['GET', '/artist'],
      ['GET', '/artist/1'],
      ['GET', '/artist/lookup?term=radiohead'],
      ['POST', '/artist', { mbArtistId: ARTIST, rootFolderPath: h.root, qualityProfileId: h.profileId }],
      ['GET', '/album'],
      ['GET', '/albumtypeprofile'],
      ['GET', '/wanted/missing/albums'],
      ['POST', '/command', { name: 'RefreshArtist', artistIds: [1] }],
    ] as const) {
      const res = await h.api(method, url, body);
      expect([url, res.statusCode]).toEqual([url, 404]);
      expect(res.json().code).toBe('MUSIC_DISABLED');
    }
    expect(h.calls).toEqual([]);
    expect((await h.ctx.scheduler.run(REFRESH_ARTISTS_JOB, 'manual')).message).toMatch(/skipped: music is not enabled/);
    expect((await h.api('GET', '/library/statistics')).json().artistCount).toBeUndefined();

    // Rows left from when music was on do not reach the calendar.
    setSection(h.db, 'features', { music: true, audiobooks: false });
    await addRadiohead();
    setSection(h.db, 'features', { music: false, audiobooks: false });
    const items = (await h.api('GET', '/calendar?start=1997-05-01&end=1997-06-30')).json<CalendarItem[]>();
    expect(items.filter((i) => i.type === 'album')).toEqual([]);
  });
});

describe('file quality', () => {
  it('maps measured codecs and bitrates onto music qualities', () => {
    expect(audioCodecOf('MPEG 1 Layer 3')).toBe('MP3');
    expect(audioCodecOf('mp4a.40.2')).toBe('AAC');
    expect(musicQualityFor({ codec: 'FLAC', bitrateKbps: 900, bitDepth: 16 }).quality.name).toBe('FLAC');
    expect(musicQualityFor({ codec: 'flac', bitrateKbps: 2500, bitDepth: 24 }).quality.name).toBe('FLAC-24bit');
    expect(musicQualityFor({ codec: 'MPEG 1 Layer 3', bitrateKbps: 318, bitDepth: null }).quality.name).toBe('MP3-320');
    expect(musicQualityFor({ codec: 'MPEG 1 Layer 3', bitrateKbps: 192, bitDepth: null }).quality.name).toBe('MP3-192');
    expect(musicQualityFor({ codec: 'AAC', bitrateKbps: 256, bitDepth: null }).quality.name).toBe('AAC-256');
    expect(musicQualityFor({ codec: 'whatever', bitrateKbps: 256, bitDepth: null }).quality.name).toBe('Unknown');
  });
});
