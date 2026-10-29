import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildItems } from '@arclight/profiles-engine';
import {
  QUALITIES,
  type AudiobookManualImportItem,
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
import { audioFiles, authors, books, bookSeries, bookSeriesEntries, importedDownloads } from '../../../db/schema.js';
import { createTestDb } from '../../../db/test-utils.js';
import { EventBus } from '../../../events.js';
import { historyServiceFor } from '../../history/index.js';
import { mediaServersServiceFor } from '../../media-servers/index.js';
import { notificationsServiceFor } from '../../notifications/index.js';
import { ProfilesService } from '../../profiles/index.js';
import { getSection, setSection } from '../../settings/service.js';
import { importsDeps } from '../../../wiring.js';
import type { TrackedDownload } from '../../download-clients/index.js';
import type { AudiobookImportedEvent, ImportsDeps } from '../deps.js';
import { importsRoutes } from '../routes.js';
import { ImportsService, type DownloadClientsPort } from '../service.js';
import { bookFolderOf, durationMismatchSpec, narratorWarning, onePerPart, orderParts } from './audiobook-import.js';
import { buildMp3, buildMp4, type FixtureChapter, type FixtureTags } from './fixtures/builders.js';

// The audiobook importer end to end over temp folders of tiny silent tagged files (a minute of
// audio stands in for a book's runtime) and a test database seeded with an author and books the
// way the audiobook refresher writes them.

const NOW = '2026-10-20T12:00:00.000Z';
const AUTHOR = 'Fixture Author';

let tmp: string;
let bookRoot: string;
let authorPath: string;
let downloads: string;
let bin: string;
let db: Db;
let bus: EventBus;
let events: ServerEvent[];
let fake: FakeDownloads;
let authorId: number;

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

interface BookOpts {
  asin?: string;
  runtimeMinutes?: number | null;
  narrators?: string[];
  series?: { name: string; position: string };
  overview?: string;
  cover?: string;
}

function addBook(title: string, o: BookOpts = {}) {
  const book = db
    .insert(books)
    .values({
      authorId,
      asin: o.asin ?? null,
      title,
      sortTitle: title.toLowerCase(),
      cleanTitle: title.toLowerCase().replace(/[^a-z0-9]/g, ''),
      authorCredits: [{ name: AUTHOR }],
      narrators: o.narrators ?? ['Fixture Narrator'],
      releaseDate: '2020-01-01',
      year: 2020,
      runtimeMinutes: o.runtimeMinutes === undefined ? 1 : o.runtimeMinutes,
      formatType: 'unabridged',
      overview: o.overview ?? '',
      genres: [],
      images: o.cover ? [{ coverType: 'cover', url: o.cover }] : [],
      chapters: [],
      ratings: {},
      monitored: true,
      added: NOW,
    })
    .returning()
    .get();
  if (o.series) {
    const series = db.insert(bookSeries).values({ name: o.series.name, cleanName: o.series.name.toLowerCase().replace(/[^a-z0-9]/g, '') }).returning().get();
    db.insert(bookSeriesEntries).values({ seriesId: series.id, bookId: book.id, position: o.series.position, positionSort: Number(o.series.position), isPrimary: true }).run();
  }
  return book;
}

const bookRow = (id: number) => db.select().from(books).where(eq(books.id, id)).get()!;
const bookFiles = (id: number) =>
  db
    .select()
    .from(audioFiles)
    .where(eq(audioFiles.bookId, id))
    .all()
    .sort((a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0));

// ---- file helpers -------------------------------------------------------------------------

async function put(path: string, bytes: Uint8Array | string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

const bookTags = (title: string, extra: FixtureTags = {}): FixtureTags => ({ title, album: title, artist: AUTHOR, albumArtist: AUTHOR, narrator: 'Fixture Narrator', ...extra });

const CHAPTERS: FixtureChapter[] = [
  { title: 'Opening', startMs: 0 },
  { title: 'Middle', startMs: 20_000 },
  { title: 'Ending', startMs: 40_000 },
];

function m4b(title: string, durationMs = 60_000, tags: FixtureTags = {}): Uint8Array {
  return buildMp4({ brand: 'M4B ', durationMs, tags: bookTags(title, tags), chapters: CHAPTERS });
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
    mediaType: 'audiobook',
    authorId,
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

function setAudio(values: Partial<ReturnType<typeof getSection<'audio'>>>) {
  setSection(db, 'audio', { ...getSection(db, 'audio'), ...values });
}

function hooks() {
  const recorded: AudiobookImportedEvent[] = [];
  const notified: AudiobookImportedEvent[] = [];
  const refreshed: Array<{ path: string; mediaType: string; updateType?: string }> = [];
  const deps: ImportsDeps = {
    history: { recordImport: () => undefined, recordAudiobookImport: (e) => void recorded.push(e) },
    notifications: { onImported: () => undefined, onAudiobookImported: (e) => void notified.push(e) },
    mediaServers: { refreshPath: (input) => void refreshed.push(input) },
  };
  return { deps, recorded, notified, refreshed };
}

async function seed(target: Db) {
  db = target;
  const profiles = new ProfilesService({ db });
  const profile = profiles.createQualityProfile({
    name: 'Spoken',
    upgradeAllowed: true,
    cutoff: QUALITIES['AB-AAC'].id,
    items: buildItems(['AB-MP3-Low', 'AB-AAC-Low', 'AB-MP3', 'AB-MP3-High', 'AB-AAC'], 'audiobook'),
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
    mediaDomain: 'audiobook',
  });
  authorPath = join(bookRoot, AUTHOR);
  authorId = db
    .insert(authors)
    .values({
      asin: 'B0AUTHOR01',
      name: AUTHOR,
      sortName: 'Author, Fixture',
      cleanName: 'fixtureauthor',
      overview: '',
      images: [{ coverType: 'headshot', url: 'https://img.example/author.jpg' }],
      genres: [],
      aliases: [],
      path: authorPath,
      rootFolderPath: bookRoot,
      qualityProfileId: profile.id,
      monitored: true,
      languages: [],
      tags: [],
      added: NOW,
    })
    .returning()
    .get().id;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-book-import-'));
  bookRoot = join(tmp, 'audiobooks');
  downloads = join(tmp, 'downloads');
  bin = join(tmp, 'recycle');
  for (const d of [bookRoot, downloads]) await mkdir(d, { recursive: true });
  await writeFile(join(bookRoot, '.keep'), '');
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  fake = new FakeDownloads();
  await seed(await createTestDb());
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------

describe('audiobook helpers', () => {
  it('keeps one format per part when a book ships in several (archive mp3 + ogg)', () => {
    const f = (name: string, codec: string | null = null) => ({ path: `/dl/Book/${name}`, tags: codec ? ({ codec, container: null, bitrateKbps: 64 } as never) : null });
    const both = [f('01.mp3'), f('01.ogg'), f('02.mp3'), f('02.ogg')];
    expect(onePerPart(both).map((x) => x.path)).toEqual(['/dl/Book/01.mp3', '/dl/Book/02.mp3']);
    // Different stems are different parts, whatever their formats.
    const mixed = [f('01.mp3'), f('02.ogg')];
    expect(onePerPart(mixed)).toHaveLength(2);
    // The format covering more parts wins over a better container with gaps.
    expect(onePerPart([f('01.m4b'), f('01.mp3'), f('02.mp3')]).map((x) => x.path)).toEqual(['/dl/Book/01.mp3', '/dl/Book/02.mp3']);
  });


  it('orders parts by disc tag, then track tag, then natural file name', () => {
    const f = (relativePath: string, discNo: number | null, trackNo: number | null) => ({
      path: `/d/${relativePath}`,
      relativePath,
      discFromFolder: null,
      tags: { discNo, trackNo } as never,
    });
    const ordered = orderParts([f('Part 10.mp3', null, null), f('Part 2.mp3', null, null), f('b.mp3', 1, 2), f('a.mp3', 2, 1), f('c.mp3', 1, 1)]);
    expect(ordered.map((x) => x.relativePath)).toEqual(['Part 2.mp3', 'Part 10.mp3', 'c.mp3', 'b.mp3', 'a.mp3']);
  });

  it('folds disc and part folders into the book folder', () => {
    expect(bookFolderOf(join('/dl', 'Book', 'CD2', 'x.mp3'))).toBe(join('/dl', 'Book'));
    expect(bookFolderOf(join('/dl', 'Book', 'Part 3', 'x.mp3'))).toBe(join('/dl', 'Book'));
    expect(bookFolderOf(join('/dl', 'Book', 'x.mp3'))).toBe(join('/dl', 'Book'));
  });

  it('checks the duration against the runtime with a tolerance, and warns on another narrator', () => {
    expect(durationMismatchSpec(60_000 * 100, 100, 5)).toBeNull();
    expect(durationMismatchSpec(60_000 * 104, 100, 5)).toBeNull();
    expect(durationMismatchSpec(60_000 * 90, 100, 5)).toMatchObject({ reason: 'durationMismatch', type: 'permanent' });
    expect(durationMismatchSpec(60_000 * 90, 100, 10)).toBeNull();
    expect(durationMismatchSpec(null, 100, 5)).toBeNull();
    expect(durationMismatchSpec(1000, null, 5)).toBeNull();
    expect(narratorWarning('Kate Reading', ['Michael Kramer', 'Kate Reading'], 'X')).toBeNull();
    expect(narratorWarning('Someone Else', ['Michael Kramer'], 'X')).toMatch(/narrated by Someone Else/);
  });
});

describe('audiobook import of a completed download', () => {
  it('imports a single chaptered m4b with a hard link, writes audio_files and marks the book', async () => {
    const book = addBook('A Quiet Book', { asin: 'B000000001' });
    const src = join(downloads, 'Fixture Author - A Quiet Book (2020) [m4b]');
    const file = await put(join(src, 'A Quiet Book.m4b'), m4b('A Quiet Book', 60_000, { asin: 'B000000001' }));
    await put(join(src, 'cover.jpg'), 'jpeg');
    const h = hooks();
    const item = tracked({ id: 1, title: 'Fixture Author - A Quiet Book (2020) [m4b]', outputPath: src, bookIds: [book.id] });

    const result = await service(h.deps).importCompletedDownload(item);

    expect(result.messages).toEqual([]);
    expect(result.verified).toBe(true);
    expect(fake.imported).toEqual([1]);
    const bookFolder = join(authorPath, 'A Quiet Book');
    // Rename is off by default: the single file keeps its name.
    expect(await listTree(bookFolder)).toEqual(['A Quiet Book.m4b', 'cover.jpg']);
    const a = await stat(file);
    const b = await stat(join(bookFolder, 'A Quiet Book.m4b'));
    expect(b.ino).toBe(a.ino);
    expect(b.nlink).toBe(2);

    const rows = bookFiles(book.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mediaType: 'audiobook', authorId, bookId: book.id, artistId: null, albumId: null, partNumber: 1, chapterCount: 3, relativePath: join('A Quiet Book', 'A Quiet Book.m4b') });
    expect(rows[0]!.durationMs).toBeGreaterThan(55_000);
    expect(rows[0]!.quality.quality.name).toMatch(/^AB-AAC/);
    expect(bookRow(book.id)).toMatchObject({ hasFile: true, path: bookFolder });

    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ mediaType: 'audiobook', authorId, bookId: book.id, bookIds: [book.id], bookFolder, importMode: 'hardlink', isUpgrade: false, manual: false, warnings: [] });
    expect(h.notified).toHaveLength(1);
    await vi.waitFor(() => expect(h.refreshed).toEqual([{ path: bookFolder, mediaType: 'audiobook', updateType: 'Created' }]));
    expect(events).toContainEqual({ type: 'import', action: 'imported', title: `${AUTHOR} – A Quiet Book`, mediaType: 'audiobook', mediaId: authorId });
    expect(db.select().from(importedDownloads).all()[0]).toMatchObject({ mediaType: 'audiobook', authorId, bookIds: [book.id], downloadId: 'hash1' });
  });

  it('orders a multi-part mp3 book by tags and renames the parts with the part format', async () => {
    const book = addBook('Long Road');
    const src = join(downloads, 'Long Road MP3');
    // File names disagree with the track tags: tags win.
    await put(join(src, 'a.mp3'), buildMp3({ durationMs: 20_000, tags: bookTags('Long Road', { trackNo: 3 }) }));
    await put(join(src, 'b.mp3'), buildMp3({ durationMs: 20_000, tags: bookTags('Long Road', { trackNo: 1 }) }));
    await put(join(src, 'c.mp3'), buildMp3({ durationMs: 20_000, tags: bookTags('Long Road', { trackNo: 2 }) }));
    const h = hooks();
    const result = await service(h.deps).importCompletedDownload(tracked({ id: 2, title: 'Fixture Author - Long Road', outputPath: src, bookIds: [book.id] }));
    expect(result.verified).toBe(true);
    const bookFolder = join(authorPath, 'Long Road');
    expect(await listTree(bookFolder)).toEqual(['01 - Long Road.mp3', '02 - Long Road.mp3', '03 - Long Road.mp3']);
    const rows = bookFiles(book.id);
    expect(rows.map((r) => [r.partNumber, r.trackNumber])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    // Part 1 is the file tagged track 1 (b.mp3).
    expect((await stat(join(bookFolder, '01 - Long Road.mp3'))).ino).toBe((await stat(join(src, 'b.mp3'))).ino);
    expect(h.recorded[0]!.files.map((f) => f.partNumber)).toEqual([1, 2, 3]);
  });

  it('keeps the part names when renameAudiobookParts is off', async () => {
    setAudio({ renameAudiobookParts: false });
    const book = addBook('Long Road');
    const src = join(downloads, 'Long Road');
    for (const n of [1, 2, 3]) await put(join(src, `Chapter ${n}.mp3`), buildMp3({ durationMs: 20_000, tags: bookTags('Long Road', { trackNo: n }) }));
    const result = await service().importCompletedDownload(tracked({ id: 3, title: 'Long Road', outputPath: src, bookIds: [book.id] }));
    expect(result.verified).toBe(true);
    expect(await listTree(join(authorPath, 'Long Road'))).toEqual(['Chapter 1.mp3', 'Chapter 2.mp3', 'Chapter 3.mp3']);
  });

  it('places a series book in the series layout', async () => {
    const book = addBook('The Second Step', { series: { name: 'Quiet Series', position: '2' } });
    const src = join(downloads, 'Quiet Series 02 - The Second Step');
    await put(join(src, 'The Second Step.m4b'), m4b('The Second Step', 60_000, { series: 'Quiet Series', seriesPart: '2' }));
    setNaming({ renameAudiobooks: true });
    const result = await service().importCompletedDownload(tracked({ id: 4, title: 'Fixture Author - Quiet Series 02 - The Second Step', outputPath: src, bookIds: [book.id] }));
    expect(result.verified).toBe(true);
    const bookFolder = join(authorPath, 'Quiet Series', 'Book 2 - The Second Step');
    expect(await listTree(bookFolder)).toEqual(['The Second Step.m4b']);
    expect(bookRow(book.id).path).toBe(bookFolder);
  });

  it('rejects a book whose duration is off the runtime, and accepts it with a wider tolerance', async () => {
    const book = addBook('Short One', { runtimeMinutes: 1 });
    const src = join(downloads, 'Short One');
    await put(join(src, 'Short One.m4b'), m4b('Short One', 30_000));
    const item = tracked({ id: 5, title: 'Fixture Author - Short One', outputPath: src, bookIds: [book.id] });
    const first = await service().importCompletedDownload(item);
    expect(first.verified).toBe(false);
    expect(first.outcomes[0]).toMatchObject({ status: 'rejected', rejections: [{ reason: 'durationMismatch', type: 'permanent' }] });
    expect(first.messages[0]!.messages.join('\n')).toMatch(/Short One\.m4b: Total duration .* off the book's runtime of 1 min \(tolerance 15%\)/);
    expect(fake.items.get(5)!.trackedState).toBe('importPending');
    expect(bookFiles(book.id)).toEqual([]);

    setAudio({ audiobookDurationTolerance: 60 });
    const second = await service().importCompletedDownload(item);
    expect(second.verified).toBe(true);
    expect(bookFiles(book.id)).toHaveLength(1);
  });

  it('warns on a narrator mismatch but imports', async () => {
    const book = addBook('Other Voice', { narrators: ['Expected Reader'] });
    const src = join(downloads, 'Other Voice');
    await put(join(src, 'Other Voice.m4b'), m4b('Other Voice', 60_000, { narrator: 'Surprise Reader' }));
    const h = hooks();
    const result = await service(h.deps).importCompletedDownload(tracked({ id: 6, title: 'Other Voice', outputPath: src, bookIds: [book.id] }));
    expect(result.verified).toBe(true);
    expect(result.outcomes[0]!.warnings?.[0]).toMatch(/narrated by Surprise Reader/);
    expect(h.recorded[0]!.warnings).toHaveLength(1);
  });

  it('upgrades a book, sending the old parts to the recycle bin', async () => {
    setMedia({ recycleBinPath: bin });
    const book = addBook('Long Road');
    const mp3Src = join(downloads, 'Long Road MP3');
    for (const n of [1, 2, 3]) await put(join(mp3Src, `${n}.mp3`), buildMp3({ durationMs: 20_000, tags: bookTags('Long Road', { trackNo: n }) }));
    await service().importCompletedDownload(tracked({ id: 7, title: 'Long Road', outputPath: mp3Src, bookIds: [book.id] }));
    const oldIds = bookFiles(book.id).map((r) => r.id);
    expect(oldIds).toHaveLength(3);
    expect(bookFiles(book.id)[0]!.quality.quality.name).toBe('AB-MP3-Low');

    // The same quality again is not an upgrade.
    const again = join(downloads, 'Long Road again');
    for (const n of [1, 2, 3]) await put(join(again, `${n}.mp3`), buildMp3({ durationMs: 20_000, tags: bookTags('Long Road', { trackNo: n }) }));
    const same = await service().importCompletedDownload(tracked({ id: 8, title: 'Long Road', outputPath: again, bookIds: [book.id] }));
    expect(same.verified).toBe(false);
    expect(same.outcomes[0]!.rejections[0]!.reason).toBe('notQualityUpgrade');

    const m4bSrc = join(downloads, 'Long Road M4B');
    await put(join(m4bSrc, 'Long Road.m4b'), m4b('Long Road'));
    const h = hooks();
    const result = await service(h.deps).importCompletedDownload(tracked({ id: 9, title: 'Long Road', outputPath: m4bSrc, bookIds: [book.id] }));
    expect(result.verified).toBe(true);
    const bookFolder = join(authorPath, 'Long Road');
    expect(await listTree(bookFolder)).toEqual(['Long Road.m4b']);
    expect((await listTree(bin)).filter((p) => p.endsWith('.mp3'))).toHaveLength(3);
    const rows = bookFiles(book.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quality.quality.name).toMatch(/^AB-AAC/);
    expect(db.select().from(audioFiles).all().some((r) => oldIds.includes(r.id))).toBe(false);
    expect(h.recorded[0]).toMatchObject({ isUpgrade: true });
    expect(h.recorded[0]!.replacedFiles.map((f) => f.id).sort()).toEqual([...oldIds].sort());
    await vi.waitFor(() => expect(h.refreshed[0]).toMatchObject({ updateType: 'Modified' }));
  });

  it('splits a two-book pack by folder names and imports each book', async () => {
    const first = addBook('Lantern Road');
    const second = addBook('Quiet Harbour');
    const unrelated = addBook('Paper Moons');
    const src = join(downloads, 'Fixture Author - Two Book Pack');
    await put(join(src, 'Lantern Road', 'book.m4b'), m4b('Lantern Road'));
    for (const n of [1, 2]) await put(join(src, 'Quiet Harbour', 'CD1', `${n}.mp3`), buildMp3({ durationMs: 30_000, tags: { trackNo: n } }));
    const h = hooks();
    const result = await service(h.deps).importCompletedDownload(tracked({ id: 10, title: 'Fixture Author - Two Book Pack', outputPath: src, bookIds: [first.id, second.id] }));
    expect(result.messages).toEqual([]);
    expect(result.verified).toBe(true);
    expect(await listTree(authorPath)).toEqual(['Lantern Road/book.m4b', 'Quiet Harbour/01 - Quiet Harbour.mp3', 'Quiet Harbour/02 - Quiet Harbour.mp3']);
    expect(h.recorded.map((e) => e.bookId).sort()).toEqual([first.id, second.id].sort());
    expect(bookRow(unrelated.id).hasFile).toBe(false);
  });

  it('splits a single-folder pack by tags', async () => {
    const first = addBook('Lantern Road', { asin: 'B0LANTERN1' });
    const second = addBook('Quiet Harbour');
    const src = join(downloads, 'Pack');
    await put(join(src, 'one.m4b'), m4b('Lantern Road', 60_000, { asin: 'B0LANTERN1' }));
    await put(join(src, 'two.m4b'), m4b('Quiet Harbour'));
    const result = await service().importCompletedDownload(tracked({ id: 11, title: 'Pack', outputPath: src, bookIds: [] }));
    expect(result.verified).toBe(true);
    expect(bookFiles(first.id)).toHaveLength(1);
    expect(bookFiles(second.id)).toHaveLength(1);
  });

  it('writes Audiobookshelf sidecars only when the setting is on', async () => {
    const fetched: string[] = [];
    const fetchImage = async (url: string) => {
      fetched.push(url);
      return new Uint8Array([0xff, 0xd8, 0xff]);
    };
    const book = addBook('Lantern Road', { overview: '<p>A road.</p><p>With <b>lanterns</b>.</p>', narrators: ['Reader One', 'Reader Two'], cover: 'https://img.example/lantern.jpg' });
    const src = join(downloads, 'Lantern Road');
    await put(join(src, 'Lantern Road.m4b'), m4b('Lantern Road', 60_000, { narrator: 'Reader One' }));
    await service({ fetchImage }).importCompletedDownload(tracked({ id: 12, title: 'Lantern Road', outputPath: src, bookIds: [book.id] }));
    expect(await listTree(join(authorPath, 'Lantern Road'))).toEqual(['Lantern Road.m4b']);
    expect(fetched).toEqual([]);

    setAudio({ writeAbsSidecars: true });
    const other = addBook('Quiet Harbour', { overview: 'Calm water.', narrators: ['Reader Three'], cover: 'https://img.example/harbour.jpg' });
    const src2 = join(downloads, 'Quiet Harbour');
    await put(join(src2, 'Quiet Harbour.m4b'), m4b('Quiet Harbour', 60_000, { narrator: 'Reader Three' }));
    await service({ fetchImage }).importCompletedDownload(tracked({ id: 13, title: 'Quiet Harbour', outputPath: src2, bookIds: [other.id] }));
    const folder = join(authorPath, 'Quiet Harbour');
    expect(await listTree(folder)).toEqual(['Quiet Harbour.m4b', 'cover.jpg', 'desc.txt', 'reader.txt']);
    expect(await readFile(join(folder, 'desc.txt'), 'utf8')).toBe('Calm water.\n');
    expect(await readFile(join(folder, 'reader.txt'), 'utf8')).toBe('Reader Three\n');
    expect(fetched).toEqual(['https://img.example/harbour.jpg']);
    expect(bookFiles(other.id)).toHaveLength(1);
  });

  it('copies instead of linking when hard links are off, and moves when the client allows it', async () => {
    setMedia({ useHardlinks: false });
    const book = addBook('Lantern Road');
    const src = join(downloads, 'Lantern Road');
    const file = await put(join(src, 'Lantern Road.m4b'), m4b('Lantern Road'));
    const h = hooks();
    await service(h.deps).importCompletedDownload(tracked({ id: 14, title: 'Lantern Road', outputPath: src, bookIds: [book.id] }));
    const copy = await stat(join(authorPath, 'Lantern Road', 'Lantern Road.m4b'));
    expect(copy.nlink).toBe(1);
    expect(copy.ino).not.toBe((await stat(file)).ino);
    expect(h.recorded[0]!.importMode).toBe('copy');

    const other = addBook('Quiet Harbour');
    const src2 = join(downloads, 'Quiet Harbour');
    await put(join(src2, 'Quiet Harbour.m4b'), m4b('Quiet Harbour'));
    await service(h.deps).importCompletedDownload(tracked({ id: 15, title: 'Quiet Harbour', outputPath: src2, bookIds: [other.id], canMoveFiles: true }));
    expect(h.recorded[1]!.importMode).toBe('move');
    expect(await exists(src2)).toBe(false);
  });

  it('asks for manual import when no book matches', async () => {
    addBook('Lantern Road');
    const src = join(downloads, 'Something Else Entirely');
    await put(join(src, 'x.m4b'), m4b('Something Else Entirely'));
    const result = await service().importCompletedDownload(tracked({ id: 16, title: 'Something Else Entirely', outputPath: src }));
    expect(result.verified).toBe(false);
    expect(result.outcomes[0]!.rejections[0]!.reason).toBe('unknownBook');
    expect(events.some((e) => e.type === 'import' && e.action === 'manualRequired' && e.mediaType === 'audiobook' && e.mediaId === authorId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------

describe('manual import, audiobook mode', () => {
  function routes(svc: ImportsService) {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    void app.register(importsRoutes(svc));
    return app;
  }

  it('proposes author, book, part order and confidence, then imports the adjusted order', async () => {
    const book = addBook('Long Road');
    const folder = join(downloads, 'some rip');
    for (const [name, track] of [['x.mp3', 2], ['y.mp3', 1], ['z.mp3', 3]] as const) {
      await put(join(folder, name), buildMp3({ durationMs: 20_000, tags: bookTags('Long Road', { trackNo: track }) }));
    }
    const app = routes(service());

    const res = await app.inject({ method: 'GET', url: `/manualimport/audio?mediaType=audiobook&folder=${encodeURIComponent(folder)}` });
    expect(res.statusCode).toBe(200);
    const items = res.json<AudiobookManualImportItem[]>();
    expect(items.map((i) => [i.name, i.partNumber, i.partCount])).toEqual([
      ['y.mp3', 1, 3],
      ['x.mp3', 2, 3],
      ['z.mp3', 3, 3],
    ]);
    for (const i of items) {
      expect(i).toMatchObject({ mediaType: 'audiobook', authorId, bookId: book.id, bookTitle: 'Long Road', runtimeMs: 60_000, rejections: [] });
      expect(i.confidence).toBeGreaterThanOrEqual(0.9);
      expect(i.groupDurationMs).toBeGreaterThan(55_000);
    }
    expect(items[0]!.tags).toMatchObject({ title: 'Long Road', author: AUTHOR, narrator: 'Fixture Narrator', trackNo: 1 });

    // The user swaps parts 1 and 2.
    const body = {
      importMode: 'copy',
      items: items.map((i) => ({ path: i.path, mediaType: 'audiobook', authorId, bookId: book.id, partNumber: i.name === 'y.mp3' ? 2 : i.name === 'x.mp3' ? 1 : 3 })),
    };
    const done = await app.inject({ method: 'POST', url: '/manualimport/audio', payload: body });
    expect(done.statusCode).toBe(200);
    const result = done.json<AudioManualImportResult>();
    expect(result.failed).toEqual([]);
    expect(result.imported.map((r) => [r.partNumber, r.bookId])).toEqual([
      [1, book.id],
      [2, book.id],
      [3, book.id],
    ]);
    const bookFolder = join(authorPath, 'Long Road');
    expect((await stat(join(bookFolder, '01 - Long Road.mp3'))).ino).toBe((await stat(join(folder, 'x.mp3'))).ino);
    expect(bookRow(book.id).hasFile).toBe(true);

    // Already imported files are filtered from the next proposal; music mode is unaffected.
    const next = await app.inject({ method: 'GET', url: `/manualimport/audio?mediaType=audiobook&authorId=${authorId}` });
    expect(next.json<AudiobookManualImportItem[]>()).toEqual([]);
  });

  it('validates the mapping and marks the tracked download imported once its books have files', async () => {
    const book = addBook('Lantern Road');
    const other = db
      .insert(authors)
      .values({ name: 'Someone', sortName: 'Someone', cleanName: 'someone', images: [], genres: [], aliases: [], path: join(bookRoot, 'Someone'), rootFolderPath: bookRoot, qualityProfileId: 1, languages: [], tags: [], added: NOW })
      .returning()
      .get();
    const folder = join(downloads, 'dl');
    const file = await put(join(folder, 'Lantern Road.m4b'), m4b('Lantern Road'));
    const item = tracked({ id: 20, title: 'Lantern Road', outputPath: folder, bookIds: [book.id] });
    const svc = service();
    const proposal = await svc.listAudioManualImport({ mediaType: 'audiobook', downloadId: item.downloadId, filterExistingFiles: true });
    expect(proposal).toHaveLength(1);
    expect(proposal[0]).toMatchObject({ downloadId: item.downloadId, bookId: book.id });

    const result = await svc.executeAudioManualImport({
      importMode: 'auto',
      items: [
        { path: join(folder, 'missing.m4b'), mediaType: 'audiobook', authorId, bookId: book.id },
        { path: file, mediaType: 'audiobook', authorId: other.id, bookId: book.id },
        { path: file, mediaType: 'audiobook', authorId, bookId: book.id, downloadId: item.downloadId },
      ],
    });
    expect(result.failed.map((f) => f.error)).toEqual([expect.stringMatching(/File not found/), expect.stringMatching(/is not a book of author/)]);
    expect(result.imported).toHaveLength(1);
    expect(fake.imported).toEqual([20]);
    expect(await exists(file)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------

describe('import wiring for audiobooks (history, notifications, media-server refresh)', () => {
  const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

  it('records history with an audiobook target, dispatches an Author – Title notification and refreshes the book folder', async () => {
    const appDb = await createTestDb();
    let ctxRef: AppContext | undefined;
    const app = await buildApp(config, appDb, pino({ level: 'silent' }), { probe: false, onContext: (ctx) => void (ctxRef = ctx) });
    await app.ready();
    try {
      const ctx = ctxRef!;
      await seed(appDb);
      const book = addBook('The Second Step', {
        asin: 'B0SECOND01',
        narrators: ['Reader One', 'Reader Two'],
        series: { name: 'Quiet Series', position: '2' },
        cover: 'https://img.example/second.jpg',
        runtimeMinutes: 1,
      });
      const src = join(downloads, 'Fixture Author - The Second Step [m4b]');
      await put(join(src, 'The Second Step.m4b'), m4b('The Second Step', 60_000, { narrator: 'Reader One' }));

      const recordImport = vi.spyOn(historyServiceFor(ctx), 'recordImport').mockReturnValue([]);
      const dispatch = vi.spyOn(notificationsServiceFor(ctx), 'dispatch').mockResolvedValue(undefined as never);
      const refreshPath = vi.spyOn(mediaServersServiceFor(ctx), 'refreshPath').mockResolvedValue([]);

      const svc = service(importsDeps(ctx), appDb);
      const result = await svc.importCompletedDownload(tracked({ id: 30, title: 'Fixture Author - The Second Step [m4b]', outputPath: src, bookIds: [book.id] }));
      expect(result.verified).toBe(true);
      const bookFolder = join(authorPath, 'Quiet Series', 'Book 2 - The Second Step');

      expect(recordImport).toHaveBeenCalledTimes(1);
      expect(recordImport.mock.calls[0]![0]).toMatchObject({
        target: { mediaType: 'audiobook', authorId, bookIds: [book.id] },
        importedPath: bookFolder,
        droppedPath: src,
        downloadId: 'hash30',
      });

      expect(dispatch).toHaveBeenCalledTimes(1);
      const notification = dispatch.mock.calls[0]![0] as unknown as Record<string, unknown>;
      expect(notification).toMatchObject({
        type: 'import',
        media: { id: authorId, mediaType: 'audiobook', title: AUTHOR, tmdbId: 0, images: [{ coverType: 'poster', url: 'https://img.example/second.jpg' }] },
        author: { id: authorId, name: AUTHOR, asin: 'B0AUTHOR01' },
        book: { id: book.id, title: 'The Second Step', narrators: ['Reader One', 'Reader Two'], seriesTitle: 'Quiet Series', seriesPosition: '2', asin: 'B0SECOND01', runtimeMs: 60_000, path: bookFolder },
        file: { path: bookFolder, relativePath: join('Quiet Series', 'Book 2 - The Second Step') },
      });

      await vi.waitFor(() => expect(refreshPath).toHaveBeenCalledWith({ path: bookFolder, mediaType: 'audiobook', updateType: 'Created' }));
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  });
});
