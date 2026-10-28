import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MbRelease } from '@arclight/metadata';
import { buildItems } from '@arclight/profiles-engine';
import {
  QUALITIES,
  type AudioManualImportItem,
  type AudioManualImportResult,
  type MediaManagementSettings,
  type NamingConfig,
  type QueueStatusMessage,
  type ServerEvent,
  type TrackedDownloadState,
  type TrackedDownloadStatus,
} from '@arclight/shared';
import { buildApp, type AppContext } from '../../../app.js';
import type { AppConfig } from '../../../config.js';
import type { Db } from '../../../db/index.js';
import { albumReleases, albums, artists, audioFiles, importedDownloads, tracks } from '../../../db/schema.js';
import { createTestDb } from '../../../db/test-utils.js';
import { EventBus } from '../../../events.js';
import { historyServiceFor } from '../../history/index.js';
import { mediaServersServiceFor } from '../../media-servers/index.js';
import * as music from '../../music/service.js';
import { albumStatistics } from '../../music/statistics.js';
import { notificationsServiceFor } from '../../notifications/index.js';
import { ProfilesService } from '../../profiles/index.js';
import { getSection, setSection } from '../../settings/service.js';
import { importsDeps } from '../../../wiring.js';
import type { TrackedDownload } from '../../download-clients/index.js';
import type { AudioImportedEvent, ImportsDeps } from '../deps.js';
import { importsRoutes } from '../routes.js';
import { ImportsService, type DownloadClientsPort } from '../service.js';
import { buildFlac, buildMp3, type FixtureTags } from './fixtures/builders.js';

// The music importer end to end over temp folders of tiny silent tagged files (durations of
// 1-4 s stand in for real track lengths) and a test database seeded with an artist, albums,
// editions and tracks the way the MusicBrainz refresher writes them.

const NOW = '2026-10-20T12:00:00.000Z';
const ARTIST = 'Fixture Artist';

let tmp: string;
let musicRoot: string;
let artistPath: string;
let downloads: string;
let bin: string;
let db: Db;
let bus: EventBus;
let events: ServerEvent[];
let fake: FakeDownloads;
let artistId: number;

class FakeDownloads implements DownloadClientsPort {
  items = new Map<number, TrackedDownload>();
  imported: number[] = [];
  add(item: TrackedDownload) {
    this.items.set(item.id, item);
    return item;
  }
  setState(id: number, state: TrackedDownloadState, options: { statusMessages?: QueueStatusMessage[]; trackedStatus?: TrackedDownloadStatus } = {}) {
    const item = this.items.get(id)!;
    const next = { ...item, trackedState: state, ...(options.statusMessages ? { statusMessages: options.statusMessages } : {}), ...(options.trackedStatus ? { trackedStatus: options.trackedStatus } : {}) };
    this.items.set(id, next);
    return next;
  }
  async markImported(id: number) {
    this.imported.push(id);
    return this.setState(id, 'imported', { statusMessages: [], trackedStatus: 'ok' });
  }
  listTracked(states?: readonly TrackedDownloadState[]) {
    return [...this.items.values()].filter((i) => !states || states.includes(i.trackedState));
  }
}

// ---- catalogue helpers ----------------------------------------------------------------------

let uuidSeq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;
const recordings = new Map<string, string>();
const recordingOf = (title: string) => {
  let id = recordings.get(title);
  if (!id) recordings.set(title, (id = uuid()));
  return id;
};

interface TrackDef {
  title: string;
  ms: number;
}
interface ReleaseDef {
  mbid: string;
  title: string;
  discs: TrackDef[][];
}

const tracksOf = (titles: string[], base = 1000): TrackDef[] => titles.map((title, i) => ({ title, ms: base + i * 500 }));

function release(title: string, ...discs: TrackDef[][]): ReleaseDef {
  return { mbid: uuid(), title, discs };
}

function mbRelease(r: ReleaseDef): MbRelease {
  let absolute = 0;
  return {
    mbid: r.mbid,
    title: r.title,
    formats: r.discs.map(() => 'CD'),
    mediumCount: r.discs.length,
    trackCount: r.discs.flat().length,
    artistCredits: [],
    labels: [],
    media: r.discs.map((disc, d) => ({
      position: d + 1,
      format: 'CD',
      trackCount: disc.length,
      tracks: disc.map((t, i) => ({
        mbid: uuid(),
        recordingMbid: recordingOf(t.title),
        title: t.title,
        number: String(i + 1),
        position: i + 1,
        mediumNumber: d + 1,
        absoluteNumber: ++absolute,
        durationMs: t.ms,
        artistCredits: [],
      })),
    })),
  };
}

interface AlbumHandle {
  id: number;
  title: string;
  releases: ReleaseDef[];
  releaseRowIds: number[];
}

/** An album with editions; the `selected` one gets its tracks stored (as the refresher does). */
function addAlbum(title: string, releases: ReleaseDef[], opts: { selected?: number; anyReleaseOk?: boolean; year?: number } = {}): AlbumHandle {
  const year = opts.year ?? 2001;
  const album = db
    .insert(albums)
    .values({
      artistId,
      mbReleaseGroupId: uuid(),
      title,
      cleanTitle: title.toLowerCase().replace(/[^a-z0-9]/g, ''),
      primaryType: 'Album',
      secondaryTypes: [],
      releaseDate: `${year}-05-01`,
      year,
      genres: [],
      images: [],
      ratings: {},
      monitored: true,
      anyReleaseOk: opts.anyReleaseOk ?? true,
      added: NOW,
    })
    .returning()
    .get();
  const releaseRowIds = releases.map(
    (r) =>
      db
        .insert(albumReleases)
        .values({
          albumId: album.id,
          mbReleaseId: r.mbid,
          title: r.title,
          status: 'Official',
          labels: [],
          formats: r.discs.map(() => 'CD'),
          mediumCount: r.discs.length,
          trackCount: r.discs.flat().length,
          media: r.discs.map((d, i) => ({ position: i + 1, format: 'CD', trackCount: d.length })),
        })
        .returning()
        .get().id,
  );
  const selected = releases[opts.selected ?? 0]!;
  music.selectRelease(db, album.id, mbRelease(selected), ARTIST);
  return { id: album.id, title, releases, releaseRowIds };
}

function albumTracks(albumId: number) {
  const album = db.select().from(albums).where(eq(albums.id, albumId)).get()!;
  return db
    .select()
    .from(tracks)
    .where(eq(tracks.albumReleaseId, album.selectedReleaseId!))
    .all()
    .sort((a, b) => a.mediumNumber - b.mediumNumber || a.trackNumber - b.trackNumber);
}

// ---- file helpers -------------------------------------------------------------------------

async function put(path: string, bytes: Uint8Array | string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

/** Writes an album's tracks as tagged files: `01 - Title.ext`, discs in `CD1/`... when `discFolders`. */
async function writeAlbum(
  folder: string,
  albumTitle: string,
  r: ReleaseDef,
  opts: { format?: 'flac' | 'mp3'; discFolders?: boolean; only?: (disc: number, index: number) => boolean; tags?: FixtureTags } = {},
): Promise<string[]> {
  const out: string[] = [];
  const ext = opts.format ?? 'flac';
  for (const [d, disc] of r.discs.entries()) {
    for (const [i, t] of disc.entries()) {
      if (opts.only && !opts.only(d + 1, i + 1)) continue;
      const tags: FixtureTags = { album: albumTitle, albumArtist: ARTIST, artist: ARTIST, title: t.title, trackNo: i + 1, discNo: d + 1, discOf: r.discs.length, ...opts.tags };
      const name = `${String(i + 1).padStart(2, '0')} - ${t.title}.${ext}`;
      const path = opts.discFolders ? join(folder, `CD${d + 1}`, name) : join(folder, r.discs.length > 1 ? `${d + 1}-${name}` : name);
      const bytes = ext === 'flac' ? buildFlac({ durationMs: t.ms, tags }) : buildMp3({ durationMs: t.ms, tags });
      out.push(await put(path, bytes));
    }
  }
  return out;
}

async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(d, e.name), `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
    }
  };
  await walk(dir, '');
  return out.sort();
}

const exists = (p: string) => stat(p).then(() => true, () => false);

function tracked(overrides: Partial<TrackedDownload> & { id: number; title: string; outputPath: string }): TrackedDownload {
  return fake.add({
    downloadId: `hash${overrides.id}`,
    downloadClientId: 1,
    downloadClientName: 'qbit',
    status: 'completed',
    trackedStatus: 'ok',
    statusMessages: [],
    protocol: 'torrent',
    sizeBytes: 100,
    sizeLeftBytes: 0,
    progress: 1,
    added: '2026-10-01T00:00:00.000Z',
    trackedState: 'importPending',
    canMoveFiles: false,
    canBeRemoved: true,
    isReadOnly: false,
    grabbedRelease: null,
    mediaType: 'music',
    artistId,
    ...overrides,
  });
}

function service(deps: ImportsDeps = {}, dbOverride?: Db) {
  return new ImportsService({ db: dbOverride ?? db, bus, downloadClients: fake, deps, now: () => new Date(NOW) });
}

function setMedia(values: Partial<MediaManagementSettings>) {
  setSection(db, 'mediaManagement', { ...getSection(db, 'mediaManagement'), ...values });
}

function setNaming(values: Partial<NamingConfig>) {
  setSection(db, 'naming', { ...getSection(db, 'naming'), ...values });
}

async function seed(target: Db) {
  db = target;
  const profiles = new ProfilesService({ db });
  const profile = profiles.createQualityProfile({
    name: 'Lossless',
    upgradeAllowed: true,
    cutoff: QUALITIES['FLAC-24bit'].id,
    items: buildItems(['MP3-320', 'FLAC', 'FLAC-24bit'], 'music'),
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
    mediaDomain: 'music',
  });
  artistPath = join(musicRoot, ARTIST);
  artistId = db
    .insert(artists)
    .values({
      mbArtistId: uuid(),
      name: ARTIST,
      sortName: ARTIST,
      cleanName: 'fixtureartist',
      genres: [],
      images: [{ coverType: 'poster', url: 'https://img.example/artist.jpg' }],
      links: [],
      aliases: [],
      path: artistPath,
      rootFolderPath: musicRoot,
      qualityProfileId: profile.id,
      albumTypeProfileId: music.defaultAlbumTypeProfile(db).id,
      monitored: true,
      tags: [],
      added: NOW,
    })
    .returning()
    .get().id;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-music-import-'));
  musicRoot = join(tmp, 'music');
  downloads = join(tmp, 'downloads');
  bin = join(tmp, 'recycle');
  for (const d of [musicRoot, downloads]) await mkdir(d, { recursive: true });
  await writeFile(join(musicRoot, '.keep'), '');
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  fake = new FakeDownloads();
  await seed(await createTestDb());
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const FIRST = tracksOf(['Opening', 'Middle Part', 'Closing Time']);

// ---------------------------------------------------------------------------------------

describe('music import of a completed download', () => {
  it('imports a full album with hard links, writes audio_files and links the tracks', async () => {
    const std = release('First Record', FIRST);
    const album = addAlbum('First Record', [std]);
    const src = join(downloads, 'Fixture Artist - First Record (2001) [FLAC]');
    const files = await writeAlbum(src, 'First Record', std);
    await put(join(src, 'cover.jpg'), 'jpeg');
    const recorded: AudioImportedEvent[] = [];
    const notified: AudioImportedEvent[] = [];
    const refreshed: Array<{ path: string; mediaType: string }> = [];
    const svc = service({
      history: { recordImport: () => undefined, recordAudioImport: (e) => void recorded.push(e) },
      notifications: { onImported: () => undefined, onAudioImported: (e) => void notified.push(e) },
      mediaServers: { refreshPath: (input) => void refreshed.push(input) },
    });
    const item = tracked({ id: 1, title: 'Fixture Artist - First Record (2001) [FLAC]', outputPath: src, albumIds: [album.id] });

    const result = await svc.importCompletedDownload(item);

    expect(result.verified).toBe(true);
    expect(fake.imported).toEqual([1]);
    const albumFolder = join(artistPath, 'First Record (2001)');
    // Rename is off by default: original names under the built album folder.
    expect(await listTree(albumFolder)).toEqual(['01 - Opening.flac', '02 - Middle Part.flac', '03 - Closing Time.flac', 'cover.jpg']);
    // Hard links: same file, source still seeding.
    const a = await stat(files[0]!);
    const b = await stat(join(albumFolder, '01 - Opening.flac'));
    expect(b.ino).toBe(a.ino);
    expect(b.nlink).toBe(2);
    expect(await exists(files[0]!)).toBe(true);

    const rows = db.select().from(audioFiles).all();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.mediaType === 'music' && r.artistId === artistId && r.albumId === album.id)).toBe(true);
    expect(rows[0]!.quality.quality.name).toBe('FLAC');
    expect(rows[0]!.codec).toMatch(/flac/i);
    expect(rows[0]!.sampleRateHz).toBe(44100);
    expect(rows[0]!.bitDepth).toBe(16);
    expect(rows[0]!.durationMs).toBeGreaterThan(0);
    expect(rows[0]!.tags?.album).toBe('First Record');
    const t = albumTracks(album.id);
    expect(t.every((x) => x.hasFile && x.audioFileId !== null)).toBe(true);
    // Statistics reflect the files at once.
    expect(albumStatistics(db, [album.id]).get(album.id)).toMatchObject({ trackCount: 3, trackFileCount: 3, percentOfTracks: 100 });

    // One event per album, everywhere.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ mediaType: 'music', artistId, albumId: album.id, albumIds: [album.id], importMode: 'hardlink', isUpgrade: false, incomplete: false, manual: false });
    expect(recorded[0]!.files).toHaveLength(3);
    expect(notified).toHaveLength(1);
    await vi.waitFor(() => expect(refreshed).toEqual([{ path: albumFolder, mediaType: 'music', updateType: 'Created' }]));
    expect(events).toContainEqual({ type: 'import', action: 'imported', title: 'Fixture Artist – First Record', mediaType: 'music', mediaId: artistId, albumIds: [album.id] });
    const imported = db.select().from(importedDownloads).all();
    expect(imported).toHaveLength(3);
    expect(imported[0]).toMatchObject({ mediaType: 'music', artistId, albumIds: [album.id], downloadId: 'hash1' });
  });

  it('copies instead of linking when hard links are off', async () => {
    setMedia({ useHardlinks: false });
    const std = release('First Record', FIRST);
    const album = addAlbum('First Record', [std]);
    const src = join(downloads, 'First Record');
    const files = await writeAlbum(src, 'First Record', std);
    const recorded: AudioImportedEvent[] = [];
    const result = await service({ history: { recordImport: () => undefined, recordAudioImport: (e) => void recorded.push(e) } }).importCompletedDownload(
      tracked({ id: 2, title: 'Fixture Artist - First Record', outputPath: src, albumIds: [album.id] }),
    );
    expect(result.verified).toBe(true);
    const copy = await stat(join(artistPath, 'First Record (2001)', '01 - Opening.flac'));
    expect(copy.nlink).toBe(1);
    expect(copy.ino).not.toBe((await stat(files[0]!)).ino);
    expect(recorded[0]!.importMode).toBe('copy');
  });

  it('moves the files when the client allows it and cleans up the emptied folder', async () => {
    const std = release('First Record', FIRST);
    const album = addAlbum('First Record', [std]);
    const src = join(downloads, 'First Record');
    await writeAlbum(src, 'First Record', std);
    const result = await service().importCompletedDownload(tracked({ id: 3, title: 'First Record', outputPath: src, albumIds: [album.id], canMoveFiles: true }));
    expect(result.verified).toBe(true);
    expect(await exists(src)).toBe(false);
    expect(await listTree(join(artistPath, 'First Record (2001)'))).toHaveLength(3);
  });

  it('imports a multi-disc album, keeping disc folders with rename off and prefixing with rename on', async () => {
    const two = release('Double', tracksOf(['Side One', 'Side Two']), tracksOf(['Side Three', 'Side Four'], 3000));
    const album = addAlbum('Double Record', [two], { year: 2005 });
    const src = join(downloads, 'Double Record');
    await writeAlbum(src, 'Double Record', two, { discFolders: true });

    const result = await service().importCompletedDownload(tracked({ id: 4, title: 'Fixture Artist - Double Record', outputPath: src, albumIds: [album.id] }));
    expect(result.verified).toBe(true);
    expect(await listTree(join(artistPath, 'Double Record (2005)'))).toEqual([
      'CD1/01 - Side One.flac',
      'CD1/02 - Side Two.flac',
      'CD2/01 - Side Three.flac',
      'CD2/02 - Side Four.flac',
    ]);
    const t = albumTracks(album.id);
    expect(t.map((x) => [x.mediumNumber, x.trackNumber, x.hasFile])).toEqual([
      [1, 1, true],
      [1, 2, true],
      [2, 1, true],
      [2, 2, true],
    ]);

    // Rename on: `{medium:0}-{track:00} - {Track Title}` in the album folder.
    await rm(artistPath, { recursive: true, force: true });
    db.delete(audioFiles).run();
    db.update(tracks).set({ hasFile: false, audioFileId: null }).run();
    db.delete(importedDownloads).run();
    setNaming({ renameTracks: true });
    const again = await service().importCompletedDownload(tracked({ id: 5, title: 'Fixture Artist - Double Record', outputPath: src, albumIds: [album.id] }));
    expect(again.verified).toBe(true);
    expect(await listTree(join(artistPath, 'Double Record (2005)'))).toEqual([
      '1-01 - Side One.flac',
      '1-02 - Side Two.flac',
      '2-01 - Side Three.flac',
      '2-02 - Side Four.flac',
    ]);
  });

  it('accepts an incomplete album with a warning; the album stays wanted', async () => {
    const std = release('First Record', FIRST);
    const album = addAlbum('First Record', [std], { anyReleaseOk: false });
    const src = join(downloads, 'First Record');
    await writeAlbum(src, 'First Record', std, { only: (_d, i) => i !== 3 });
    const recorded: AudioImportedEvent[] = [];
    const result = await service({ history: { recordImport: () => undefined, recordAudioImport: (e) => void recorded.push(e) } }).importCompletedDownload(
      tracked({ id: 6, title: 'First Record', outputPath: src, albumIds: [album.id] }),
    );
    expect(result.verified).toBe(true);
    expect(result.outcomes.filter((o) => o.status === 'imported')).toHaveLength(2);
    expect(result.outcomes[0]!.warnings?.[0]).toMatch(/1 of 3 tracks are missing; the album stays wanted/);
    expect(recorded[0]!.incomplete).toBe(true);
    expect(albumStatistics(db, [album.id]).get(album.id)).toMatchObject({ trackCount: 3, trackFileCount: 2 });
    const wanted = music.listMissingAlbums(db, { page: 1, pageSize: 10, sortKey: 'releaseDate', sortDirection: 'descending' } as never, new Date(NOW));
    expect(wanted.records.map((r) => r.id)).toContain(album.id);
  });

  it('switches to the deluxe edition when the files fit it (anyReleaseOk)', async () => {
    const std = release('First Record', FIRST);
    const dlx = release('First Record (Deluxe)', [...FIRST, ...tracksOf(['Bonus Demo', 'Hidden Track'], 4000)]);
    const album = addAlbum('First Record', [std, dlx], { selected: 0 });
    const src = join(downloads, 'First Record Deluxe');
    await writeAlbum(src, 'First Record', dlx);
    const loads: string[] = [];
    const svc = service({
      musicReleases: {
        getRelease: async (mbid) => {
          loads.push(mbid);
          return mbRelease([std, dlx].find((r) => r.mbid === mbid)!);
        },
      },
    });
    const result = await svc.importCompletedDownload(tracked({ id: 7, title: 'Fixture Artist - First Record (Deluxe)', outputPath: src, albumIds: [album.id] }));
    expect(result.verified).toBe(true);
    expect(loads).toEqual([dlx.mbid]);
    const row = db.select().from(albums).where(eq(albums.id, album.id)).get()!;
    expect(row.selectedReleaseId).toBe(album.releaseRowIds[1]);
    const t = albumTracks(album.id);
    expect(t).toHaveLength(5);
    expect(t.every((x) => x.hasFile)).toBe(true);

    // The other way round: a standard rip onto a deluxe selection switches back to standard.
    const album2 = addAlbum('Second Record', [release('Second Record (Deluxe)', [...tracksOf(['Alpha', 'Beta', 'Gamma']), ...tracksOf(['Delta Demo'], 3000)]), release('Second Record', tracksOf(['Alpha', 'Beta', 'Gamma']))], { selected: 0 });
    const src2 = join(downloads, 'Second Record');
    await writeAlbum(src2, 'Second Record', album2.releases[1]!);
    const svc2 = service({ musicReleases: { getRelease: async (mbid) => mbRelease(album2.releases.find((r) => r.mbid === mbid)!) } });
    const r2 = await svc2.importCompletedDownload(tracked({ id: 8, title: 'Second Record', outputPath: src2, albumIds: [album2.id] }));
    expect(r2.verified).toBe(true);
    expect(db.select().from(albums).where(eq(albums.id, album2.id)).get()!.selectedReleaseId).toBe(album2.releaseRowIds[1]);
    expect(albumStatistics(db, [album2.id]).get(album2.id)).toMatchObject({ trackCount: 3, trackFileCount: 3 });
  });

  it('keeps the selected edition without anyReleaseOk and reports what did not fit', async () => {
    const std = release('First Record', FIRST);
    const dlx = release('First Record (Deluxe)', [...FIRST, ...tracksOf(['Bonus Demo', 'Hidden Track'], 4000)]);
    const album = addAlbum('First Record', [std, dlx], { selected: 0, anyReleaseOk: false });
    const src = join(downloads, 'First Record Deluxe');
    await writeAlbum(src, 'First Record', dlx);
    const loader = vi.fn(async (mbid: string) => mbRelease([std, dlx].find((r) => r.mbid === mbid)!));
    const result = await service({ musicReleases: { getRelease: loader } }).importCompletedDownload(
      tracked({ id: 9, title: 'First Record (Deluxe)', outputPath: src, albumIds: [album.id] }),
    );
    expect(loader).not.toHaveBeenCalled();
    expect(db.select().from(albums).where(eq(albums.id, album.id)).get()!.selectedReleaseId).toBe(album.releaseRowIds[0]);
    // 3 of 5 files fit the standard edition: below the match threshold, so nothing is imported.
    expect(result.verified).toBe(false);
    expect(result.messages[0]!.messages.join('\n')).toMatch(/No album matched well enough/);
    expect(fake.items.get(9)!.trackedState).toBe('importPending');
  });

  it('upgrades lower-quality tracks, recycling the old files; equal quality is not an upgrade', async () => {
    setMedia({ recycleBinPath: bin });
    const std = release('First Record', FIRST);
    const album = addAlbum('First Record', [std]);
    const mp3 = join(downloads, 'First Record [MP3]');
    await writeAlbum(mp3, 'First Record', std, { format: 'mp3' });
    expect((await service().importCompletedDownload(tracked({ id: 10, title: 'First Record [MP3]', outputPath: mp3, albumIds: [album.id] }))).verified).toBe(true);
    const before = db.select().from(audioFiles).all();
    expect(before.map((r) => extnameOf(r.path))).toEqual(['.mp3', '.mp3', '.mp3']);

    const flac = join(downloads, 'First Record [FLAC]');
    await writeAlbum(flac, 'First Record', std);
    const recorded: AudioImportedEvent[] = [];
    const result = await service({ history: { recordImport: () => undefined, recordAudioImport: (e) => void recorded.push(e) } }).importCompletedDownload(
      tracked({ id: 11, title: 'First Record [FLAC]', outputPath: flac, albumIds: [album.id] }),
    );
    expect(result.verified).toBe(true);
    const after = db.select().from(audioFiles).all();
    expect(after.map((r) => extnameOf(r.path))).toEqual(['.flac', '.flac', '.flac']);
    expect(after.every((r) => r.quality.quality.name === 'FLAC')).toBe(true);
    expect(albumTracks(album.id).map((t) => t.audioFileId).sort()).toEqual(after.map((r) => r.id).sort());
    expect(await listTree(join(artistPath, 'First Record (2001)'))).toEqual(['01 - Opening.flac', '02 - Middle Part.flac', '03 - Closing Time.flac']);
    expect((await listTree(bin)).map((p) => basename(p))).toEqual(['01 - Opening.mp3', '02 - Middle Part.mp3', '03 - Closing Time.mp3']);
    expect(recorded[0]!.isUpgrade).toBe(true);
    expect(recorded[0]!.replacedFiles.map((f) => f.id).sort()).toEqual(before.map((r) => r.id).sort());

    // The same FLAC again (another download): not strictly better, so rejected.
    const again = join(downloads, 'First Record [FLAC] again');
    await writeAlbum(again, 'First Record', std);
    const rejected = await service().importCompletedDownload(tracked({ id: 12, title: 'First Record [FLAC]', outputPath: again, albumIds: [album.id] }));
    expect(rejected.verified).toBe(false);
    expect(rejected.outcomes.every((o) => o.status === 'rejected' && o.rejections[0]!.reason === 'notQualityUpgrade')).toBe(true);
  });

  it('imports every album a discography pack matches, and only those', async () => {
    const r1 = release('First Record', FIRST);
    const r2 = release('Second Record', tracksOf(['Alpha', 'Beta', 'Gamma'], 2000));
    const a1 = addAlbum('First Record', [r1], { year: 2001 });
    const a2 = addAlbum('Second Record', [r2], { year: 2004 });
    const a3 = addAlbum('Third Record', [release('Third Record', tracksOf(['Never', 'Ripped'], 5000))], { year: 2009 });
    const src = join(downloads, 'Fixture Artist - Discography (2001-2004) [FLAC]');
    await writeAlbum(join(src, '2001 - First Record'), 'First Record', r1);
    await writeAlbum(join(src, '2004 - Second Record'), 'Second Record', r2);
    // A bootleg the catalogue does not know.
    await put(join(src, 'Live Bootleg', '01 - Jam.flac'), buildFlac({ durationMs: 1500, tags: { album: 'Live Bootleg', title: 'Jam', trackNo: 1 } }));
    const recorded: AudioImportedEvent[] = [];
    const result = await service({ history: { recordImport: () => undefined, recordAudioImport: (e) => void recorded.push(e) } }).importCompletedDownload(
      tracked({ id: 13, title: 'Fixture Artist - Discography (2001-2004) [FLAC]', outputPath: src, albumIds: [a1.id, a2.id] }),
    );
    expect(result.verified).toBe(true);
    expect(recorded.map((e) => e.albumId).sort()).toEqual([a1.id, a2.id].sort());
    expect(await listTree(artistPath)).toEqual([
      'First Record (2001)/01 - Opening.flac',
      'First Record (2001)/02 - Middle Part.flac',
      'First Record (2001)/03 - Closing Time.flac',
      'Second Record (2004)/01 - Alpha.flac',
      'Second Record (2004)/02 - Beta.flac',
      'Second Record (2004)/03 - Gamma.flac',
    ]);
    expect(albumStatistics(db, [a3.id]).get(a3.id)!.trackFileCount).toBe(0);
    expect(result.outcomes.find((o) => o.path.endsWith('01 - Jam.flac'))).toMatchObject({ status: 'rejected' });
  });

  it('sends a cue image to manual import', async () => {
    const std = release('First Record', FIRST);
    const album = addAlbum('First Record', [std]);
    const src = join(downloads, 'First Record [FLAC Image]');
    await put(join(src, 'Fixture Artist - First Record.flac'), buildFlac({ durationMs: 4500, tags: { album: 'First Record', albumArtist: ARTIST, title: 'First Record' } }));
    await put(join(src, 'Fixture Artist - First Record.cue'), 'FILE "Fixture Artist - First Record.flac" WAVE\n  TRACK 01 AUDIO\n');
    const result = await service().importCompletedDownload(tracked({ id: 14, title: 'First Record [FLAC Image]', outputPath: src, albumIds: [album.id] }));
    expect(result.verified).toBe(false);
    expect(result.outcomes[0]!.rejections[0]!.reason).toBe('cueImage');
    expect(result.messages[0]!.messages.join('\n')).toMatch(/Manual Import required/);
    expect(fake.items.get(14)).toMatchObject({ trackedState: 'importPending', trackedStatus: 'warning' });
    expect(events.some((e) => e.type === 'import' && e.action === 'manualRequired' && e.mediaType === 'music')).toBe(true);
    // Not retried on a schedule: it needs the user.
    expect(await service().retryPendingImports()).toBe(0);

    const items = await service().listAudioManualImport({ folder: src, artistId, filterExistingFiles: true });
    expect(items).toHaveLength(1);
    expect(items[0]!.rejections[0]!.reason).toBe('cueImage');
  });

  it('imports extras (cue, log, cover, lyrics) and renames lyrics with the track', async () => {
    setNaming({ renameTracks: true });
    const std = release('First Record', FIRST);
    const album = addAlbum('First Record', [std]);
    const src = join(downloads, 'First Record (2001) [FLAC]');
    await writeAlbum(src, 'First Record', std);
    await put(join(src, 'First Record.cue'), 'REM cue');
    await put(join(src, 'First Record.log'), 'EAC log');
    await put(join(src, 'folder.jpg'), 'jpeg');
    await put(join(src, '02 - Middle Part.lrc'), '[00:00.00] la');
    await put(join(src, 'notes.nfo'), 'nfo');
    const result = await service().importCompletedDownload(tracked({ id: 15, title: 'First Record', outputPath: src, albumIds: [album.id] }));
    expect(result.verified).toBe(true);
    expect(await listTree(join(artistPath, 'First Record (2001)'))).toEqual([
      '01 - Opening.flac',
      '02 - Middle Part.flac',
      '02 - Middle Part.lrc',
      '03 - Closing Time.flac',
      'First Record.cue',
      'First Record.log',
      'folder.jpg',
    ]);
  });

  it('renames tracks with the organizer when renameTracks is on', async () => {
    setNaming({ renameTracks: true, trackFormat: '{track:00}. {Artist Name} - {Track Title}', albumFolderFormat: '{Release Year} - {Album Title}' });
    const std = release('First Record', FIRST);
    const album = addAlbum('First Record', [std]);
    const src = join(downloads, 'fr');
    await writeAlbum(src, 'First Record', std);
    const result = await service().importCompletedDownload(tracked({ id: 16, title: 'First Record', outputPath: src, albumIds: [album.id] }));
    expect(result.verified).toBe(true);
    expect(await listTree(join(artistPath, '2001 - First Record'))).toEqual([
      '01. Fixture Artist - Opening.flac',
      '02. Fixture Artist - Middle Part.flac',
      '03. Fixture Artist - Closing Time.flac',
    ]);
  });

  it('asks for manual import when the artist is unknown', async () => {
    const src = join(downloads, 'Somebody Else - Record');
    await writeAlbum(src, 'Record', release('Record', FIRST), { tags: { albumArtist: 'Somebody Else' } });
    const result = await service().importCompletedDownload(tracked({ id: 17, title: 'Somebody Else - Record', outputPath: src, artistId: undefined }));
    expect(result.verified).toBe(false);
    expect(result.messages[0]!.messages[0]).toMatch(/Artist title mismatch/);
  });
});

function extnameOf(p: string): string {
  return p.slice(p.lastIndexOf('.'));
}

// ---------------------------------------------------------------------------------------

describe('manual import, audio mode', () => {
  function routes(svc: ImportsService) {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    void app.register(importsRoutes(svc));
    return app;
  }

  it('proposes artist, album, edition and tracks with confidence, then imports the adjusted mapping', async () => {
    const std = release('First Record', FIRST);
    const album = addAlbum('First Record', [std]);
    const folder = join(downloads, 'some rip');
    // Track 3 is badly tagged: proposed with a low score; the user maps it by hand.
    await writeAlbum(folder, 'First Record', std, { only: (_d, i) => i < 3 });
    await put(join(folder, 'track3.flac'), buildFlac({ durationMs: 2000, tags: {} }));
    const svc = service();
    const app = routes(svc);

    const res = await app.inject({ method: 'GET', url: `/manualimport/audio?folder=${encodeURIComponent(folder)}` });
    expect(res.statusCode).toBe(200);
    const items = res.json<AudioManualImportItem[]>();
    expect(items).toHaveLength(3);
    const t = albumTracks(album.id);
    const good = items.filter((i) => i.trackIds);
    expect(good.length).toBeGreaterThanOrEqual(2);
    for (const i of items) {
      expect(i).toMatchObject({ mediaType: 'music', artistId, albumId: album.id });
      expect(i.confidence).toBeGreaterThan(0);
    }
    const opening = items.find((i) => i.name === '01 - Opening.flac')!;
    expect(opening).toMatchObject({ trackIds: [t[0]!.id], albumReleaseId: t[0]!.albumReleaseId, mediumNumber: 1, trackNumber: 1, trackTitle: 'Opening', rejections: [] });
    expect(opening.tags).toMatchObject({ title: 'Opening', album: 'First Record', trackNo: 1 });
    expect(opening.quality.quality.name).toBe('FLAC');

    const body = {
      items: items.map((i) => ({
        path: i.path,
        artistId,
        albumId: album.id,
        trackIds: [i.name === 'track3.flac' ? t[2]!.id : i.trackIds![0]!],
      })),
      importMode: 'copy',
    };
    const done = await app.inject({ method: 'POST', url: '/manualimport/audio', payload: body });
    expect(done.statusCode).toBe(200);
    const result = done.json<AudioManualImportResult>();
    expect(result.failed).toEqual([]);
    expect(result.imported).toHaveLength(3);
    expect(albumTracks(album.id).every((x) => x.hasFile)).toBe(true);
    expect(await listTree(join(artistPath, 'First Record (2001)'))).toEqual(['01 - Opening.flac', '02 - Middle Part.flac', 'track3.flac']);
    expect(await exists(join(folder, 'track3.flac'))).toBe(true);

    // Already imported files are filtered from the next proposal.
    const next = await app.inject({ method: 'GET', url: `/manualimport/audio?folder=${encodeURIComponent(join(artistPath, 'First Record (2001)'))}&artistId=${artistId}` });
    expect(next.json<AudioManualImportItem[]>()).toEqual([]);
  });

  it('validates the mapping and marks the tracked download imported once its albums have files', async () => {
    const std = release('First Record', FIRST);
    const album = addAlbum('First Record', [std]);
    const other = addAlbum('Other Record', [release('Other Record', tracksOf(['X', 'Y']))]);
    const folder = join(downloads, 'dl');
    const files = await writeAlbum(folder, 'First Record', std);
    const item = tracked({ id: 20, title: 'First Record', outputPath: folder, albumIds: [album.id] });
    const t = albumTracks(album.id);
    const svc = service();
    const proposal = await svc.listAudioManualImport({ downloadId: item.downloadId, filterExistingFiles: true });
    expect(proposal.every((p) => p.downloadId === item.downloadId && p.albumId === album.id)).toBe(true);

    const result = await svc.executeAudioManualImport({
      importMode: 'auto',
      items: [
        { path: files[0]!, mediaType: 'music', artistId, albumId: album.id, trackIds: [t[0]!.id], downloadId: item.downloadId },
        { path: files[1]!, mediaType: 'music', artistId, albumId: album.id, trackIds: [t[0]!.id], downloadId: item.downloadId },
        { path: files[2]!, mediaType: 'music', artistId, albumId: album.id, trackIds: [albumTracks(other.id)[0]!.id], downloadId: item.downloadId },
      ],
    });
    expect(result.imported.map((i) => i.trackId)).toEqual([t[0]!.id]);
    expect(result.failed.map((f) => f.error)).toEqual([expect.stringMatching(/already mapped/), expect.stringMatching(/not a track of the selected edition/)]);
    expect(fake.imported).toEqual([20]);
    // Auto mode copies when the client may not move (hard link here).
    expect(await exists(files[0]!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------

describe('import wiring for music (history, notifications, media-server refresh)', () => {
  const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

  it('records history with a music target, dispatches an Artist – Album notification and refreshes the album folder', async () => {
    const appDb = await createTestDb();
    let ctxRef: AppContext | undefined;
    const app = await buildApp(config, appDb, pino({ level: 'silent' }), { probe: false, onContext: (ctx) => void (ctxRef = ctx) });
    await app.ready();
    try {
      const ctx = ctxRef!;
      await seed(appDb);
      const std = release('First Record', FIRST);
      const album = addAlbum('First Record', [std]);
      const src = join(downloads, 'Fixture Artist - First Record [FLAC]');
      await writeAlbum(src, 'First Record', std);

      const recordImport = vi.spyOn(historyServiceFor(ctx), 'recordImport').mockReturnValue([]);
      const dispatch = vi.spyOn(notificationsServiceFor(ctx), 'dispatch').mockResolvedValue(undefined as never);
      const refreshPath = vi.spyOn(mediaServersServiceFor(ctx), 'refreshPath').mockResolvedValue([]);

      const svc = service(importsDeps(ctx), appDb);
      const result = await svc.importCompletedDownload(tracked({ id: 30, title: 'Fixture Artist - First Record [FLAC]', outputPath: src, albumIds: [album.id] }));
      expect(result.verified).toBe(true);
      const albumFolder = join(artistPath, 'First Record (2001)');

      expect(recordImport).toHaveBeenCalledTimes(1);
      expect(recordImport.mock.calls[0]![0]).toMatchObject({
        target: { mediaType: 'music', artistId, albumIds: [album.id] },
        importedPath: albumFolder,
        droppedPath: src,
        downloadId: 'hash30',
      });
      expect(recordImport.mock.calls[0]![0].quality.quality.name).toBe('FLAC');

      expect(dispatch).toHaveBeenCalledTimes(1);
      const notification = dispatch.mock.calls[0]![0] as unknown as Record<string, unknown>;
      expect(notification).toMatchObject({
        type: 'import',
        media: { id: artistId, mediaType: 'music', title: ARTIST, tmdbId: 0, images: [{ coverType: 'poster', url: 'https://img.example/artist.jpg' }] },
        artist: { id: artistId, name: ARTIST },
        album: { id: album.id, title: 'First Record', albumType: 'Album', path: albumFolder },
        file: { path: albumFolder, relativePath: 'First Record (2001)', quality: 'FLAC' },
      });
      expect((notification['tracks'] as unknown[]).length).toBe(3);

      await vi.waitFor(() => expect(refreshPath).toHaveBeenCalledWith({ path: albumFolder, mediaType: 'music', updateType: 'Created' }));
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  });
});
