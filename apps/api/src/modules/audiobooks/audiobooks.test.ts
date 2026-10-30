import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '@arclight/metadata';
import { buildItems } from '@arclight/profiles-engine';
import { QUALITIES, type AuthorDetails, type Book, type BookDetails, type BookSeriesDetails, type CalendarItem, type Job } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import { audioFiles, audioImportExclusions, authors, bookSeries, books, metadataCache, rootFolders } from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor } from '../auth/index.js';
import { buildMp3, buildMp4 } from '../imports/audio/fixtures/builders.js';
import { AUDIOBOOK_CACHE_PROVIDER, audiobookRefresherFor, REFRESH_AUTHORS_JOB, setAudiobookProviders } from '../metadata/index.js';
import { ProfilesService } from '../profiles/index.js';
import { setSection } from '../settings/service.js';
import { booksToMonitor, monitorNewBook, nextAuthorRefreshAt, positionSortOf } from './monitoring.js';
import { audiobookFileQuality } from './quality.js';
import { matchBookGroup, type BookFileGroup, type KnownBook } from './rescan.js';
import { authorSortName, creditRole } from './service.js';

// The audiobooks module over the full app: Audible, Audnexus and OpenLibrary answers come from
// the recorded fixtures in packages/metadata/fixtures/{audible,audnexus,openlibrary} through an
// injected fetch (no network), the rate limiter runs on a virtual clock, and author folders are
// temp directories of tiny tagged m4b / mp3 files.

const FIXTURES = new URL('../../../../../packages/metadata/fixtures/', import.meta.url);
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

const AUTHOR = 'B00G0WYW92';
const PHM = 'B08G9PRS1K';
const AUTHOR_NAME = 'Andy Weir';

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Serves the recorded audiobook fixtures by host and path (as the metadata package's tests do). */
function createFixtureFetch() {
  const calls: string[] = [];
  const fetchImpl = async (input: string) => {
    const url = new URL(input);
    calls.push(`${url.host}${url.pathname}${url.search}`);
    const path = url.pathname;
    const q = url.searchParams;
    if (url.hostname === 'api.audnex.us') {
      if (path === `/books/${PHM}`) return json(fixture('audnexus/book.json'));
      if (path === `/books/${PHM}/chapters`) return json(fixture('audnexus/chapters.json'));
      if (path === `/authors/${AUTHOR}`) return json(fixture('audnexus/author.json'));
      if (path === '/authors') return json(/weir/i.test(q.get('name') ?? '') ? fixture('audnexus/search-authors.json') : []);
      return json(fixture('audnexus/error-404.json'), 404);
    }
    if (url.hostname.startsWith('api.audible.')) {
      if (path !== '/1.0/catalog/products') return json({ message: 'Not found' }, 404);
      const all = `${q.get('title') ?? ''} ${q.get('keywords') ?? ''}`;
      if (q.get('author') === AUTHOR_NAME && !q.get('title')) {
        const pages = ['audible/author-page-0.json', 'audible/author-page-1.json', 'audible/author-page-2.json'];
        const page = pages[Number(q.get('page') ?? '0')];
        return json(page ? fixture(page) : { ...(fixture('audible/empty.json') as object), total_results: 25 });
      }
      if (/project hail mary/i.test(all) && q.get('page') === '0') return json(fixture('audible/search.json'));
      return json(fixture('audible/empty.json'));
    }
    if (url.hostname === 'openlibrary.org') {
      if (path === '/search/authors.json' || path === '/search.json') return json({ numFound: 0, start: 0, docs: [] });
      return new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
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
  calls: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
  api: (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => Promise<{ statusCode: number; body: string; json<T = any>(): T }>;
  idle: () => Promise<void>;
  close: () => Promise<void>;
}

const open: Harness[] = [];
let h: Harness;

async function harness(opts: { audiobooks?: boolean; music?: boolean; languages?: string[] } = {}): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  setSection(db, 'features', { music: opts.music ?? false, audiobooks: opts.audiobooks ?? true });
  setSection(db, 'audiobookMetadata', {
    audibleRegion: 'us',
    audnexusBaseUrl: 'https://api.audnex.us/',
    openLibraryFallback: true,
    languages: opts.languages ?? [],
    audnexusRateLimitPerSecond: 1,
    audibleRateLimitPerSecond: 2,
    openLibraryRateLimitPerSecond: 1,
  });
  const root = mkdtempSync(join(tmpdir(), 'arclight-audiobooks-'));
  db.insert(rootFolders).values({ path: root, mediaType: 'audiobook' }).run();
  const { fetchImpl, calls } = createFixtureFetch();
  let ctxRef: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (ctx) => {
      ctxRef = ctx;
      setAudiobookProviders(ctx, { fetchImpl, rateLimiter: new RateLimiter({ clock: instantClock() }) });
    },
  });
  await app.ready();
  const ctx = ctxRef!;
  const key = authServiceFor(ctx).apiKey();
  const profile = new ProfilesService({ db }).createQualityProfile({
    name: 'Audiobook test',
    upgradeAllowed: true,
    cutoff: QUALITIES['AB-Lossless'].id,
    items: buildItems(['AB-MP3', 'AB-AAC', 'AB-Lossless'], 'audiobook'),
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
    mediaDomain: 'audiobook',
  });
  const value: Harness = {
    db,
    ctx,
    root,
    profileId: profile.id,
    calls,
    api: (method, url, payload) =>
      app.inject({ method, url: `/api/v1${url}`, headers: { 'x-api-key': key }, ...(payload === undefined ? {} : { payload: payload as object }) }),
    idle: () => audiobookRefresherFor(ctx)!.whenIdle(),
    close: async () => {
      await audiobookRefresherFor(ctx)?.whenIdle();
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

async function addWeir(body: Record<string, unknown> = {}): Promise<AuthorDetails> {
  const res = await h.api('POST', '/author', { asin: AUTHOR, rootFolderPath: h.root, qualityProfileId: h.profileId, ...body });
  expect(res.statusCode, res.body).toBe(201);
  await h.idle();
  return (await h.api('GET', `/author/${res.json().id}`)).json<AuthorDetails>();
}

const book = (a: { books: Book[] }, title: string, language = 'english'): Book => {
  const found = a.books.find((b) => b.title === title && b.language === language);
  if (!found) throw new Error(`no ${language} book ${title} in ${a.books.map((b) => `${b.title} (${b.language})`).join(', ')}`);
  return found;
};

function latestJob(name: string): Job | undefined {
  return h.ctx.scheduler.listRecent(200).find((j) => j.name === name);
}

/** Andy Weir/Project Hail Mary/Project Hail Mary.m4b (chaptered, ASIN-tagged) and a two-part The Martian. */
function writeLibrary(authorFolder: string): { phm: string; martian: string } {
  const phm = join(authorFolder, 'Project Hail Mary');
  mkdirSync(phm, { recursive: true });
  writeFileSync(
    join(phm, 'Project Hail Mary.m4b'),
    buildMp4({
      brand: 'M4B ',
      durationMs: 6000,
      tags: { title: 'Project Hail Mary', album: 'Project Hail Mary', artist: AUTHOR_NAME, narrator: 'Ray Porter', asin: PHM },
      chapters: [
        { title: 'Chapter 1', startMs: 0 },
        { title: 'Chapter 2', startMs: 3000 },
      ],
    }),
  );
  const martian = join(authorFolder, 'The Martian');
  mkdirSync(martian, { recursive: true });
  for (const n of [1, 2]) writeFileSync(join(martian, `0${n}.mp3`), buildMp3({ durationMs: 2000, tags: { album: 'The Martian', artist: AUTHOR_NAME, trackNo: n } }));
  const other = join(authorFolder, 'Not A Real Book');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'part.mp3'), buildMp3({ durationMs: 1000 }));
  return { phm, martian };
}

describe('adding an author', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('answers at once, then AuthorAdd loads the bibliography with series, positions and chapters', async () => {
    const res = await h.api('POST', '/author', { asin: AUTHOR.toLowerCase(), rootFolderPath: h.root, qualityProfileId: h.profileId, languages: ['English'] });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ asin: AUTHOR, name: AUTHOR_NAME, sortName: 'Weir, Andy', path: join(h.root, AUTHOR_NAME), languages: ['english'], monitored: true });
    await h.idle();
    expect(latestJob('AuthorAdd')?.status, latestJob('AuthorAdd')?.message ?? '').toBe('completed');

    const details = (await h.api('GET', `/author/${res.json().id}`)).json<AuthorDetails>();
    const titles = details.books.map((b) => b.title);
    expect(titles).toEqual(expect.arrayContaining(['Project Hail Mary', 'The Martian', 'Artemis', 'The Egg', 'Forward', 'Randomize']));
    // Language filter: the German, French, Spanish ... editions are not loaded.
    expect(details.books.every((b) => b.language === 'english')).toBe(true);
    expect(titles).not.toContain('Der Marsianer');
    expect(details.overview).toMatch(/software engineer/);
    expect(details.lastRefreshed).toBeTruthy();

    // Series with positions; standalone books have none.
    const forward = details.series.find((s) => s.name === 'Forward Collection');
    expect(forward).toMatchObject({ bookCount: 2, availableBookCount: 0 });
    expect(book(details, 'Forward').series).toEqual([expect.objectContaining({ name: 'Forward Collection', position: '1-6', positionSort: 1, isPrimary: true })]);
    expect(book(details, 'Randomize').series[0]).toMatchObject({ position: null });
    expect(book(details, 'The Martian').series).toEqual([]);
    const seriesDetails = (await h.api('GET', `/bookseries/${forward!.id}`)).json<BookSeriesDetails>();
    expect(seriesDetails.books.map((b) => b.title)).toEqual(['Forward', 'Randomize']);
    expect(seriesDetails.authors.map((a) => a.name)).toEqual([AUTHOR_NAME]);
    expect((await h.api('GET', `/bookseries?authorId=${details.id}`)).json().map((s: { name: string }) => s.name)).toEqual(['Forward Collection']);

    // Book details: narrators, credits, chapters (Audnexus), no files yet.
    const phm = (await h.api('GET', `/book/${book(details, 'Project Hail Mary').id}`)).json<BookDetails>();
    expect(phm).toMatchObject({ asin: PHM, author: { name: AUTHOR_NAME }, contributors: [], files: [], monitored: true, hasFile: false });
    expect(phm.narrators.length).toBeGreaterThan(0);
    expect(phm.chapters.length).toBeGreaterThan(5);
    expect(phm.authorCredits[0]).toMatchObject({ name: AUTHOR_NAME, authorId: details.id });

    // Statistics.
    expect(details.statistics).toMatchObject({ bookCount: details.books.length, monitoredBookCount: details.books.length, availableBookCount: 0, seriesCount: 1, percentOfBooks: 0 });
    const lib = (await h.api('GET', '/library/statistics')).json();
    expect(lib).toMatchObject({ authorCount: 1, monitoredAuthorCount: 1, bookCount: details.books.length, bookFileCount: 0, audioSizeOnDisk: 0 });
    expect(lib.artistCount).toBeUndefined();

    // The bibliography, author and chapters are cached persistently.
    const cached = h.db.select().from(metadataCache).where(eq(metadataCache.provider, AUDIOBOOK_CACHE_PROVIDER)).all().map((r) => r.key);
    expect(cached).toEqual(expect.arrayContaining([`author/us/asin:${AUTHOR}`, `author-books/us/asin:${AUTHOR}?languages=english`, `chapters/us/${PHM}`]));
  });

  it('keeps every language without a filter: one title in two languages stays two books; a filter added later drops them', async () => {
    const all = await addWeir();
    const artemis = all.books.filter((b) => b.title === 'Artemis');
    expect(artemis.map((b) => b.language).sort()).toEqual(['english', 'german', 'german']);
    expect(new Set(artemis.map((b) => b.asin)).size).toBe(3);
    expect(all.books.some((b) => b.title === 'Der Marsianer')).toBe(true);

    // The setting applies to authors without their own list.
    setSection(h.db, 'audiobookMetadata', { ...readSettings(), languages: ['english'] });
    const res = await h.api('POST', '/command', { name: 'RefreshAuthor', authorIds: [all.id] });
    expect(res.statusCode, res.body).toBe(202);
    await h.idle();
    expect(latestJob('RefreshAuthor')?.status, latestJob('RefreshAuthor')?.message ?? '').toBe('completed');
    const after = (await h.api('GET', `/author/${all.id}`)).json<AuthorDetails>();
    expect(after.books.every((b) => b.language === 'english')).toBe(true);
    expect(after.books.filter((b) => b.title === 'Artemis')).toHaveLength(1);
  });

  it('rejects a second add, a music profile and an unknown root folder', async () => {
    await addWeir();
    expect((await h.api('POST', '/author', { asin: AUTHOR, rootFolderPath: h.root, qualityProfileId: h.profileId })).statusCode).toBe(409);
    const video = new ProfilesService({ db: h.db }).listQualityProfiles('video')[0]!;
    const other = { asin: 'B000000001', rootFolderPath: h.root };
    expect((await h.api('POST', '/author', { ...other, qualityProfileId: video.id })).json().error).toMatch(/video profile/);
    expect((await h.api('POST', '/author', { ...other, rootFolderPath: join(h.root, 'nope'), qualityProfileId: h.profileId })).statusCode).toBe(400);
    expect((await h.api('POST', '/author', { rootFolderPath: h.root, qualityProfileId: h.profileId })).statusCode).toBe(400);
  });

  it('looks authors and books up and marks the ones already in the library', async () => {
    const before = (await h.api('GET', '/author/lookup?term=andy%20weir')).json();
    expect(before[0]).toMatchObject({ asin: AUTHOR, name: AUTHOR_NAME, authorId: null });
    const byAsin = (await h.api('GET', `/author/lookup?term=${AUTHOR}`)).json();
    expect(byAsin).toEqual([expect.objectContaining({ asin: AUTHOR, source: 'audnexus' })]);
    const added = await addWeir({ languages: ['english'] });
    expect((await h.api('GET', '/author/lookup?term=andy%20weir')).json()[0].authorId).toBe(added.id);

    const books = (await h.api('GET', '/book/lookup?term=project%20hail%20mary')).json();
    const hit = books.find((b: { asin: string }) => b.asin === PHM);
    expect(hit).toMatchObject({ title: 'Project Hail Mary', bookId: book(added, 'Project Hail Mary').id, authorId: added.id, source: 'audible' });
    const exact = (await h.api('GET', `/book/lookup?asin=${PHM}`)).json();
    expect(exact).toEqual([expect.objectContaining({ asin: PHM, source: 'audnexus', bookId: hit.bookId })]);
    expect((await h.api('GET', '/book/lookup?asin=B000000000')).json()).toEqual([]);
    expect((await h.api('GET', '/book/lookup')).statusCode).toBe(400);
  });
});

function readSettings() {
  return { audibleRegion: 'us' as const, audnexusBaseUrl: 'https://api.audnex.us/', openLibraryFallback: true, languages: [] as string[], audnexusRateLimitPerSecond: 1, audibleRateLimitPerSecond: 2, openLibraryRateLimitPerSecond: 1 };
}

describe('adding a single book', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('needs an author block for an unknown author, then creates the author with the rest unmonitored', async () => {
    const without = await h.api('POST', '/book', { asin: PHM });
    expect(without.statusCode).toBe(400);
    expect(without.json().error).toMatch(/Andy Weir is not in the library/);
    expect(h.db.select().from(books).all()).toHaveLength(0);

    const res = await h.api('POST', '/book', { asin: PHM, author: { rootFolderPath: h.root, qualityProfileId: h.profileId } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ asin: PHM, title: 'Project Hail Mary', monitored: true });
    await h.idle();
    const author = h.db.select().from(authors).get()!;
    expect(author).toMatchObject({ asin: AUTHOR, name: AUTHOR_NAME, monitorNewBooks: 'none', monitored: true });
    const details = (await h.api('GET', `/author/${author.id}`)).json<AuthorDetails>();
    expect(details.books.length).toBeGreaterThan(10);
    expect(details.books.filter((b) => b.monitored).map((b) => b.asin)).toEqual([PHM]);

    expect((await h.api('POST', '/book', { asin: PHM })).statusCode).toBe(409);
  });

  it('adds a book to an author already in the library', async () => {
    const added = await addWeir({ languages: ['english'] });
    const phm = book(added, 'Project Hail Mary');
    expect((await h.api('DELETE', `/book/${phm.id}`)).statusCode).toBe(204);
    const res = await h.api('POST', '/book', { asin: PHM, monitored: false });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ authorId: added.id, monitored: false });
  });
});

describe('monitoring', () => {
  beforeEach(async () => {
    h = await harness({ languages: ['english'] });
  });

  it('applies the monitor option on add and on update', async () => {
    const first = await addWeir({ monitorOption: 'first' });
    expect(first.books.filter((b) => b.monitored).map((b) => b.title)).toEqual(['The Egg']);

    await h.api('PUT', `/author/${first.id}`, { monitorOption: 'inSeries' });
    const inSeries = (await h.api('GET', `/book?authorId=${first.id}&monitored=true`)).json<Book[]>();
    expect(inSeries.map((b) => b.title).sort()).toEqual(['Forward', 'Randomize']);
    expect((await h.api('GET', `/book?authorId=${first.id}&monitored=false`)).json().length).toBe(first.books.length - 2);

    const ids = first.books.slice(0, 3).map((b) => b.id);
    const bulk = (await h.api('PUT', '/book/monitor', { bookIds: ids, monitored: true })).json<Book[]>();
    expect(bulk.every((b) => b.monitored)).toBe(true);
    expect((await h.api('PUT', `/book/${ids[0]}`, { monitored: false })).json().monitored).toBe(false);
    expect((await h.api('PUT', '/book/monitor', { bookIds: [9999], monitored: true })).statusCode).toBe(404);
  });

  it('none leaves the author and the books unmonitored', async () => {
    const none = await addWeir({ monitorOption: 'none' });
    expect(none.monitored).toBe(false);
    expect(none.books.some((b) => b.monitored)).toBe(false);
  });

  it('a refresh applies monitorNewBooks to books that appeared since', async () => {
    const added = await addWeir({ monitorNewBooks: 'none' });
    const egg = book(added, 'The Egg');
    h.db.delete(books).where(eq(books.id, egg.id)).run();
    audiobookRefresherFor(h.ctx)!.refresh([added.id]);
    await h.idle();
    expect(latestJob('RefreshAuthor')?.message).toMatch(/1 new/);
    const after = (await h.api('GET', `/author/${added.id}`)).json<AuthorDetails>();
    expect(book(after, 'The Egg').monitored).toBe(false);

    await h.api('PUT', `/author/${added.id}`, { monitorNewBooks: 'inSeries' });
    for (const title of ['Randomize', 'The Egg']) h.db.delete(books).where(eq(books.id, book(after, title).id)).run();
    audiobookRefresherFor(h.ctx)!.refresh([added.id]);
    await h.idle();
    const later = (await h.api('GET', `/author/${added.id}`)).json<AuthorDetails>();
    expect(book(later, 'Randomize').monitored).toBe(true);
    expect(book(later, 'The Egg').monitored).toBe(false);
    expect(later.series.find((s) => s.name === 'Forward Collection')?.bookCount).toBe(2);
  });

  it('pure rules: monitor options, new books, refresh interval and positions', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const list = [
      { id: 1, releaseDate: '2014-11-26', hasFiles: true, inSeries: false },
      { id: 2, releaseDate: '2019-10-08', hasFiles: false, inSeries: true },
      { id: 3, releaseDate: '2026-12-01', hasFiles: false, inSeries: true },
    ];
    expect([...booksToMonitor('latest', list, now)]).toEqual([2]);
    expect([...booksToMonitor('first', list, now)]).toEqual([1]);
    expect([...booksToMonitor('future', list, now)]).toEqual([3]);
    expect([...booksToMonitor('existing', list, now)]).toEqual([1]);
    expect([...booksToMonitor('inSeries', list, now)]).toEqual([2, 3]);
    expect(monitorNewBook('inSeries', false)).toBe(false);
    expect(monitorNewBook('all', false)).toBe(true);
    const days = (iso: string) => Math.round((Date.parse(iso) - now.getTime()) / 86_400_000);
    expect(days(nextAuthorRefreshAt([{ releaseDate: '2026-12-01', monitored: true }], now))).toBe(1);
    expect(days(nextAuthorRefreshAt([{ releaseDate: '2026-12-01', monitored: false }], now))).toBe(7);
    expect(days(nextAuthorRefreshAt([{ releaseDate: '2014-01-01', monitored: true }], now))).toBe(7);
    expect([positionSortOf('3'), positionSortOf('2.5'), positionSortOf('1-6'), positionSortOf('Prequel'), positionSortOf(null)]).toEqual([3, 2.5, 1, null, null]);
    expect(authorSortName('Andy Weir')).toBe('Weir, Andy');
    expect(authorSortName('Martin Luther King Jr.')).toBe('King, Martin Luther Jr.');
    expect(authorSortName('Plato')).toBe('Plato');
    expect(creditRole('Nenad Savic - traducteur')).toEqual({ name: 'Nenad Savic', role: 'translator' });
  });
});

describe('rescan, statistics and wanted', () => {
  beforeEach(async () => {
    h = await harness({ languages: ['english'] });
  });

  it('"Allow upgrades again" clears a "Grab anyway" override on every part of the book', async () => {
    writeLibrary(join(h.root, AUTHOR_NAME));
    const martian = book(await addWeir(), 'The Martian');
    h.db.update(audioFiles).set({ grabOverride: { rejections: ['Size limit exceeded'], grabbedAt: '2026-10-01T00:00:00.000Z' } }).where(eq(audioFiles.bookId, martian.id)).run();
    const parts = (await h.api('GET', `/audiofile?bookId=${martian.id}`)).json<Array<{ id: number; grabOverride: unknown }>>();
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.grabOverride !== null)).toBe(true);
    const cleared = await h.api('DELETE', `/audiofile/${parts[0]!.id}/grab-override`);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<Array<{ id: number; grabOverride: unknown }>>().map((f) => [f.id, f.grabOverride])).toEqual(parts.map((p) => [p.id, null]));
    expect((await h.api('DELETE', `/audiofile/${parts[0]!.id}/grab-override`)).json()).toEqual([]);
    expect((await h.api('DELETE', '/audiofile/999999/grab-override')).statusCode).toBe(404);
  });

  it('rescans an existing folder on add: audio_files, has_file, path, parts and file chapters', async () => {
    const folders = writeLibrary(join(h.root, AUTHOR_NAME));
    const added = await addWeir();
    expect(latestJob('AuthorAdd')?.message).toMatch(/2 books with files \(3 files\), 3 new, 1 unmatched/);

    const phm = book(added, 'Project Hail Mary');
    expect(phm).toMatchObject({ hasFile: true, path: folders.phm, statistics: { fileCount: 1 } });
    const details = (await h.api('GET', `/book/${phm.id}`)).json<BookDetails>();
    expect(details.files).toEqual([
      expect.objectContaining({ mediaType: 'audiobook', authorId: added.id, bookId: phm.id, partNumber: null, chapterCount: 2, quality: expect.objectContaining({ quality: expect.objectContaining({ name: 'AB-AAC-Low' }) }) }), // the fixture's bitrate is tiny
    ]);
    expect(details.files[0]!.relativePath).toMatch(/^Project Hail Mary[\\/]Project Hail Mary\.m4b$/);
    expect(details.files[0]!.tags).toMatchObject({ asin: PHM, narrator: 'Ray Porter' });

    const martian = book(added, 'The Martian');
    expect(martian).toMatchObject({ hasFile: true, path: folders.martian });
    const parts = (await h.api('GET', `/audiofile?bookId=${martian.id}`)).json();
    expect(parts.map((f: { partNumber: number; quality: { quality: { name: string } } }) => [f.partNumber, f.quality.quality.name])).toEqual([
      [1, 'AB-MP3-Low'],
      [2, 'AB-MP3-Low'],
    ]);
    expect((await h.api('GET', `/audiofile?authorId=${added.id}`)).json()).toHaveLength(3);
    expect((await h.api('GET', `/audiofile?authorId=${added.id}&artistId=1`)).statusCode).toBe(400);

    // Statistics.
    expect(added.statistics).toMatchObject({ availableBookCount: 2, fileCount: 3 });
    expect(added.statistics!.sizeOnDisk).toBeGreaterThan(0);
    expect(added.statistics!.percentOfBooks).toBeCloseTo((2 / added.books.length) * 100, 0);
    const lib = (await h.api('GET', '/library/statistics')).json();
    expect(lib).toMatchObject({ authorCount: 1, bookFileCount: 2, audioSizeOnDisk: added.statistics!.sizeOnDisk });

    // A removed part is dropped on the next rescan; a removed book loses has_file.
    rmSync(join(folders.martian, '02.mp3'));
    rmSync(folders.phm, { recursive: true });
    const res = await h.api('POST', '/command', { name: 'RescanAuthor', authorIds: [added.id] });
    expect(res.statusCode, res.body).toBe(202);
    await h.idle();
    expect(latestJob('RescanAuthor')?.message).toMatch(/1 books with files \(1 files\), 2 removed/);
    expect(h.db.select().from(audioFiles).all()).toHaveLength(1);
    expect(h.db.select().from(books).where(eq(books.id, phm.id)).get()?.hasFile).toBe(false);
  });

  it('wanted: missing books until the file is there, then cutoff unmet below the profile cutoff', async () => {
    const added = await addWeir();
    const phm = book(added, 'Project Hail Mary');
    const missing = (await h.api('GET', '/wanted/missing/books?pageSize=100')).json();
    expect(missing.records.find((r: { id: number }) => r.id === phm.id)).toMatchObject({ authorName: AUTHOR_NAME, qualityProfileId: h.profileId });
    expect((await h.api('GET', '/wanted/cutoff/books')).json().totalRecords).toBe(0);

    writeLibrary(added.path);
    await h.api('POST', '/command', { name: 'RescanAuthor', authorIds: [added.id] });
    await h.idle();
    const after = (await h.api('GET', '/wanted/missing/books?pageSize=100')).json();
    expect(after.records.map((r: { id: number }) => r.id)).not.toContain(phm.id);
    // AAC and low MP3 are below the AB-Lossless cutoff.
    const cutoff = (await h.api('GET', '/wanted/cutoff/books')).json();
    expect(cutoff.records.map((r: { title: string }) => r.title).sort()).toEqual(['Project Hail Mary', 'The Martian']);

    await h.api('PUT', `/author/${added.id}`, { monitored: false });
    expect((await h.api('GET', '/wanted/missing/books')).json().totalRecords).toBe(0);
  });

  it('wanted books: q matches title, author name and series name', async () => {
    const added = await addWeir();
    type Page = { totalRecords: number; records: Array<{ id: number; title: string; series: Array<{ name: string }> }> };
    const get = async (url: string) => (await h.api('GET', url)).json() as Page;
    const all = await get('/wanted/missing/books?pageSize=100');
    const phm = book(added, 'Project Hail Mary');
    expect((await get('/wanted/missing/books?q=hail.mary')).records.map((r) => r.id)).toEqual([phm.id]);
    expect((await get('/wanted/missing/books?pageSize=100&q=andy%20WEIR')).totalRecords).toBe(all.totalRecords);
    const inSeries = all.records.filter((r) => r.series.some((s) => s.name === 'Forward Collection')).map((r) => r.id);
    expect(inSeries.length).toBeGreaterThan(0);
    expect((await get('/wanted/missing/books?pageSize=100&q=forward%20collection')).records.map((r) => r.id)).toEqual(inSeries);
    expect((await get('/wanted/missing/books?q=weir%20nonexistent')).totalRecords).toBe(0);

    writeLibrary(added.path);
    await h.api('POST', '/command', { name: 'RescanAuthor', authorIds: [added.id] });
    await h.idle();
    expect((await get('/wanted/cutoff/books?q=martian')).records.map((r) => r.title)).toEqual(['The Martian']);
  });

  it('matches folders by ASIN, then series and position, then title, preferring the kept language', () => {
    const books: KnownBook[] = [
      { id: 1, title: 'Artemis', subtitle: null, asin: 'B079LSG4Q9', language: 'german', monitored: true, series: [] },
      { id: 2, title: 'Artemis', subtitle: null, asin: 'B072R1CY4P', language: 'english', monitored: true, series: [] },
      { id: 3, title: 'Forward', subtitle: null, asin: '1799755193', language: 'english', monitored: true, series: [{ name: 'Forward Collection', position: '1-6', positionSort: 1 }] },
      { id: 4, title: 'The Egg', subtitle: 'A Short Story', asin: 'B00Q5NQ3DO', language: 'english', monitored: true, series: [] },
    ];
    const group = (g: Partial<BookFileGroup>): BookFileGroup => ({ folder: '/x', files: [], asin: null, title: null, series: null, seriesPosition: null, tagTitles: [], ...g });
    expect(matchBookGroup(group({ asin: 'B079LSG4Q9', title: 'whatever' }), books)).toEqual({ bookId: 1, matchedBy: 'asin' });
    expect(matchBookGroup(group({ title: 'Artemis' }), books, { preferredLanguages: ['english'] })).toEqual({ bookId: 2, matchedBy: 'title' });
    expect(matchBookGroup(group({ title: 'Artemis' }), books, { preferredLanguages: ['german'] })).toEqual({ bookId: 1, matchedBy: 'title' });
    expect(matchBookGroup(group({ series: 'Forward Collection', seriesPosition: '1-6', title: 'Something Else' }), books)).toEqual({ bookId: 3, matchedBy: 'series' });
    expect(matchBookGroup(group({ tagTitles: ['The Egg: A Short Story'] }), books)).toEqual({ bookId: 4, matchedBy: 'title' });
    expect(matchBookGroup(group({ title: 'Nothing Like It' }), books)).toBeNull();
    expect(audiobookFileQuality({ codec: 'FLAC', bitrateKbps: 700 }).quality.name).toBe('AB-Lossless');
    expect(audiobookFileQuality({ codec: 'MPEG 1 Layer 3', bitrateKbps: 126 }).quality.name).toBe('AB-MP3-High');
  });
});

describe('deletes', () => {
  beforeEach(async () => {
    h = await harness({ languages: ['english'] });
  });

  it('deleting a book removes its files, rows and orphaned series and keeps it out with an exclusion', async () => {
    const folders = writeLibrary(join(h.root, AUTHOR_NAME));
    const added = await addWeir();
    const phm = book(added, 'Project Hail Mary');
    expect((await h.api('DELETE', `/book/${phm.id}?deleteFiles=true&addExclusion=true`)).statusCode).toBe(204);
    expect(existsSync(folders.phm)).toBe(false);
    expect(existsSync(folders.martian)).toBe(true);
    expect(h.db.select().from(audioFiles).where(eq(audioFiles.bookId, phm.id)).all()).toEqual([]);
    expect(h.db.select().from(audioImportExclusions).all()).toEqual([expect.objectContaining({ mediaType: 'audiobook', foreignId: PHM, title: 'Project Hail Mary' })]);

    // Excluded: a refresh does not bring it back, and adding it explicitly is refused.
    audiobookRefresherFor(h.ctx)!.refresh([added.id]);
    await h.idle();
    expect(h.db.select().from(books).where(eq(books.asin, PHM)).get()).toBeUndefined();
    expect((await h.api('POST', '/book', { asin: PHM })).statusCode).toBe(409);

    // A series is pruned with its last book.
    for (const title of ['Forward', 'Randomize']) expect((await h.api('DELETE', `/book/${book(added, title).id}`)).statusCode).toBe(204);
    expect(h.db.select().from(bookSeries).all()).toEqual([]);
  });

  it('deleting an author removes books, series and audio_files; deleteFiles and addExclusion are honoured', async () => {
    const folders = writeLibrary(join(h.root, AUTHOR_NAME));
    const added = await addWeir();
    expect((await h.api('DELETE', `/author/${added.id}?deleteFiles=false&addExclusion=true`)).statusCode).toBe(204);
    expect(existsSync(folders.phm)).toBe(true);
    expect(h.db.select().from(books).all()).toEqual([]);
    expect(h.db.select().from(bookSeries).all()).toEqual([]);
    expect(h.db.select().from(audioFiles).all()).toEqual([]);
    expect(h.db.select().from(audioImportExclusions).all()).toEqual([expect.objectContaining({ foreignId: AUTHOR, title: AUTHOR_NAME })]);
    expect((await h.api('POST', '/author', { asin: AUTHOR, rootFolderPath: h.root, qualityProfileId: h.profileId })).json().error).toMatch(/exclusion list/);

    h.db.delete(audioImportExclusions).run();
    const again = await addWeir();
    expect((await h.api('DELETE', `/author/${again.id}?deleteFiles=true`)).statusCode).toBe(204);
    expect(existsSync(join(h.root, AUTHOR_NAME))).toBe(false);
    expect((await h.api('GET', `/author/${again.id}`)).statusCode).toBe(404);
  });
});

describe('scheduled refresh, commands and the editor', () => {
  beforeEach(async () => {
    h = await harness({ languages: ['english'] });
  });

  it('RefreshAuthors refreshes due authors from the persistent cache', async () => {
    const added = await addWeir();
    h.db.update(authors).set({ nextRefreshAt: '2000-01-01T00:00:00.000Z' }).where(eq(authors.id, added.id)).run();
    h.calls.length = 0;
    const job = await h.ctx.scheduler.run(REFRESH_AUTHORS_JOB, 'manual');
    expect(job.status, job.message ?? '').toBe('completed');
    expect(job.message).toMatch(/refreshed 1 of 1 due authors/);
    expect(h.calls.filter((c) => c.startsWith('api.audible.com') || c.startsWith(`api.audnex.us/authors/${AUTHOR}`))).toEqual([]);
    const row = h.db.select().from(authors).where(eq(authors.id, added.id)).get()!;
    expect(row.nextRefreshAt! > new Date().toISOString()).toBe(true);
    expect((await h.ctx.scheduler.run(REFRESH_AUTHORS_JOB, 'manual')).message).toMatch(/refreshed 0 of 0/);
  });

  it('search commands run as jobs; unknown ids are 404; bad commands 400', async () => {
    const added = await addWeir();
    expect((await h.api('POST', '/command', { name: 'AuthorSearch', authorIds: [added.id] })).statusCode).toBe(202);
    expect((await h.api('POST', '/command', { name: 'BookSearch', bookIds: [added.books[0]!.id] })).statusCode).toBe(202);
    await h.idle();
    expect(latestJob('AuthorSearch')?.status).toBe('completed');
    expect(latestJob('BookSearch')?.status).toBe('completed');
    expect((await h.api('POST', '/command', { name: 'RefreshAuthor', authorIds: [9999] })).statusCode).toBe(404);
    expect((await h.api('POST', '/command', { name: 'BookSearch', bookIds: [9999] })).statusCode).toBe(404);
    expect((await h.api('POST', '/command', { name: 'Nope' })).statusCode).toBe(400);
    // Music commands go to music, which is off here.
    expect((await h.api('POST', '/command', { name: 'RefreshArtist', artistIds: [1] })).json().code).toBe('MUSIC_DISABLED');
    expect((await h.api('GET', '/audiofile?artistId=1')).json().code).toBe('MUSIC_DISABLED');
  });

  it('bulk-edits authors; deleting a tag strips it from authors', async () => {
    const added = await addWeir();
    const tag = (await h.api('POST', '/tag', { label: 'scifi' })).json();
    const res = await h.api('PUT', '/author/editor', { ids: [added.id], monitored: false, tags: { add: [tag.id] }, monitorNewBooks: 'inSeries' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()[0]).toMatchObject({ monitored: false, tags: [tag.id], monitorNewBooks: 'inSeries' });
    expect((await h.api('GET', `/author?tag=${tag.id}`)).json()).toHaveLength(1);
    await h.api('DELETE', `/tag/${tag.id}`);
    expect((await h.api('GET', `/author/${added.id}`)).json().tags).toEqual([]);
    expect((await h.api('PUT', `/author/${added.id}`, { languages: ['English', 'german'] })).json().languages).toEqual(['english', 'german']);
  });
});

describe('calendar', () => {
  beforeEach(async () => {
    h = await harness({ languages: ['english'] });
  });

  it('lists book release dates as book items and in the iCal feed', async () => {
    const added = await addWeir();
    const items = (await h.api('GET', '/calendar?start=2021-05-01&end=2021-05-31')).json<CalendarItem[]>();
    const bookItems = items.filter((i) => i.type === 'book');
    expect(bookItems.map((i) => (i.type === 'book' ? `${i.authorName} - ${i.book.title}` : ''))).toEqual(['Andy Weir - Project Hail Mary']);
    expect(bookItems[0]).toMatchObject({ date: '2021-05-04', authorId: added.id, author: { name: AUTHOR_NAME, monitored: true } });
    expect((await h.api('GET', '/calendar?start=2021-05-01&end=2021-05-31&mediaType=audiobook')).json()).toHaveLength(1);
    expect((await h.api('GET', '/calendar?start=2021-05-01&end=2021-05-31&mediaType=movie')).json()).toEqual([]);

    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const egg = book(added, 'The Egg');
    h.db.update(books).set({ releaseDate: soon }).where(eq(books.id, egg.id)).run();
    const feed = (await h.api('GET', '/calendar/feed')).json();
    const ics = await h.api('GET', `/calendar/feed.ics?token=${feed.token}`);
    expect(ics.statusCode).toBe(200);
    expect(ics.body).toContain(`UID:arclight-book-${egg.id}@arclight`);
    expect(ics.body).toContain(`DTSTART;VALUE=DATE:${soon.replace(/-/g, '')}`);
  });
});

describe('the audiobooks feature flag', () => {
  beforeEach(async () => {
    h = await harness({ audiobooks: false });
  });

  it('hides every audiobook route, calendar item, statistic and job while off', async () => {
    for (const [method, url, body] of [
      ['GET', '/author'],
      ['GET', '/author/1'],
      ['GET', '/author/lookup?term=weir'],
      ['POST', '/author', { asin: AUTHOR, rootFolderPath: h.root, qualityProfileId: h.profileId }],
      ['GET', '/book'],
      ['POST', '/book', { asin: PHM }],
      ['GET', '/book/lookup?term=weir'],
      ['GET', '/bookseries'],
      ['GET', '/wanted/missing/books'],
      ['GET', '/wanted/cutoff/books'],
      ['GET', '/audiofile?authorId=1'],
      ['POST', '/command', { name: 'RefreshAuthor', authorIds: [1] }],
    ] as const) {
      const res = await h.api(method, url, body);
      expect([url, res.statusCode]).toEqual([url, 404]);
      expect(res.json().code).toBe('AUDIOBOOKS_DISABLED');
    }
    expect(h.calls).toEqual([]);
    expect((await h.ctx.scheduler.run(REFRESH_AUTHORS_JOB, 'manual')).message).toMatch(/skipped: audiobooks are not enabled/);
    expect((await h.api('GET', '/library/statistics')).json().authorCount).toBeUndefined();

    // Rows left from when audiobooks were on do not reach the calendar.
    setSection(h.db, 'features', { music: false, audiobooks: true });
    await addWeir({ languages: ['english'] });
    setSection(h.db, 'features', { music: false, audiobooks: false });
    const items = (await h.api('GET', '/calendar?start=2021-05-01&end=2021-05-31')).json<CalendarItem[]>();
    expect(items.filter((i) => i.type === 'book')).toEqual([]);
  });
});
