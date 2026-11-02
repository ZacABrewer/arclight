import { describe, expect, it } from 'vitest';
import { MetadataError, isMetadataError } from '../types.js';
import { RateLimiter } from '../rate-limit.js';
import { jsonResponse } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import { BOOK_CACHE_PROVIDERS, createBookCatalog } from './catalog.js';
import {
  BOOK_TEST_USER_AGENT,
  bookConfig,
  bookRecord,
  createHostFetch,
  createMemoryBookCache,
  type HostRoute,
} from './test-support.js';
import type { BookCatalogConfig, BookRecord, BookSourceStatus } from './types.js';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const ISBN = '9780765311788';
const UNKNOWN_ISBN = '9780765350381';

// ---------------------------------------------------------------------------
// Fixtures (small inline payloads)

const OL_WORK = {
  key: '/works/OL1W',
  title: 'The Final Empire',
  description: 'OpenLibrary text.',
  authors: [{ author: { key: '/authors/OL1A' } }],
  subjects: ['Fantasy'],
  covers: [101],
  first_publish_date: '2006',
};
const OL_WORK_2 = { key: '/works/OL2W', title: 'Elantris', covers: [102] };
const OL_EDITION = {
  key: '/books/OL1M',
  title: 'The Final Empire',
  works: [{ key: '/works/OL1W' }],
  isbn_13: [ISBN],
  languages: [{ key: '/languages/eng' }],
  publish_date: 'July 17, 2006',
  publishers: ['Tor'],
  number_of_pages: 541,
};
const OL_SEARCH = {
  numFound: 1,
  docs: [
    {
      key: '/works/OL1W',
      title: 'The Final Empire',
      author_name: ['Brandon Sanderson'],
      author_key: ['OL1A'],
      isbn: [ISBN],
      language: ['eng'],
      first_publish_year: 2006,
    },
  ],
};

const GB_VOLUME = {
  id: 'vol123',
  volumeInfo: {
    title: 'The Final Empire',
    authors: ['Brandon Sanderson'],
    publisher: 'Tor Books',
    publishedDate: '2006-07-17',
    description: 'Google text.',
    industryIdentifiers: [{ type: 'ISBN_13', identifier: ISBN }],
    language: 'en',
    imageLinks: { thumbnail: 'http://books.google.com/vol123.jpg' },
  },
};
const GB_SPANISH = {
  id: 'vol-es',
  volumeInfo: { title: 'El imperio final', authors: ['Brandon Sanderson'], language: 'es' },
};
const GB_OTHER_AUTHOR = {
  id: 'vol-other',
  volumeInfo: { title: 'On Reading Fantasy', authors: ['Some Critic'], language: 'en' },
};

const HC_BOOK = {
  id: 386446,
  title: 'The Final Empire',
  description: 'Hardcover text, the longest description of them all.',
  release_date: '2006-07-17',
  rating: 4.4,
  contributions: [{ contribution: null, author: { id: 204214, name: 'Brandon Sanderson' } }],
  book_series: [{ position: 1, series: { name: 'Mistborn' } }],
  editions: [{ isbn_13: ISBN }],
  image: { url: 'https://assets.hardcover.app/386446.jpg' },
};

const CV_VOLUME = {
  id: 91273,
  name: 'Batman',
  start_year: '2016',
  publisher: { name: 'DC Comics' },
  count_of_issues: 2,
  image: { original_url: 'https://comicvine.example.com/batman.jpg' },
  issues: [{ id: 501, issue_number: '1' }],
};
const METRON_SERIES = {
  id: 2049,
  name: 'Batman',
  year_began: 2016,
  issue_count: 3,
  status: 'Completed',
  cv_id: 91273,
};

// ---------------------------------------------------------------------------
// Routes per host

function openLibraryRoute(url: URL): Response {
  switch (url.pathname) {
    case `/isbn/${ISBN}.json`:
      return jsonResponse(OL_EDITION);
    case '/works/OL1W.json':
      return jsonResponse(OL_WORK);
    case '/works/OL2W.json':
      return jsonResponse(OL_WORK_2);
    case '/search.json':
      return jsonResponse(OL_SEARCH);
    case '/authors/OL1A.json':
      return jsonResponse({ key: '/authors/OL1A', name: 'Brandon Sanderson', bio: 'Short.' });
    case '/authors/OL1A/works.json':
      return jsonResponse({ size: 2, entries: [OL_WORK, OL_WORK_2] });
    case '/search/authors.json':
      return jsonResponse({ numFound: 1, docs: [{ key: '/authors/OL1A', name: 'Brandon Sanderson', work_count: 90 }] });
    default:
      return jsonResponse({ error: 'notfound' }, 404);
  }
}

function googleRoute(url: URL): Response {
  if (url.pathname === '/books/v1/volumes/vol123') return jsonResponse(GB_VOLUME);
  if (url.pathname !== '/books/v1/volumes') return jsonResponse({ error: { code: 404 } }, 404);
  const q = url.searchParams.get('q') ?? '';
  if (q.startsWith('inauthor:')) {
    return jsonResponse({ totalItems: 3, items: [GB_VOLUME, GB_SPANISH, GB_OTHER_AUTHOR] });
  }
  if (q === `isbn:${UNKNOWN_ISBN}`) return jsonResponse({ totalItems: 0 });
  return jsonResponse({ totalItems: 1, items: [GB_VOLUME] });
}

const hardcoverRoute: HostRoute = (_url, init) => {
  const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
  if (query.includes('editions(where')) {
    return jsonResponse({ data: { editions: variables.isbn === ISBN ? [{ isbn_13: ISBN, book: HC_BOOK }] : [] } });
  }
  if (query.includes('search(')) {
    const hits =
      variables.type === 'Author'
        ? [{ document: { id: '204214', name: 'Brandon Sanderson', books_count: 300 } }]
        : [{ document: { id: '386446', title: 'The Final Empire', author_names: ['Brandon Sanderson'], isbns: [ISBN] } }];
    return jsonResponse({ data: { search: { results: { hits } } } });
  }
  if (query.includes('authors(where')) {
    return jsonResponse({
      data: { authors: [{ id: 204214, name: 'Brandon Sanderson', bio: 'Hardcover bio.', contributions: [{ contribution: null, book: HC_BOOK }] }] },
    });
  }
  return jsonResponse({ data: { books: [HC_BOOK] } });
};

function cvOk(results: unknown, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ status_code: 1, error: 'OK', results, ...extra });
}

function comicVineRoute(url: URL): Response {
  if (url.pathname === '/api/volume/4050-91273/') return cvOk(CV_VOLUME);
  if (url.pathname === '/api/issues/') {
    return cvOk(
      [
        { id: 501, issue_number: '1', name: 'I Am Gotham', store_date: '2016-06-16', image: { original_url: 'https://comicvine.example.com/1.jpg' } },
        { id: 502, issue_number: '2', image: { original_url: 'https://comicvine.example.com/2.jpg' } },
      ],
      { number_of_total_results: 2 },
    );
  }
  if (url.pathname === '/api/search/') return cvOk([CV_VOLUME]);
  return jsonResponse({ status_code: 101, error: 'Object Not Found' }, 404);
}

function metronRoute(url: URL): Response {
  if (url.pathname === '/api/series/') {
    return jsonResponse({ count: 1, next: null, results: [{ id: 2049, series: 'Batman (2016)', year_began: 2016 }] });
  }
  if (url.pathname === '/api/series/2049/') return jsonResponse(METRON_SERIES);
  if (url.pathname === '/api/issue/') {
    return jsonResponse({
      count: 3,
      next: null,
      results: [
        { id: 1, number: '1', store_date: '2016-06-15', image: 'https://static.example.com/m1.jpg', cv_id: 501 },
        { id: 2, number: '2', store_date: '2016-07-06' },
        { id: 3, number: '3', store_date: '2016-07-20', image: 'https://static.example.com/m3.jpg' },
      ],
    });
  }
  return jsonResponse({ detail: 'Not found.' }, 404);
}

const DOWN: HostRoute = () => jsonResponse({ error: 'down' }, 500);
const UNREACHABLE: HostRoute = () => {
  throw new TypeError('fetch failed');
};

const HOSTS = {
  openLibrary: 'openlibrary.org',
  googleBooks: 'www.googleapis.com',
  hardcover: 'api.hardcover.app',
  comicVine: 'comicvine.gamespot.com',
  metron: 'metron.cloud',
} as const;

function makeCatalog(
  opts: { routes?: Partial<Record<keyof typeof HOSTS, HostRoute>>; config?: Partial<BookCatalogConfig> } = {},
) {
  const routes: Record<string, HostRoute> = {
    [HOSTS.openLibrary]: opts.routes?.openLibrary ?? openLibraryRoute,
    [HOSTS.googleBooks]: opts.routes?.googleBooks ?? googleRoute,
    [HOSTS.hardcover]: opts.routes?.hardcover ?? hardcoverRoute,
    [HOSTS.comicVine]: opts.routes?.comicVine ?? comicVineRoute,
    [HOSTS.metron]: opts.routes?.metron ?? metronRoute,
  };
  const fake = createHostFetch(routes);
  const cache = createMemoryBookCache(() => NOW);
  const catalog = createBookCatalog({
    config: bookConfig(opts.config),
    cache,
    fetchImpl: fake.fetch,
    rateLimiter: new RateLimiter({ clock: createInstantClock(0), random: () => 0 }),
    userAgent: BOOK_TEST_USER_AGENT,
    now: () => new Date(NOW),
  });
  return { catalog, fake, cache };
}

function states(sources: BookSourceStatus[]): Record<string, string> {
  return Object.fromEntries(sources.map((s) => [s.source, s.state]));
}

function cachedBook(source: BookRecord['sources'][number], extra: Partial<BookRecord> = {}): BookRecord {
  return bookRecord({
    key: `isbn:${ISBN}`,
    keys: [`isbn:${ISBN}`],
    title: 'The Final Empire',
    authors: [{ name: 'Brandon Sanderson' }],
    isbn13: ISBN,
    isbns: [ISBN],
    sources: [source],
    ...extra,
  });
}

// ---------------------------------------------------------------------------

describe('BookCatalog.getBook', () => {
  it('asks every source by ISBN and merges the answers', async () => {
    const { catalog, fake } = makeCatalog();
    const { value, sources } = await catalog.getBook(`isbn:${ISBN}`);
    expect(states(sources)).toEqual({ openLibrary: 'ok', googleBooks: 'ok', hardcover: 'ok' });
    expect(value).toMatchObject({
      key: `isbn:${ISBN}`,
      title: 'The Final Empire',
      authors: [{ name: 'Brandon Sanderson', key: 'ol:OL1A' }],
      olWorkId: 'OL1W',
      googleVolumeId: 'vol123',
      hardcoverId: '386446',
      overview: 'Hardcover text, the longest description of them all.',
      coverUrl: 'https://assets.hardcover.app/386446.jpg',
      series: [{ name: 'Mistborn', position: '1' }],
      releaseDate: '2006-07-17',
      language: 'en',
    });
    expect(value.sources.sort()).toEqual(['googleBooks', 'hardcover', 'openLibrary']);
    const hcCall = fake.calls.find((c) => c.url.host === HOSTS.hardcover)!;
    expect((hcCall.init?.headers as Record<string, string>).authorization).toBe('Bearer test-token');
  });

  it('(a) serves an expired cache entry when a source throws', async () => {
    const { catalog, cache } = makeCatalog({ routes: { hardcover: DOWN } });
    cache.put(BOOK_CACHE_PROVIDERS.hardcover, `book:isbn:${ISBN}`, cachedBook('hardcover', { hardcoverId: '42', rating: 3.9 }), -1000);
    const { value, sources } = await catalog.getBook(`isbn:${ISBN}`);
    expect(states(sources)).toEqual({ openLibrary: 'ok', googleBooks: 'ok', hardcover: 'stale' });
    expect(sources.find((s) => s.source === 'hardcover')?.message).toMatch(/HTTP 500/);
    expect(value).toMatchObject({ hardcoverId: '42', rating: 3.9 });
  });

  it('(b) merges what the healthy sources return when one is down', async () => {
    const { catalog } = makeCatalog({ routes: { googleBooks: UNREACHABLE } });
    const { value, sources } = await catalog.getBook(`isbn:${ISBN}`);
    expect(states(sources)).toEqual({ openLibrary: 'ok', googleBooks: 'failed', hardcover: 'ok' });
    expect(sources.find((s) => s.source === 'googleBooks')?.message).toMatch(/unreachable/);
    expect(value.sources.sort()).toEqual(['hardcover', 'openLibrary']);
    expect(value.series).toEqual([{ name: 'Mistborn', position: '1' }]);
  });

  it('(c) throws naming the sources when all are down and nothing is cached', async () => {
    const { catalog } = makeCatalog({ routes: { openLibrary: DOWN, googleBooks: UNREACHABLE, hardcover: DOWN } });
    const err = await catalog.getBook(`isbn:${ISBN}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetadataError);
    expect(isMetadataError(err, 'unreachable')).toBe(true);
    expect((err as Error).message).toMatch(/OpenLibrary.*Google Books.*Hardcover/);
  });

  it('(d) answers from fresh cache without calling fetch', async () => {
    const { catalog, cache, fake } = makeCatalog();
    for (const source of ['openLibrary', 'googleBooks', 'hardcover'] as const) {
      cache.put(BOOK_CACHE_PROVIDERS[source], `book:isbn:${ISBN}`, cachedBook(source), 60_000);
    }
    const { value, sources } = await catalog.getBook(`isbn:${ISBN}`);
    expect(fake.calls).toHaveLength(0);
    expect(states(sources)).toEqual({ openLibrary: 'cached', googleBooks: 'cached', hardcover: 'cached' });
    expect(value.sources).toHaveLength(3);
  });

  it('(e) never calls disabled sources', async () => {
    const { catalog, fake } = makeCatalog({ config: { googleBooks: false, hardcoverApiKey: '' } });
    const { sources } = await catalog.getBook(`isbn:${ISBN}`);
    expect(new Set(fake.hosts())).toEqual(new Set([HOSTS.openLibrary]));
    expect(states(sources)).toEqual({ openLibrary: 'ok', googleBooks: 'disabled', hardcover: 'disabled' });
    expect(sources.find((s) => s.source === 'hardcover')?.message).toMatch(/no API token/);
  });

  it('(f) fresh: true bypasses a fresh cache entry and rewrites it', async () => {
    const { catalog, cache, fake } = makeCatalog();
    cache.put(BOOK_CACHE_PROVIDERS.googleBooks, `book:isbn:${ISBN}`, cachedBook('googleBooks', { publisher: 'Old' }), 60_000);
    const { value, sources } = await catalog.getBook(`isbn:${ISBN}`, { fresh: true });
    expect(fake.hosts()).toContain(HOSTS.googleBooks);
    expect(states(sources).googleBooks).toBe('ok');
    expect(value.publisher).toBe('Tor Books');
    const rewritten = cache.get<BookRecord>(BOOK_CACHE_PROVIDERS.googleBooks, `book:isbn:${ISBN}`);
    expect(rewritten?.body.publisher).toBe('Tor Books');
  });

  it('fresh: true still falls back to stale cache on error', async () => {
    const { catalog, cache } = makeCatalog({ routes: { googleBooks: DOWN } });
    cache.put(BOOK_CACHE_PROVIDERS.googleBooks, `book:isbn:${ISBN}`, cachedBook('googleBooks', { publisher: 'Cached' }), 60_000);
    const { value, sources } = await catalog.getBook(`isbn:${ISBN}`, { fresh: true });
    expect(states(sources).googleBooks).toBe('stale');
    expect(value.publisher).toBe('Cached');
  });

  it('throws not-found when every source answered and none knows the ISBN', async () => {
    const { catalog } = makeCatalog();
    await expect(catalog.getBook(`isbn:${UNKNOWN_ISBN}`)).rejects.toSatisfy((e) => isMetadataError(e, 'not-found'));
  });

  it('looks a gb: key up at Google first, then enriches by ISBN', async () => {
    const { catalog, fake } = makeCatalog();
    const { value, sources } = await catalog.getBook('gb:vol123');
    expect(fake.calls[0]!.url.pathname).toBe('/books/v1/volumes/vol123');
    expect(states(sources)).toEqual({ openLibrary: 'ok', googleBooks: 'ok', hardcover: 'ok' });
    expect(value.keys).toEqual(expect.arrayContaining(['gb:vol123', 'ol:OL1W', 'hc:386446']));
  });

  it('enriches an ol: work by title and author', async () => {
    const { catalog } = makeCatalog();
    const { value } = await catalog.getBook('ol:OL1W');
    expect(value.olWorkId).toBe('OL1W');
    expect(value.sources.sort()).toEqual(['googleBooks', 'hardcover', 'openLibrary']);
    expect(value.authors[0]).toEqual({ name: 'Brandon Sanderson', key: 'ol:OL1A' });
  });

  it('rejects keys for a disabled source', async () => {
    const { catalog, fake } = makeCatalog({ config: { hardcover: false } });
    await expect(catalog.getBook('hc:386446')).rejects.toSatisfy((e) => isMetadataError(e, 'not-found'));
    expect(fake.calls).toHaveLength(0);
  });
});

describe('BookCatalog searches', () => {
  it('searches every book source, merges, applies the language filter', async () => {
    const { catalog } = makeCatalog({ config: { languages: ['en'] }, routes: { openLibrary: DOWN } });
    const { value, sources } = await catalog.searchBooks('final empire');
    expect(states(sources)).toEqual({ openLibrary: 'failed', googleBooks: 'ok', hardcover: 'ok' });
    expect(value).toHaveLength(1);
    expect(value[0]!.sources.sort()).toEqual(['googleBooks', 'hardcover']);
  });

  it('caches searches per source', async () => {
    const { catalog, fake } = makeCatalog();
    await catalog.searchBooks('Final  Empire');
    const calls = fake.calls.length;
    const again = await catalog.searchBooks('final empire');
    expect(fake.calls).toHaveLength(calls);
    expect(states(again.sources)).toEqual({ openLibrary: 'cached', googleBooks: 'cached', hardcover: 'cached' });
  });

  it('searches authors on OpenLibrary and Hardcover', async () => {
    const { catalog } = makeCatalog();
    const { value, sources } = await catalog.searchAuthors('sanderson');
    expect(states(sources)).toEqual({ openLibrary: 'ok', hardcover: 'ok' });
    expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({ key: 'ol:OL1A', keys: ['ol:OL1A', 'hc:204214'], workCount: 300 });
  });

  it('throws when every book source fails a search', async () => {
    const { catalog } = makeCatalog({ routes: { openLibrary: DOWN, googleBooks: DOWN, hardcover: DOWN } });
    await expect(catalog.searchBooks('x')).rejects.toSatisfy((e) => isMetadataError(e, 'unreachable'));
  });
});

describe('BookCatalog.getAuthorWithBooks', () => {
  it('merges the author and keeps their own books in the wanted languages', async () => {
    const { catalog } = makeCatalog({ config: { languages: ['english'] } });
    const { value, sources } = await catalog.getAuthorWithBooks('ol:OL1A');
    expect(states(sources)).toEqual({ openLibrary: 'ok', googleBooks: 'ok', hardcover: 'ok' });
    expect(value.author).toMatchObject({
      key: 'ol:OL1A',
      keys: ['ol:OL1A', 'hc:204214', 'gb-author:Brandon Sanderson'],
      name: 'Brandon Sanderson',
      overview: 'Hardcover bio.',
    });
    expect(value.books.map((b) => b.title).sort()).toEqual(['Elantris', 'The Final Empire']);
    const finalEmpire = value.books.find((b) => b.title === 'The Final Empire')!;
    expect(finalEmpire.sources.sort()).toEqual(['googleBooks', 'hardcover', 'openLibrary']);
    expect(finalEmpire.series).toEqual([{ name: 'Mistborn', position: '1' }]);
  });

  it('fills dates and ISBNs of the works list from the work search (OpenLibrary alone)', async () => {
    const { catalog, fake } = makeCatalog({ config: { googleBooks: false, hardcover: false } });
    const { value } = await catalog.getAuthorWithBooks('ol:OL1A');
    const finalEmpire = value.books.find((b) => b.title === 'The Final Empire')!;
    expect(finalEmpire.releaseDate?.slice(0, 4)).toBe('2006');
    expect(finalEmpire.isbns).toContain(ISBN);
    const search = fake.calls.find((c) => c.url.pathname === '/search.json')!;
    expect(search.url.searchParams.get('q')).toBe('author_key:OL1A');
  });

  it('still answers from the other sources by name when OpenLibrary is down', async () => {
    const { catalog } = makeCatalog({ routes: { openLibrary: DOWN } });
    const { value, sources } = await catalog.getAuthorWithBooks('ol:OL1A', { name: 'Brandon Sanderson' });
    expect(states(sources).openLibrary).toBe('failed');
    expect(value.author.keys).toContain('hc:204214');
    expect(value.books.length).toBeGreaterThan(0);
  });

  it('throws not-found for an author OpenLibrary does not know', async () => {
    const { catalog } = makeCatalog();
    await expect(catalog.getAuthorWithBooks('ol:OL999A')).rejects.toSatisfy((e) => isMetadataError(e, 'not-found'));
  });
});

describe('BookCatalog comics', () => {
  it('merges a ComicVine volume with its linked Metron series and issues', async () => {
    const { catalog, fake } = makeCatalog();
    const { value, sources } = await catalog.getComicSeries('cv:91273');
    expect(states(sources)).toEqual({ comicVine: 'ok', metron: 'ok' });
    expect(value.series).toMatchObject({
      key: 'cv:91273',
      keys: ['cv:91273', 'metron:2049'],
      status: 'ended',
      issueCount: 3,
      sources: ['comicVine', 'metron'],
    });
    expect(value.issues.map((i) => [i.issueNumber, i.storeDate, i.coverUrl])).toEqual([
      ['1', '2016-06-15', 'https://comicvine.example.com/1.jpg'],
      ['2', '2016-07-06', 'https://comicvine.example.com/2.jpg'],
      ['3', '2016-07-20', 'https://static.example.com/m3.jpg'],
    ]);
    const metronCall = fake.calls.find((c) => c.url.host === HOSTS.metron)!;
    expect((metronCall.init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    const cvCall = fake.calls.find((c) => c.url.host === HOSTS.comicVine)!;
    expect(cvCall.url.searchParams.get('api_key')).toBe('test-cv-key');
  });

  it('follows a metron: key to ComicVine through cv_id', async () => {
    const { catalog } = makeCatalog();
    const { value } = await catalog.getComicSeries('metron:2049');
    expect(value.series.keys).toEqual(['cv:91273', 'metron:2049']);
    expect(value.issues).toHaveLength(3);
  });

  it('answers from Metron when ComicVine is down', async () => {
    const { catalog } = makeCatalog({ routes: { comicVine: DOWN } });
    const { value, sources } = await catalog.getComicSeries('cv:91273');
    expect(states(sources)).toEqual({ comicVine: 'failed', metron: 'ok' });
    expect(value.series.metronId).toBe('2049');
    expect(value.issues.map((i) => i.key)).toEqual(['metron-issue:1', 'metron-issue:2', 'metron-issue:3']);
  });

  it('works with ComicVine alone when Metron has no credentials', async () => {
    const { catalog, fake } = makeCatalog({ config: { metronPassword: '' } });
    const { value, sources } = await catalog.getComicSeries('cv:91273');
    expect(states(sources)).toEqual({ comicVine: 'ok', metron: 'disabled' });
    expect(fake.hosts()).not.toContain(HOSTS.metron);
    expect(value.issues).toHaveLength(2);
  });

  it('searches both comic sources', async () => {
    const { catalog } = makeCatalog();
    const { value, sources } = await catalog.searchComicSeries('batman');
    expect(states(sources)).toEqual({ comicVine: 'ok', metron: 'ok' });
    expect(value).toHaveLength(1);
    expect(value[0]!.sources).toEqual(['comicVine', 'metron']);
  });
});
