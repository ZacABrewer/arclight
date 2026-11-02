import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { MetadataError, RateLimiter, type BookCatalog, type BookRecord, type ComicIssueRecord, type ComicSeriesRecord } from '@arclight/metadata';
import { Permission, SECRET_MASK, type BooksSettingsInput, type ReleaseResource } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import { metadataCache, rootFolders } from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor, SESSION_COOKIE } from '../auth/index.js';
import type { TrackedDownload } from '../download-clients/service.js';
import { getSection, setSection } from '../settings/service.js';
import { booksServicesFor, setBooksOverrides, type BooksOverrides } from './index.js';
import { seedFormatProfiles } from './profiles.js';
import { bookFiles, bookGrabs, ebooks } from './schema.js';

// The Books module over the full app: the catalogue is a scripted BookCatalog (or the real one
// over a failing fetch, for the cache), indexers and download clients are fakes, and root
// folders are temp directories. No network.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

const AUTHOR_KEY = 'ol:OL79034A';
const DUNE: BookRecord = {
  key: 'isbn:9780441013593',
  keys: ['isbn:9780441013593', 'ol:OL893415W'],
  title: 'Dune',
  authors: [{ name: 'Frank Herbert', key: AUTHOR_KEY }],
  isbn13: '9780441013593',
  isbns: ['9780441013593'],
  olWorkId: 'OL893415W',
  language: 'en',
  releaseDate: '1965-08-01',
  genres: ['Science fiction'],
  series: [{ name: 'Dune', position: '1' }],
  sources: ['openLibrary'],
};
const MESSIAH: BookRecord = { ...DUNE, key: 'isbn:9780441172696', keys: ['isbn:9780441172696'], title: 'Dune Messiah', isbn13: '9780441172696', isbns: ['9780441172696'], olWorkId: 'OL893526W', releaseDate: '1969-10-01', series: [{ name: 'Dune', position: '2' }] };
const SAGA: ComicSeriesRecord = { key: 'cv:43170', keys: ['cv:43170'], title: 'Saga', publisher: 'Image', startYear: 2012, issueCount: 2, comicVineId: '43170', sources: ['comicVine'] };
const SAGA_ISSUES: ComicIssueRecord[] = [
  { key: 'cv-issue:1', keys: ['cv-issue:1'], issueNumber: '1', coverDate: '2012-03-14', sources: ['comicVine'] },
  { key: 'cv-issue:2', keys: ['cv-issue:2'], issueNumber: '2', coverDate: '2012-04-11', sources: ['comicVine'] },
];

const ok = <T>(value: T) => ({ value, sources: [{ source: 'openLibrary' as const, state: 'ok' as const }] });
const notFound = () => new MetadataError('not-found', 'not found');

/** A scripted catalogue: Frank Herbert with two books, and Saga with two issues. */
function fakeCatalog(): BookCatalog {
  const author = { key: AUTHOR_KEY, keys: [AUTHOR_KEY], name: 'Frank Herbert', olAuthorId: 'OL79034A', sources: ['openLibrary' as const] };
  const books = [DUNE, MESSIAH];
  return {
    searchAuthors: async () => ok([author]),
    searchBooks: async (term) => ok(books.filter((b) => b.title.toLowerCase().includes(term.toLowerCase()))),
    getAuthorWithBooks: async (key) => {
      if (key !== AUTHOR_KEY) throw notFound();
      return ok({ author, books });
    },
    getBook: async (key) => {
      const hit = books.find((b) => b.keys.includes(key));
      if (!hit) throw notFound();
      return ok(hit);
    },
    searchComicSeries: async () => ok([SAGA]),
    getComicSeries: async (key) => {
      if (key !== SAGA.key) throw notFound();
      return ok({ series: SAGA, issues: SAGA_ISSUES });
    },
  };
}

function releaseOf(title: string, guid = title): ReleaseResource {
  return {
    guid,
    title,
    size: 2 * 1024 * 1024,
    publishDate: '2026-10-01T00:00:00Z',
    downloadUrl: `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=${encodeURIComponent(guid)}`,
    seeders: 20,
    categories: [7020],
    indexerId: 1,
    indexerName: 'Example indexer',
    indexerPriority: 25,
    protocol: 'torrent',
    age: 30,
    ageHours: 720,
    ageMinutes: 43200,
    rejections: [],
  } as unknown as ReleaseResource;
}

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
  dirs: { ebooks: string; comics: string; downloads: string };
  key: string;
  grabs: Array<{ title: string }>;
  imported: number[];
  call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
}

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.app.close();
    for (const d of Object.values(h.dirs)) rmSync(d, { recursive: true, force: true });
  }
});

async function harness(opts: { releases?: ReleaseResource[]; overrides?: Partial<BooksOverrides> } = {}): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  setSection(db, 'features', { music: false, audiobooks: false, books: true });
  const dirs = { ebooks: mkdtempSync(join(tmpdir(), 'books-ebooks-')), comics: mkdtempSync(join(tmpdir(), 'books-comics-')), downloads: mkdtempSync(join(tmpdir(), 'books-dl-')) };
  db.insert(rootFolders).values({ path: dirs.ebooks, mediaType: 'ebook' }).run();
  db.insert(rootFolders).values({ path: dirs.comics, mediaType: 'comic' }).run();
  const grabs: Array<{ title: string }> = [];
  const imported: number[] = [];
  let next = 0;
  let ctx: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (c) => {
      ctx = c;
      setBooksOverrides(c, {
        catalog: { catalog: fakeCatalog() },
        indexers: { search: async () => opts.releases ?? [], downloadRelease: async () => ({ kind: 'magnet', magnetUrl: 'magnet:?x' }) as never, downloadClientIdOf: () => null },
        downloads: {
          grab: async (_client, request) => {
            grabs.push({ title: request.title });
            next += 1;
            return { downloadId: `dl-${next}`, title: request.title };
          },
        },
        importDownloads: { setState: () => undefined, markImported: async (id) => void imported.push(id), setImportProgress: () => undefined },
        ...opts.overrides,
      });
    },
  });
  await app.ready();
  const key = authServiceFor(ctx!).apiKey();
  const h: Harness = {
    app,
    ctx: ctx!,
    db,
    dirs,
    key,
    grabs,
    imported,
    async call(method, url, payload, headers) {
      const res = await app.inject({ method, url: `/api/v1${url}`, headers: headers ?? { 'x-api-key': key }, ...(payload !== undefined ? { payload: payload as object } : {}) });
      return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as unknown) : null };
    },
  };
  open.push(h);
  return h;
}

async function profileId(h: Harness, kind: 'ebook' | 'comic'): Promise<number> {
  const res = await h.call('GET', '/books/profiles');
  return (res.body as Array<{ id: number; kind: string }>).find((p) => p.kind === kind)!.id;
}

async function addHerbert(h: Harness) {
  const res = await h.call('POST', '/books/authors', { foreignId: AUTHOR_KEY, rootFolderPath: h.dirs.ebooks, formatProfileId: await profileId(h, 'ebook') });
  expect(res.status).toBe(201);
  return res.body as { id: number; name: string };
}

describe('books settings and profiles', () => {
  it('seeds the default profiles once', async () => {
    const h = await harness();
    const profiles = (await h.call('GET', '/books/profiles')).body as Array<{ name: string; formats: string[]; cutoff: string; maxSizeMb: number }>;
    expect(profiles.map((p) => [p.name, p.formats, p.cutoff, p.maxSizeMb])).toEqual([
      ['Ebooks', ['epub', 'azw3', 'mobi', 'pdf'], 'epub', 100],
      ['Comics', ['cbz', 'cbr', 'cb7', 'pdf'], 'cbz', 2000],
    ]);
    expect(seedFormatProfiles(h.db)).toBe(0);
  });

  it('masks catalogue secrets and keeps the stored one when the mask comes back', async () => {
    const h = await harness();
    const current = (await h.call('GET', '/books/settings')).body as BooksSettingsInput & { metadata: Record<string, unknown> };
    const put = await h.call('PUT', '/books/settings', { ...current, metadata: { ...current.metadata, comicVine: true, comicVineApiKey: 'cv-secret' } });
    expect(put.status).toBe(200);
    expect(put.body.metadata.comicVineApiKey).toBe(SECRET_MASK);
    expect(getSection(h.db, 'books').metadata.comicVineApiKey).toBe('cv-secret');
    await h.call('PUT', '/books/settings', { ...put.body, metadata: { ...put.body.metadata, languages: ['en', 'de'] } });
    expect(getSection(h.db, 'books').metadata).toMatchObject({ comicVineApiKey: 'cv-secret', languages: ['en', 'de'] });
    expect((await h.call('PUT', '/books/settings', { metadata: { languages: 'nope' } })).status).toBe(400);
  });

  it('refuses to delete a profile in use (409) and validates formats against the kind', async () => {
    const h = await harness();
    await addHerbert(h);
    const res = await h.call('DELETE', `/books/profiles/${await profileId(h, 'ebook')}`);
    expect(res.status).toBe(409);
    const bad = await h.call('POST', '/books/profiles', { name: 'Bad', kind: 'ebook', formats: ['cbz'], cutoff: 'cbz', upgradeAllowed: true, minSizeMb: 0, maxSizeMb: 0, ignoredTerms: [], preferredTerms: [] });
    expect(bad.status).toBe(400);
  });
});

describe('library', () => {
  it('adds an author with their books, lists wanted and the calendar, and deletes', async () => {
    const h = await harness();
    const author = await addHerbert(h);
    expect(author.name).toBe('Frank Herbert');
    const details = (await h.call('GET', `/books/authors/${author.id}`)).body as { books: Array<{ title: string; monitored: boolean }> };
    expect(details.books.map((b) => b.title).sort()).toEqual(['Dune', 'Dune Messiah']);
    // Adding the same author again conflicts.
    expect((await h.call('POST', '/books/authors', { foreignId: AUTHOR_KEY, rootFolderPath: h.dirs.ebooks, formatProfileId: await profileId(h, 'ebook') })).status).toBe(409);

    const wanted = (await h.call('GET', '/books/wanted?kind=ebook')).body as { totalRecords: number; records: Array<{ title: string; reason: string }> };
    expect(wanted.totalRecords).toBe(2);
    expect(wanted.records.every((r) => r.reason === 'missing')).toBe(true);
    const cal = (await h.call('GET', '/books/calendar?start=1965-01-01&end=1965-12-31')).body as Array<{ title: string }>;
    expect(cal.map((e) => e.title)).toEqual(['Dune']);

    const overview = (await h.call('GET', '/books/overview')).body as { ebookAuthors: number; ebooks: number; wanted: number };
    expect(overview).toMatchObject({ ebookAuthors: 1, ebooks: 2 });

    expect((await h.call('DELETE', `/books/authors/${author.id}`)).status).toBe(204);
    expect((await h.call('GET', `/books/authors/${author.id}`)).status).toBe(404);
  });

  it('adds a comic series with its issues; unknown keys are 404', async () => {
    const h = await harness();
    const res = await h.call('POST', '/books/comics', { foreignId: SAGA.key, rootFolderPath: h.dirs.comics, formatProfileId: await profileId(h, 'comic') });
    expect(res.status).toBe(201);
    const details = (await h.call('GET', `/books/comics/${res.body.id}`)).body as { title: string; issues: Array<{ issueNumber: string }> };
    expect(details.title).toBe('Saga');
    expect(details.issues.map((i) => i.issueNumber).sort()).toEqual(['1', '2']);
    expect((await h.call('POST', '/books/comics', { foreignId: 'cv:999', rootFolderPath: h.dirs.comics, formatProfileId: await profileId(h, 'comic') })).status).toBe(404);
    // A comic root folder is not an ebook root folder.
    expect((await h.call('POST', '/books/authors', { foreignId: AUTHOR_KEY, rootFolderPath: h.dirs.comics, formatProfileId: await profileId(h, 'ebook') })).status).toBe(400);
  });

  it('lookups mark books already in the library', async () => {
    const h = await harness();
    await addHerbert(h);
    const res = (await h.call('GET', '/books/lookup/ebooks?term=dune')).body as { results: Array<{ title: string; libraryId: number | null }> };
    expect(res.results.length).toBe(2);
    expect(res.results.every((r) => r.libraryId !== null)).toBe(true);
  });
});

describe('search, grab and import', () => {
  it('grabs the best release, imports the completed download and deletes the file', async () => {
    const releases = [releaseOf('Frank Herbert - Dune (1965) [pdf]'), releaseOf('Frank Herbert - Dune (1965) [epub]'), releaseOf('Frank Herbert - Dune Messiah (1969) [epub]')];
    const h = await harness({ releases });
    await addHerbert(h);
    const dune = h.db.select().from(ebooks).where(eq(ebooks.title, 'Dune')).get()!;

    const found = (await h.call('GET', `/books/releases?kind=ebook&id=${dune.id}`)).body as Array<{ title: string; approved: boolean; format: string }>;
    expect(found[0]).toMatchObject({ title: 'Frank Herbert - Dune (1965) [epub]', approved: true, format: 'epub' });
    expect(found.find((r) => r.title.includes('Messiah'))?.approved).toBe(false);

    // A rejected release needs force.
    const messiah = found.find((r) => r.title.includes('Messiah'))!;
    expect((await h.call('POST', '/books/releases/grab', { kind: 'ebook', id: dune.id, indexerId: 1, guid: messiah.title })).status).toBe(409);
    const grab = await h.call('POST', '/books/releases/grab', { kind: 'ebook', id: dune.id, indexerId: 1, guid: found[0]!.title });
    expect(grab.status).toBe(200);
    expect(h.grabs.map((g) => g.title)).toEqual(['Frank Herbert - Dune (1965) [epub]']);
    const row = h.db.select().from(bookGrabs).where(eq(bookGrabs.downloadId, grab.body.downloadId)).get()!;
    expect(row).toMatchObject({ kind: 'ebook', ebookId: dune.id, status: 'grabbed', format: 'epub' });

    // The download completes: the epub is imported into the author's folder.
    const folder = join(h.dirs.downloads, 'Frank Herbert - Dune (1965) [epub]');
    mkdirSync(folder);
    writeFileSync(join(folder, 'Dune.epub'), 'epub bytes');
    writeFileSync(join(folder, 'cover.jpg'), 'jpg');
    const item = { id: 7, downloadId: grab.body.downloadId, title: 'Frank Herbert - Dune (1965) [epub]', canMoveFiles: false, grabbedRelease: null } as unknown as TrackedDownload;
    const services = booksServicesFor(h.ctx);
    expect(await services.imports.handleCompleted(item, folder)).toBe(true);
    expect(h.imported).toEqual([7]);
    const file = h.db.select().from(bookFiles).where(eq(bookFiles.ebookId, dune.id)).get()!;
    expect(file.path.startsWith(h.dirs.ebooks)).toBe(true);
    expect(file.path.endsWith('.epub')).toBe(true);
    expect(existsSync(file.path)).toBe(true);
    expect(existsSync(join(folder, 'Dune.epub'))).toBe(true); // copied: the client still seeds it
    expect(h.db.select().from(ebooks).where(eq(ebooks.id, dune.id)).get()!.hasFile).toBe(true);
    expect(h.db.select().from(bookGrabs).where(eq(bookGrabs.id, row.id)).get()!.status).toBe('imported');

    // Not a books download: left to the other importers.
    expect(await services.imports.handleCompleted({ ...item, downloadId: 'other' } as TrackedDownload, folder)).toBe(false);

    // Delete the file: gone from disk and the book is missing again.
    expect((await h.call('DELETE', `/books/files/${file.id}`)).status).toBe(204);
    expect(existsSync(file.path)).toBe(false);
    expect(h.db.select().from(ebooks).where(eq(ebooks.id, dune.id)).get()!.hasFile).toBe(false);
  });

  it('blocks a completed download without a usable file (importPending)', async () => {
    const states: string[] = [];
    const h = await harness({
      releases: [releaseOf('Frank Herbert - Dune (1965) [epub]')],
      overrides: { importDownloads: { setState: (_id, state) => void states.push(state), markImported: async () => undefined, setImportProgress: () => undefined } },
    });
    await addHerbert(h);
    const dune = h.db.select().from(ebooks).where(eq(ebooks.title, 'Dune')).get()!;
    await h.call('GET', `/books/releases?kind=ebook&id=${dune.id}`);
    const grab = await h.call('POST', '/books/releases/grab', { kind: 'ebook', id: dune.id, indexerId: 1, guid: 'Frank Herbert - Dune (1965) [epub]' });
    const folder = join(h.dirs.downloads, 'empty');
    mkdirSync(folder);
    writeFileSync(join(folder, 'readme.txt'), 'x');
    const item = { id: 3, downloadId: grab.body.downloadId, title: 'Dune', canMoveFiles: false, grabbedRelease: null } as unknown as TrackedDownload;
    expect(await booksServicesFor(h.ctx).imports.handleCompleted(item, folder)).toBe(true);
    expect(states.at(-1)).toBe('importPending');
  });

  it('RescanBooks picks up a file already in the author folder', async () => {
    const h = await harness();
    const author = await addHerbert(h);
    const details = (await h.call('GET', `/books/authors/${author.id}`)).body as { path: string };
    mkdirSync(join(details.path, 'Dune'), { recursive: true });
    writeFileSync(join(details.path, 'Dune', 'Dune - Frank Herbert.epub'), 'epub');
    const message = await booksServicesFor(h.ctx).imports.rescan();
    expect(message).toMatch(/1/);
    expect(h.db.select().from(ebooks).where(eq(ebooks.title, 'Dune')).get()!.hasFile).toBe(true);
  });

  it('POST /books/command queues the work (202)', async () => {
    const h = await harness();
    const res = await h.call('POST', '/books/command', { name: 'RescanBooks' });
    expect(res.status).toBe(202);
    expect(res.body.name).toBe('RescanBooks');
    expect((await h.call('POST', '/books/command', { name: 'EbookSearch', ebookIds: [] })).status).toBe(400);
  });
});

describe('requests', () => {
  async function user(h: Harness, permissions: number): Promise<Record<string, string>> {
    const auth = authServiceFor(h.ctx);
    const u = await auth.createUser({ username: `reader${permissions}`, password: 'password1', role: 'user', permissions });
    return { cookie: `${SESSION_COOKIE}=${auth.createSession(u.id).token}` };
  }

  it('a portal user requests a book; an admin approves and it is added to the library', async () => {
    const h = await harness();
    const reader = await user(h, Permission.REQUEST);
    const lookup = await h.call('GET', '/books/requests/lookup/ebooks?term=dune', undefined, reader);
    expect(lookup.status).toBe(200);
    const created = await h.call('POST', '/books/requests', { kind: 'ebook', foreignId: DUNE.key, title: 'Dune', year: 1965 }, reader);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');
    // The same book again conflicts.
    expect((await h.call('POST', '/books/requests', { kind: 'ebook', foreignId: DUNE.key, title: 'Dune' }, reader)).status).toBe(409);
    // A reader cannot approve.
    expect((await h.call('POST', `/books/requests/${created.body.id}/approve`, {}, reader)).status).toBe(403);
    // The library routes stay admin-only.
    expect((await h.call('GET', '/books/settings', undefined, reader)).status).toBe(403);

    const approved = await h.call('POST', `/books/requests/${created.body.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.libraryId).toBeGreaterThan(0);
    expect(h.db.select().from(ebooks).where(eq(ebooks.id, approved.body.libraryId)).get()?.title).toBe('Dune');

    const mine = (await h.call('GET', '/books/requests', undefined, reader)).body as { records: Array<{ id: number }> };
    expect(mine.records.map((r) => r.id)).toEqual([created.body.id]);
  });

  it('declines with a reason; users without REQUEST are refused', async () => {
    const h = await harness();
    const reader = await user(h, Permission.REQUEST);
    const created = await h.call('POST', '/books/requests', { kind: 'comic', foreignId: SAGA.key, title: 'Saga' }, reader);
    const declined = await h.call('POST', `/books/requests/${created.body.id}/decline`, { reason: 'not now' });
    expect(declined.body).toMatchObject({ status: 'declined', declineReason: 'not now' });
    const nobody = await user(h, 0);
    expect((await h.call('POST', '/books/requests', { kind: 'comic', foreignId: 'cv:1', title: 'X' }, nobody)).status).toBe(403);
  });
});

describe('catalogue cache', () => {
  function instantClock() {
    let t = Date.parse('2026-10-01T00:00:00Z');
    return { now: () => t, sleep: async (ms: number) => void (t += Math.max(0, ms)) };
  }

  it('serves an expired entry as stale when ComicVine fails, and a fresh one as cached without a call', async () => {
    let calls = 0;
    const h = await harness({
      overrides: {
        catalog: {
          fetchImpl: async () => {
            calls += 1;
            return new Response('down', { status: 500 });
          },
          rateLimiter: new RateLimiter({ clock: instantClock(), random: () => 0 }),
        },
      },
    });
    setSection(h.db, 'books', { ...getSection(h.db, 'books'), metadata: { ...getSection(h.db, 'books').metadata, openLibrary: false, googleBooks: false, hardcover: false, comicVine: true, comicVineApiKey: 'cv-key', metron: false } });
    const now = Date.now();
    h.db
      .insert(metadataCache)
      .values({ provider: 'books-comicvine', key: 'comic-search:saga', body: [SAGA], etag: null, fetchedAt: new Date(now - 2 * 86_400_000).toISOString(), expiresAt: new Date(now - 86_400_000).toISOString() })
      .run();
    const stale = (await h.call('GET', '/books/lookup/comics?term=saga')).body as { results: Array<{ title: string }>; sources: Array<{ source: string; state: string }> };
    expect(stale.results.map((r) => r.title)).toEqual(['Saga']);
    expect(stale.sources.find((s) => s.source === 'comicVine')?.state).toBe('stale');
    expect(calls).toBeGreaterThan(0);

    h.db.update(metadataCache).set({ expiresAt: new Date(now + 86_400_000).toISOString() }).where(eq(metadataCache.key, 'comic-search:saga')).run();
    const before = calls;
    const cached = (await h.call('GET', '/books/lookup/comics?term=saga')).body as { sources: Array<{ source: string; state: string }> };
    expect(cached.sources.find((s) => s.source === 'comicVine')?.state).toBe('cached');
    expect(calls).toBe(before);
  });
});
