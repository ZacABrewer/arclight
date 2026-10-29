import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimiter, type CatalogBook, type MbReleaseGroup } from '@arclight/metadata';
import { buildItems } from '@arclight/profiles-engine';
import { QUALITIES, type LibraryImportScan } from '@arclight/shared';
import { buildApp, type AppContext } from '../../../app.js';
import type { AppConfig } from '../../../config.js';
import type { Db } from '../../../db/index.js';
import { albums, artists, audioFiles, authors, books, rootFolders, tracks } from '../../../db/schema.js';
import { createTestDb, seedAdmin } from '../../../db/test-utils.js';
import { authServiceFor } from '../../auth/index.js';
import { audiobookRefresherFor, musicRefresherFor, setAudiobookProviders, setMusicProviders } from '../../metadata/index.js';
import { ProfilesService } from '../../profiles/index.js';
import { setSection } from '../../settings/service.js';
import { orderParts, partFolderNumber } from './book-layout.js';
import { buildFlac, buildMp3, buildMp4 } from './fixtures/builders.js';
import {
  detectAlbum,
  detectBook,
  groupLibraryBooks,
  libraryImportFor,
  personFit,
  scoreAlbum,
  scoreBook,
  searchableTitle,
  setLibraryImportLookups,
  type LibraryBookUnit,
} from './library-import.js';
import { groupBookFiles } from '../../audiobooks/rescan.js';
import { discNumberFromFolder, groupAudioFiles, isAudioExtension, type AudioScanFile } from './scan-audio.js';
import { canonicalTagKey, emptyAudioTags, type AudioTags } from './tags.js';

// Library import over pure helpers (grouping, detection, scoring) and the full app: audiobook
// answers come from the recorded Audible / Audnexus fixtures, MusicBrainz from its recorded
// fixtures (no network), and the collections are temp folders of tiny tagged files.

const ROOT = join(tmpdir(), 'library');

function file(path: string, tags: Partial<AudioTags> | null = {}): AudioScanFile {
  return {
    path,
    relativePath: basename(path),
    name: basename(path),
    extension: extname(path).toLowerCase(),
    sizeBytes: 1,
    mtimeMs: 0,
    tags: tags ? { ...emptyAudioTags(), ...tags } : null,
    error: tags ? null : 'unreadable',
    discFromFolder: discNumberFromFolder(basename(dirname(path))),
  };
}

const at = (...parts: string[]) => join(ROOT, ...parts);
const unitOf = (units: LibraryBookUnit[], folder: string, name?: string) => {
  const found = units.filter((u) => u.folder === folder && (!name || u.files.some((f) => f.name === name)));
  if (found.length !== 1) throw new Error(`${found.length} units for ${folder} ${name ?? ''}: ${units.map((u) => u.key).join(', ')}`);
  return found[0]!;
};

describe('grouping books', () => {
  it('folds part folders, keeps loose files apart and splits by tags', () => {
    const units = groupLibraryBooks(ROOT, [
      file(at('Mara Quill', 'The Glass Orchard', '02.mp3'), { trackNo: 2 }),
      file(at('Mara Quill', 'The Glass Orchard', '01.mp3'), { trackNo: 1 }),
      // Author/Series/NN - Book with CD folders: track numbers restart per disc.
      file(at('Mara Quill', 'Orchard Cycle', '02 - The Iron Meridian', 'CD 2', '01.mp3'), { trackNo: 1 }),
      file(at('Mara Quill', 'Orchard Cycle', '02 - The Iron Meridian', 'CD 1', '02.mp3'), { trackNo: 2 }),
      file(at('Mara Quill', 'Orchard Cycle', '02 - The Iron Meridian', 'CD 1', '01.mp3'), { trackNo: 1 }),
      // Loose single-file books in the author folder, one with an upper-case extension.
      file(at('Mara Quill', 'Lantern Road.M4B')),
      file(at('Mara Quill', 'Salt Harbour.m4b')),
      // A flat `Author - Title (Year)` folder, and loose books in the scanned folder itself.
      file(at('Andrew Pell - The Copper Gate (2015)', 'a.m4b')),
      file(at('Quiet Rooms.m4a')),
      file(at('Quiet Rooms - Part 2.m4a')),
      // One folder holding two books by album tag.
      file(at('Pack', 'x.mp3'), { album: 'First Book' }),
      file(at('Pack', 'y.mp3'), { album: 'Second Book' }),
      // A sequence of "Title - NN" files with nothing tagged.
      file(at('Mara Quill', 'Night Ferry', 'Night Ferry - 02.mp3'), null),
      file(at('Mara Quill', 'Night Ferry', 'Night Ferry - 01.mp3'), null),
    ]);
    expect(unitOf(units, at('Mara Quill', 'The Glass Orchard')).files.map((f) => f.name)).toEqual(['01.mp3', '02.mp3']);
    const meridian = unitOf(units, at('Mara Quill', 'Orchard Cycle', '02 - The Iron Meridian'));
    expect(meridian.files.map((f) => f.path)).toEqual([
      at('Mara Quill', 'Orchard Cycle', '02 - The Iron Meridian', 'CD 1', '01.mp3'),
      at('Mara Quill', 'Orchard Cycle', '02 - The Iron Meridian', 'CD 1', '02.mp3'),
      at('Mara Quill', 'Orchard Cycle', '02 - The Iron Meridian', 'CD 2', '01.mp3'),
    ]);
    expect(unitOf(units, at('Mara Quill'), 'Lantern Road.M4B')).toMatchObject({ loose: true, files: [expect.objectContaining({ name: 'Lantern Road.M4B' })] });
    expect(unitOf(units, at('Mara Quill'), 'Salt Harbour.m4b').files).toHaveLength(1);
    expect(unitOf(units, at('Andrew Pell - The Copper Gate (2015)')).loose).toBe(false);
    // "Quiet Rooms" and "Quiet Rooms - Part 2" are one book.
    expect(unitOf(units, ROOT, 'Quiet Rooms.m4a').files.map((f) => f.name)).toEqual(['Quiet Rooms.m4a', 'Quiet Rooms - Part 2.m4a']);
    expect(units.filter((u) => u.folder === at('Pack'))).toHaveLength(2);
    expect(unitOf(units, at('Mara Quill', 'Night Ferry')).files.map((f) => f.name)).toEqual(['Night Ferry - 01.mp3', 'Night Ferry - 02.mp3']);
    expect(units).toHaveLength(9);
  });

  it('splits a folder of distinct single-file books but keeps numbered parts together', () => {
    const units = groupLibraryBooks(ROOT, [
      file(at('Shelf', 'Lantern Road.m4b')),
      file(at('Shelf', 'Salt Harbour.m4b')),
      file(at('Parts', '01.m4b')),
      file(at('Parts', '02.m4b')),
    ]);
    expect(units.filter((u) => u.folder === at('Shelf'))).toHaveLength(2);
    expect(unitOf(units, at('Parts')).files).toHaveLength(2);
  });
});

describe('part order', () => {
  it('uses the part folder number when the files carry no disc tags', () => {
    const files = [
      file(at('Book', 'Part 2', '01.mp3'), { trackNo: 1 }),
      file(at('Book', 'Part 1', '02.mp3'), { trackNo: 2 }),
      file(at('Book', 'Part 1', '01.mp3'), { trackNo: 1 }),
      file(at('Book', 'Pt 3', '01.mp3'), { trackNo: 1 }),
    ].map((f) => ({ ...f, relativePath: f.path.slice(at('Book').length + 1) }));
    expect(orderParts(files).map((f) => f.path.slice(at('Book').length + 1))).toEqual([
      join('Part 1', '01.mp3'),
      join('Part 1', '02.mp3'),
      join('Part 2', '01.mp3'),
      join('Pt 3', '01.mp3'),
    ]);
    expect(partFolderNumber(at('Book', 'Disc 02 (Bonus)', 'a.mp3'))).toBe(2);
    expect(partFolderNumber(at('Book', 'a.mp3'))).toBeNull();
  });
});

describe('reading real-world files', () => {
  it('knows the composer, the Audible CDEK atom and .wma files', () => {
    expect(canonicalTagKey('TCOM')).toBe('composer');
    expect(canonicalTagKey('©wrt')).toBe('composer');
    expect(canonicalTagKey('CDEK')).toBe('asin');
    expect(isAudioExtension('.WMA')).toBe(true);
    expect(isAudioExtension('.M4B')).toBe(true);
  });

  it('titles a loose file in an author folder by its name on rescan', () => {
    const [group] = groupBookFiles(at('Mara Quill'), [file(at('Mara Quill', 'Lantern Road.m4b'), null)]);
    expect(group).toMatchObject({ folder: at('Mara Quill', 'Lantern Road.m4b'), title: 'Lantern Road' });
  });
});

describe('detecting books and albums', () => {
  const detect = (files: AudioScanFile[]) => detectBook(ROOT, groupLibraryBooks(ROOT, files).find((u) => u.files.some((f) => f.path === files[0]!.path))!);

  it('reads author, series, position, narrator and ASIN markers from the path', () => {
    const series = detect([file(at('Mara Quill', 'Orchard Cycle', 'Book 2 - The Iron Meridian', '01.mp3'), null)]);
    expect(series.detected).toMatchObject({ author: 'Mara Quill', title: 'The Iron Meridian', series: 'Orchard Cycle', seriesPosition: '2' });
    const marked = detect([file(at('Mara Quill', 'The Glass Orchard {Tamsin Vale} [B0ABCDE123]', 'a.m4b'), null)]);
    expect(marked.detected).toMatchObject({ author: 'Mara Quill', title: 'The Glass Orchard', narrator: 'Tamsin Vale', asin: 'B0ABCDE123' });
    const flat = detect([file(at('Andrew Pell - The Copper Gate (2015)', 'a.m4b'), null)]);
    expect(flat.detected).toMatchObject({ author: 'Andrew Pell', title: 'The Copper Gate', year: 2015 });
    const loose = detect([file(at('Mara Quill', 'Lantern Road.m4b'), null), file(at('Mara Quill', 'Other', 'x.mp3'), null)]);
    expect(loose.detected).toMatchObject({ author: 'Mara Quill', title: 'Lantern Road' });
  });

  it('prefers tags, takes the composer as narrator and ignores a junk ASIN tag', () => {
    const hints = detect([
      file(at('Unsorted', '01.mp3'), { album: 'The Glass Orchard (Unabridged)', albumArtist: 'Mara Quill', composer: 'Tamsin Vale', date: '2019-04-02', asin: 'n/a', series: 'Orchard Cycle', seriesPart: '1' }),
    ]);
    expect(hints.detected).toMatchObject({ author: 'Mara Quill', title: 'The Glass Orchard', narrator: 'Tamsin Vale', year: 2019, asin: null, series: 'Orchard Cycle', seriesPosition: '1' });
    expect(detect([file(at('X', '01.m4b'), { asin: ' b0abcde123 ' })]).detected.asin).toBe('B0ABCDE123');
  });

  it('reads Artist/Album (Year) and Artist - Album folders', () => {
    const [nested] = groupAudioFiles([file(at('The Lanterns', 'Night Ferry (2004)', '01.flac'), null)]);
    expect(detectAlbum(ROOT, nested!).detected).toMatchObject({ author: 'The Lanterns', title: 'Night Ferry', year: 2004 });
    const [flat] = groupAudioFiles([file(at('The Lanterns - Salt Harbour [2009]', '01.flac'), null)]);
    expect(detectAlbum(ROOT, flat!).detected).toMatchObject({ author: 'The Lanterns', title: 'Salt Harbour', year: 2009 });
  });

  it('cleans titles for searching and compares names', () => {
    expect(searchableTitle('Book 3 - The Iron Meridian (Unabridged) [2015]')).toBe('The Iron Meridian');
    expect(searchableTitle('01 - The Glass Orchard')).toBe('The Glass Orchard');
    expect(personFit('Quill, Mara', 'Mara Quill')).toBe(1);
    expect(personFit('M. Quill', 'Mara Quill')).toBeGreaterThanOrEqual(0.75);
    expect(personFit('Andrew Pell', 'Mara Quill')).toBe(0);
  });

  it('scores the right book above a namesake', () => {
    const hints = detect([file(at('Mara Quill', 'The Glass Orchard', '01.mp3'), null)]);
    const book = (title: string, author: string): CatalogBook => ({ title, authors: [{ name: author }], narrators: [], series: [], isbns: [], genres: [], images: {}, sources: ['audible'], asin: 'B000000001' });
    expect(scoreBook(hints, null, book('The Glass Orchard', 'Mara Quill'))).toBeGreaterThan(0.85);
    expect(scoreBook(hints, null, book('The Glass Orchard', 'Someone Else'))).toBeLessThan(scoreBook(hints, null, book('The Glass Orchard', 'Mara Quill')));
    expect(scoreBook(hints, null, book('Unrelated Story', 'Mara Quill'))).toBeLessThan(0.4);
  });

  it('prefers a self-titled album over its single of the same year for a full folder', () => {
    const [group] = groupAudioFiles(Array.from({ length: 11 }, (_, i) => file(at('The Lanterns', 'The Lanterns (1997)', `${String(i + 1).padStart(2, '0')}.flac`), null)));
    const hints = detectAlbum(ROOT, group!);
    const rg = (primaryType: string, secondaryTypes: string[] = []) => ({
      mbid: primaryType,
      title: 'The Lanterns',
      primaryType,
      secondaryTypes,
      year: 1997,
      artistCredits: [{ name: 'The Lanterns', creditedName: 'The Lanterns', joinPhrase: '', artistMbid: 'a' }],
    });
    const album = scoreAlbum(hints, rg('Album'), 11);
    expect(album).toBeGreaterThan(scoreAlbum(hints, rg('Single'), 11));
    expect(album).toBeGreaterThan(scoreAlbum(hints, rg('Album', ['Live']), 11));
    expect(scoreAlbum(hints, rg('Single'))).toBe(scoreAlbum(hints, rg('Album')));
  });
});

// ---------------------------------------------------------------------------------------
// Full app
// ---------------------------------------------------------------------------------------

const AB_FIXTURES = new URL('../../../../../../packages/metadata/fixtures/', import.meta.url);
const abFixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, AB_FIXTURES), 'utf8'));
const MB_FIXTURES = new URL('../../../../../../packages/metadata/fixtures/musicbrainz/', import.meta.url);
const mbFixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, MB_FIXTURES), 'utf8'));

const AUTHOR = 'B00G0WYW92';
const PHM = 'B08G9PRS1K';
const AUTHOR_NAME = 'Andy Weir';
const ARTIST = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const OK_COMPUTER = 'b1392450-e666-3926-a536-22c65f834433';
const RELEASE = '0b6b4ba0-d36f-47bd-b4ea-6a5b91842d29';

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Recorded Audible / Audnexus / MusicBrainz answers by host and path. */
function fixtureFetch() {
  const calls: string[] = [];
  const fetchImpl = async (input: string) => {
    const url = new URL(input);
    calls.push(`${url.host}${url.pathname}${url.search}`);
    const path = url.pathname;
    const q = url.searchParams;
    if (url.hostname === 'api.audnex.us') {
      if (path === `/books/${PHM}`) return json(abFixture('audnexus/book.json'));
      if (path === `/books/${PHM}/chapters`) return json(abFixture('audnexus/chapters.json'));
      if (path === `/authors/${AUTHOR}`) return json(abFixture('audnexus/author.json'));
      return json(abFixture('audnexus/error-404.json'), 404);
    }
    if (url.hostname.startsWith('api.audible.')) {
      const all = `${q.get('title') ?? ''} ${q.get('keywords') ?? ''}`;
      if (q.get('author') === AUTHOR_NAME && !q.get('title')) {
        const pages = ['audible/author-page-0.json', 'audible/author-page-1.json', 'audible/author-page-2.json'];
        const page = pages[Number(q.get('page') ?? '0')];
        return json(page ? abFixture(page) : { ...(abFixture('audible/empty.json') as object), total_results: 25 });
      }
      if (/project hail mary/i.test(all) && q.get('page') === '0') return json(abFixture('audible/search.json'));
      return json(abFixture('audible/empty.json'));
    }
    if (url.hostname === 'openlibrary.org') {
      if (path === '/search/authors.json' || path === '/search.json') return json({ numFound: 0, start: 0, docs: [] });
      return new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    }
    if (url.hostname === 'musicbrainz.org') {
      const p = path.replace(/^\/ws\/2/, '');
      if (p === `/artist/${ARTIST}`) return json(mbFixture('artist.json'));
      if (p === '/release-group' && q.get('artist') === ARTIST) {
        if (q.get('offset') !== '100') return json(mbFixture('release-groups-page-1.json'));
        return json(mbFixture('release-groups-page-2.json'));
      }
      if (p === '/release' && q.get('release-group') === OK_COMPUTER) return json(mbFixture('releases.json'));
      if (p === `/release/${RELEASE}`) return json(mbFixture('release.json'));
      return json(mbFixture('error-404.json'), 404);
    }
    return json({ error: `unexpected host ${url.hostname}` }, 404);
  };
  return { fetchImpl, calls };
}

function instantClock() {
  let t = Date.parse('2026-10-01T00:00:00Z');
  return { now: () => t, sleep: async (ms: number) => void (t += Math.max(0, ms)) };
}

interface Harness {
  db: Db;
  ctx: AppContext;
  root: string;
  profileId: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
  api: (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => Promise<{ statusCode: number; body: string; json<T = any>(): T }>;
  idle: () => Promise<void>;
  close: () => Promise<void>;
}

const open: Harness[] = [];

async function harness(mediaType: 'audiobook' | 'music'): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  setSection(db, 'features', { music: mediaType === 'music', audiobooks: mediaType === 'audiobook' });
  setSection(db, 'audiobookMetadata', {
    audibleRegion: 'us',
    audnexusBaseUrl: 'https://api.audnex.us/',
    openLibraryFallback: true,
    languages: ['english'],
    audnexusRateLimitPerSecond: 1,
    audibleRateLimitPerSecond: 2,
    openLibraryRateLimitPerSecond: 1,
  });
  setSection(db, 'musicMetadata', { baseUrl: 'https://musicbrainz.org/ws/2/', rateLimitPerSecond: 1, preferredCountries: ['US'], preferredFormats: ['CD'] });
  const root = mkdtempSync(join(tmpdir(), 'arclight-libimport-'));
  db.insert(rootFolders).values({ path: root, mediaType }).run();
  const { fetchImpl } = fixtureFetch();
  let ctxRef: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (ctx) => {
      ctxRef = ctx;
      const rateLimiter = new RateLimiter({ clock: instantClock() });
      setAudiobookProviders(ctx, { fetchImpl, rateLimiter });
      setMusicProviders(ctx, { fetchImpl, rateLimiter });
    },
  });
  await app.ready();
  const ctx = ctxRef!;
  const key = authServiceFor(ctx).apiKey();
  const profile = new ProfilesService({ db }).createQualityProfile({
    name: 'Import test',
    upgradeAllowed: true,
    cutoff: mediaType === 'audiobook' ? QUALITIES['AB-Lossless'].id : QUALITIES.FLAC.id,
    items: mediaType === 'audiobook' ? buildItems(['AB-MP3', 'AB-AAC', 'AB-Lossless'], 'audiobook') : buildItems(['MP3-320', 'FLAC'], 'music'),
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
    mediaDomain: mediaType,
  });
  const idle = async () => {
    await libraryImportFor(ctx).whenIdle();
    await audiobookRefresherFor(ctx)?.whenIdle();
    await musicRefresherFor(ctx)?.whenIdle();
  };
  const value: Harness = {
    db,
    ctx,
    root,
    profileId: profile.id,
    api: (method, url, payload) =>
      app.inject({ method, url: `/api/v1${url}`, headers: { 'x-api-key': key }, ...(payload === undefined ? {} : { payload: payload as object }) }),
    idle,
    close: async () => {
      await idle();
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

async function scanOf(h: Harness, mediaType: 'audiobook' | 'music', path = h.root): Promise<LibraryImportScan> {
  const res = await h.api('POST', '/libraryimport/scan', { mediaType, path });
  expect(res.statusCode, res.body).toBe(202);
  await h.idle();
  const scan = (await h.api('GET', `/libraryimport/scan/${res.json().id}`)).json<LibraryImportScan>();
  expect(scan.status, scan.error ?? '').toBe('ready');
  return scan;
}

describe('library import of audiobooks', () => {
  it('matches a flat Author - Title folder by search, imports it in place and keeps it through a rescan', { timeout: 30_000 }, async () => {
    const h = await harness('audiobook');
    const folder = join(h.root, 'Andy Weir - Project Hail Mary (2021) {Ray Porter}');
    mkdirSync(join(folder, 'CD 1'), { recursive: true });
    mkdirSync(join(folder, 'CD 2'), { recursive: true });
    // Track numbers restart per disc; no disc tags.
    for (const cd of [1, 2]) {
      for (const n of [1, 2]) {
        writeFileSync(join(folder, `CD ${cd}`, `0${n}.mp3`), buildMp3({ durationMs: 2000, tags: { album: 'Project Hail Mary', artist: AUTHOR_NAME, trackNo: n } }));
      }
    }
    writeFileSync(join(h.root, 'Unknown Thing.m4b'), buildMp4({ brand: 'M4B ', durationMs: 1000, tags: {} }));

    const scan = await scanOf(h, 'audiobook');
    expect(scan.stats).toMatchObject({ files: 5, alreadyInLibrary: 0, candidates: 2 });
    const phm = scan.candidates.find((c) => c.folder === folder)!;
    expect(phm.detected).toMatchObject({ author: AUTHOR_NAME, title: 'Project Hail Mary', narrator: 'Ray Porter', year: 2021 });
    expect(phm.match).toMatchObject({ foreignId: PHM, title: 'Project Hail Mary', creditName: AUTHOR_NAME, inLibrary: false });
    expect(phm.matchedBy).toBe('search');
    expect(phm.confidence).toBeGreaterThan(0.8);
    // The runtime check is a note here, not a refusal.
    expect(phm.warnings.join(' ')).toMatch(/off the book's runtime/);
    expect(phm.files.map((f) => f.relativePath)).toEqual([join('CD 1', '01.mp3'), join('CD 1', '02.mp3'), join('CD 2', '01.mp3'), join('CD 2', '02.mp3')]);
    const unknown = scan.candidates.find((c) => c.folder !== folder)!;
    expect(unknown.match).toBeNull();

    const bad = await h.api('POST', '/libraryimport/import', { scanId: scan.id, items: [{ candidateId: unknown.id }], qualityProfileId: h.profileId });
    expect(bad.statusCode).toBe(400);

    const res = await h.api('POST', '/libraryimport/import', { scanId: scan.id, items: [{ candidateId: phm.id }], qualityProfileId: h.profileId });
    expect(res.statusCode, res.body).toBe(202);
    await h.idle();
    const after = (await h.api('GET', `/libraryimport/scan/${scan.id}`)).json<LibraryImportScan>();
    const done = after.candidates.find((c) => c.id === phm.id)!;
    expect(done.status, done.message ?? '').toBe('imported');
    expect(after.stats.imported).toBe(1);

    const author = h.db.select().from(authors).get()!;
    expect(author).toMatchObject({ asin: AUTHOR, monitored: true, monitorNewBooks: 'none' });
    const all = h.db.select().from(books).where(eq(books.authorId, author.id)).all();
    const book = all.find((b) => b.asin === PHM)!;
    expect(book).toMatchObject({ hasFile: true, monitored: true, path: folder });
    // Only the imported book is wanted; the rest of the bibliography stays unmonitored.
    expect(all.length).toBeGreaterThan(1);
    expect(all.filter((b) => b.monitored).map((b) => b.asin)).toEqual([PHM]);
    expect(h.ctx.scheduler.listRecent(200).some((j) => j.name === 'AuthorSearch' || j.name === 'BookSearch')).toBe(false);
    // Linked in place, in part order.
    const rows = h.db.select().from(audioFiles).where(eq(audioFiles.bookId, book.id)).all().sort((a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0));
    expect(rows.map((r) => r.path)).toEqual([join(folder, 'CD 1', '01.mp3'), join(folder, 'CD 1', '02.mp3'), join(folder, 'CD 2', '01.mp3'), join(folder, 'CD 2', '02.mp3')]);

    // The author folder exists but the files live outside it: a rescan keeps them.
    mkdirSync(author.path, { recursive: true });
    const cmd = await h.api('POST', '/command', { name: 'RescanAuthor', authorIds: [author.id] });
    expect(cmd.statusCode, cmd.body).toBe(202);
    await h.idle();
    expect(h.db.select().from(audioFiles).where(eq(audioFiles.bookId, book.id)).all()).toHaveLength(4);
    expect(h.db.select().from(books).where(eq(books.id, book.id)).get()!.hasFile).toBe(true);

    // A second scan leaves the linked files out.
    const again = await scanOf(h, 'audiobook');
    expect(again.stats).toMatchObject({ files: 5, alreadyInLibrary: 4, candidates: 1 });
  });

  it('matches by ASIN tag, takes the author folder over and offers lookups', { timeout: 30_000 }, async () => {
    const h = await harness('audiobook');
    const folder = join(h.root, 'Andy Weir', 'Project Hail Mary');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Project Hail Mary.m4b'), buildMp4({ brand: 'M4B ', durationMs: 3000, tags: { title: 'Project Hail Mary', artist: AUTHOR_NAME, asin: PHM } }));
    const scan = await scanOf(h, 'audiobook');
    expect(scan.candidates).toHaveLength(1);
    const c = scan.candidates[0]!;
    expect(c).toMatchObject({ matchedBy: 'asin', confidence: 1, match: expect.objectContaining({ foreignId: PHM }) });

    const lookup = await h.api('GET', `/libraryimport/lookup?mediaType=audiobook&term=${PHM}`);
    expect(lookup.statusCode, lookup.body).toBe(200);
    expect(lookup.json()[0]).toMatchObject({ foreignId: PHM, title: 'Project Hail Mary' });

    const res = await h.api('POST', '/libraryimport/import', { scanId: scan.id, items: [{ candidateId: c.id, foreignId: PHM }], qualityProfileId: h.profileId });
    expect(res.statusCode, res.body).toBe(202);
    await h.idle();
    const author = h.db.select().from(authors).get()!;
    expect(author.path).toBe(join(h.root, 'Andy Weir'));
    expect(h.db.select().from(books).where(eq(books.asin, PHM)).get()).toMatchObject({ hasFile: true, path: folder });
    expect(h.db.select().from(audioFiles).all().map((r) => r.path)).toEqual([join(folder, 'Project Hail Mary.m4b')]);
  });

  it('refuses paths outside every root folder and answers 404 while audiobooks are off', { timeout: 30_000 }, async () => {
    const h = await harness('audiobook');
    const elsewhere = mkdtempSync(join(tmpdir(), 'arclight-elsewhere-'));
    try {
      const res = await h.api('POST', '/libraryimport/scan', { mediaType: 'audiobook', path: elsewhere });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/root folder/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    const music = await h.api('POST', '/libraryimport/scan', { mediaType: 'music', path: h.root });
    expect(music.statusCode).toBe(404);
    expect(music.json().code).toBe('MUSIC_DISABLED');
  });
});

interface ReleaseFixture {
  media: Array<{ position: number; tracks: Array<{ title: string; position: number; recording: { id: string } }> }>;
}

describe('library import of music', () => {
  it('matches an album by its release-group tag, adds the artist without monitoring the rest and links in place', { timeout: 30_000 }, async () => {
    const h = await harness('music');
    const release = mbFixture('release.json') as ReleaseFixture;
    const okComputer: MbReleaseGroup = {
      mbid: OK_COMPUTER,
      title: 'OK Computer',
      primaryType: 'Album',
      secondaryTypes: [],
      firstReleaseDate: '1997-05-21',
      year: 1997,
      artistCredits: [{ artistMbid: ARTIST, name: 'Radiohead', creditedName: 'Radiohead', joinPhrase: '' }],
    };
    const lookedUp: string[] = [];
    setLibraryImportLookups(h.ctx, {
      books: null,
      albums: {
        releaseGroup: async (mbid) => (lookedUp.push(mbid), mbid === OK_COMPUTER ? okComputer : null),
        releaseGroupOfRelease: async () => null,
        search: async () => [],
      },
    });
    const folder = join(h.root, 'Radiohead - OK Computer (1997)');
    mkdirSync(folder, { recursive: true });
    for (const t of release.media[0]!.tracks) {
      writeFileSync(
        join(folder, `${String(t.position).padStart(2, '0')}.flac`),
        buildFlac({ durationMs: 1000, tags: { title: t.title, artist: 'Radiohead', albumArtist: 'Radiohead', album: 'OK Computer', trackNo: t.position, mbRecordingId: t.recording.id, mbReleaseGroupId: OK_COMPUTER } }),
      );
    }
    const scan = await scanOf(h, 'music');
    expect(scan.candidates).toHaveLength(1);
    const c = scan.candidates[0]!;
    expect(c).toMatchObject({ matchedBy: 'mbid', confidence: 1, detected: expect.objectContaining({ author: 'Radiohead', title: 'OK Computer', year: 1997 }) });
    expect(c.match).toMatchObject({ foreignId: OK_COMPUTER, creditForeignId: ARTIST });
    expect(lookedUp).toEqual([OK_COMPUTER]);

    const res = await h.api('POST', '/libraryimport/import', { scanId: scan.id, items: [{ candidateId: c.id }], qualityProfileId: h.profileId });
    expect(res.statusCode, res.body).toBe(202);
    await h.idle();
    const after = (await h.api('GET', `/libraryimport/scan/${scan.id}`)).json<LibraryImportScan>();
    expect(after.candidates[0]!.status, after.candidates[0]!.message ?? '').toBe('imported');
    expect(after.candidates[0]!.message).toMatch(/Linked 12 files to OK Computer/);

    const artist = h.db.select().from(artists).get()!;
    expect(artist).toMatchObject({ mbArtistId: ARTIST, monitored: true, monitorNewAlbums: 'none' });
    const all = h.db.select().from(albums).where(eq(albums.artistId, artist.id)).all();
    expect(all.length).toBeGreaterThan(1);
    expect(all.filter((a) => a.monitored).map((a) => a.mbReleaseGroupId)).toEqual([OK_COMPUTER]);
    const album = all.find((a) => a.mbReleaseGroupId === OK_COMPUTER)!;
    const linked = () => h.db.select().from(tracks).where(eq(tracks.albumId, album.id)).all().filter((t) => t.hasFile).length;
    expect(linked()).toBe(12);
    expect(h.db.select().from(audioFiles).all().every((r) => r.path.startsWith(folder))).toBe(true);

    // Files outside the (now existing) artist folder survive a rescan.
    mkdirSync(artist.path, { recursive: true });
    const cmd = await h.api('POST', '/command', { name: 'RescanArtist', artistIds: [artist.id] });
    expect(cmd.statusCode, cmd.body).toBe(202);
    await h.idle();
    expect(linked()).toBe(12);
    expect(h.db.select().from(audioFiles).all()).toHaveLength(12);
  });
});
