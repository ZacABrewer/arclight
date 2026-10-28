import { describe, expect, it } from 'vitest';
import { isMetadataError } from '../types.js';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse, type Responder } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import {
  AUDIOBOOK_IDS,
  TEST_USER_AGENT,
  audiobookRoute,
  audnexusFixtures,
} from '../audiobook-test-support.js';
import {
  createDefaultAudiobookCatalog,
  type DefaultAudiobookCatalogOptions,
} from './catalog.js';
import { dedupeBooks, groupSeries, titleAuthorKey } from './map.js';
import type { CatalogBook } from './types.js';

function makeCatalog(
  route: Responder = audiobookRoute,
  extra: Partial<DefaultAudiobookCatalogOptions> = {},
) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const catalog = createDefaultAudiobookCatalog({
    userAgent: TEST_USER_AGENT,
    fetchImpl: fake.fetch,
    rateLimiter: new RateLimiter({ clock, random: () => 0 }),
    now: () => new Date(clock.now()),
    maxRetries: 0,
    ...extra,
  });
  const hosts = () => fake.calls.map((c) => c.url.host);
  return { catalog, fake, hosts };
}

function book(partial: Partial<CatalogBook> & { title: string }): CatalogBook {
  return {
    isbns: [],
    authors: [{ name: 'Andy Weir' }],
    narrators: [],
    series: [],
    genres: [],
    images: {},
    sources: ['audible'],
    ...partial,
  };
}

/** Routes one host differently and leaves the rest to the fixtures. */
function overrideHost(host: string, responder: Responder): Responder {
  return (url, init) => (url.hostname === host ? responder(url, init) : audiobookRoute(url));
}

describe('createDefaultAudiobookCatalog', () => {
  it('requires a User-Agent and sends it to every source', async () => {
    expect(() => createDefaultAudiobookCatalog({ userAgent: '' })).toThrow(/User-Agent/);
    const { catalog, fake } = makeCatalog(audiobookRoute, { languages: ['english'] });
    await catalog.getAuthorWithBooks({ name: 'Andy Weir' });
    await catalog.searchBooks({ title: 'Casey and Andy' });
    const hosts = new Set(fake.calls.map((c) => c.url.host));
    expect(hosts).toEqual(new Set(['api.audnex.us', 'api.audible.com', 'openlibrary.org']));
    for (const call of fake.calls) {
      expect((call.init?.headers as Record<string, string>)['User-Agent']).toBe(TEST_USER_AGENT);
    }
  });

  it('uses the configured region and Audnexus base URL', async () => {
    const { catalog, fake } = makeCatalog(
      (url) =>
        url.host === 'audnexus.local'
          ? audiobookRoute(new URL(url.pathname + url.search, 'https://api.audnex.us'))
          : audiobookRoute(url),
      { region: 'uk', audnexusBaseUrl: 'http://audnexus.local' },
    );
    await catalog.getBook(AUDIOBOOK_IDS.bookAsin, { openLibraryFallback: false });
    await catalog.searchBooks('Project Hail Mary', { region: 'de' });
    expect(fake.calls[0]?.url.toString()).toBe(
      `http://audnexus.local/books/${AUDIOBOOK_IDS.bookAsin}?region=uk`,
    );
    expect(fake.calls[1]?.url.host).toBe('api.audible.de');
  });
});

describe('AudiobookCatalog.searchBooks', () => {
  it('returns Audible results as catalog books', async () => {
    const { catalog, hosts } = makeCatalog();
    const books = await catalog.searchBooks({ title: 'Project Hail Mary', author: 'Andy Weir' });
    expect(hosts()).toEqual(['api.audible.com']);
    expect(books.map((b) => b.asin)).toEqual([AUDIOBOOK_IDS.bookAsin, 'B0CTZVXP8H']);
    expect(books[0]).toMatchObject({
      title: 'Project Hail Mary',
      authors: [{ name: 'Andy Weir', asin: AUDIOBOOK_IDS.authorAsin }],
      narrators: ['Ray Porter'],
      runtimeMinutes: 970,
      formatType: 'unabridged',
      language: 'english',
      releaseDate: '2021-05-04',
      publisher: 'Audible Studios',
      region: 'us',
      sources: ['audible'],
    });
    expect(books[0]?.images.cover).toMatch(/^https:\/\/m\.media-amazon\.com\//);
  });

  it('applies the language filter', async () => {
    const { catalog } = makeCatalog(audiobookRoute, { languages: ['en'] });
    const books = await catalog.searchBooks('Project Hail Mary');
    expect(books.map((b) => b.asin)).toEqual([AUDIOBOOK_IDS.bookAsin]);
    const italian = await catalog.searchBooks('Project Hail Mary', { languages: ['ita'] });
    expect(italian.map((b) => b.asin)).toEqual(['B0CTZVXP8H']);
  });

  it('falls back to OpenLibrary when Audible has no match', async () => {
    const { catalog, hosts } = makeCatalog();
    const books = await catalog.searchBooks({ title: 'Casey and Andy', author: 'Andy Weir' });
    expect(hosts()).toEqual(['api.audible.com', 'openlibrary.org']);
    expect(books[0]).toMatchObject({
      olWorkId: 'OL17841385W',
      title: 'Casey and Andy',
      authors: [{ name: 'Andy Weir', olid: AUDIOBOOK_IDS.olAuthor }],
      sources: ['openlibrary'],
    });
    expect(books[0]?.asin).toBeUndefined();
  });

  it('falls back to OpenLibrary when Audible fails, and rethrows when both fail', async () => {
    const audibleDown = overrideHost('api.audible.com', () => jsonResponse({}, 500));
    const { catalog } = makeCatalog(audibleDown);
    const books = await catalog.searchBooks('Project Hail Mary');
    expect(books[0]).toMatchObject({ olWorkId: AUDIOBOOK_IDS.olWork, sources: ['openlibrary'] });

    const { catalog: down } = makeCatalog(() => jsonResponse({}, 500));
    await expect(down.searchBooks('Project Hail Mary')).rejects.toMatchObject({
      code: 'bad-response',
      httpStatus: 500,
    });
  });

  it('does not touch OpenLibrary when the fallback is off', async () => {
    const { catalog, hosts } = makeCatalog(audiobookRoute, { openLibraryFallback: false });
    expect(await catalog.searchBooks('Casey and Andy')).toEqual([]);
    expect(hosts()).toEqual(['api.audible.com']);
  });

  it('skips every request for an empty query', async () => {
    const { catalog, fake } = makeCatalog();
    expect(await catalog.searchBooks({ title: ' ' })).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('AudiobookCatalog.searchAuthors', () => {
  it('uses Audnexus and returns each author once', async () => {
    const { catalog, hosts } = makeCatalog();
    const authors = await catalog.searchAuthors('Andy Weir');
    expect(hosts()).toEqual(['api.audnex.us']);
    expect(authors.filter((a) => a.asin === AUDIOBOOK_IDS.authorAsin)).toHaveLength(1);
    expect(authors[0]).toMatchObject({ name: 'Andy Weir', asin: AUDIOBOOK_IDS.authorAsin });
  });

  it('falls back to OpenLibrary when Audnexus finds no one', async () => {
    const noOne = overrideHost('api.audnex.us', () => jsonResponse([]));
    const { catalog, hosts } = makeCatalog(noOne);
    const authors = await catalog.searchAuthors('Andy Weir');
    expect(hosts()).toEqual(['api.audnex.us', 'openlibrary.org']);
    expect(authors[0]).toMatchObject({ name: 'Andy Weir', olid: AUDIOBOOK_IDS.olAuthor });
  });
});

describe('AudiobookCatalog.getAuthorWithBooks', () => {
  it('combines the Audnexus author with the Audible bibliography', async () => {
    const { catalog, hosts } = makeCatalog(audiobookRoute, { languages: ['english'] });
    const { author, books, series } = await catalog.getAuthorWithBooks(AUDIOBOOK_IDS.authorAsin);
    expect(new Set(hosts())).toEqual(new Set(['api.audnex.us', 'api.audible.com']));
    expect(author).toMatchObject({
      name: 'Andy Weir',
      asin: AUDIOBOOK_IDS.authorAsin,
      sources: ['audnexus'],
    });
    expect(author.description).toMatch(/software engineer/);
    expect(books.every((b) => b.language === 'english')).toBe(true);
    expect(books.map((b) => b.title)).toEqual(
      expect.arrayContaining(['Project Hail Mary', 'The Martian', 'Artemis', 'The Egg']),
    );
    expect(books.map((b) => b.title)).not.toContain('Der Marsianer');
    const forward = series.find((s) => s.name === 'Forward Collection');
    expect(forward?.books.map((e) => [e.book.title, e.position])).toEqual([
      ['Forward', '1-6'],
      ['Randomize', undefined],
    ]);
  });

  it('resolves an author by name through Audnexus', async () => {
    const { catalog, fake } = makeCatalog(audiobookRoute, { languages: ['english'] });
    const { author, books } = await catalog.getAuthorWithBooks({ name: 'andy weir' });
    expect(author.asin).toBe(AUDIOBOOK_IDS.authorAsin);
    expect(books.length).toBeGreaterThan(5);
    expect(fake.calls[0]?.url.pathname).toBe('/authors');
  });

  it('falls back to OpenLibrary works when Audible has no bibliography', async () => {
    const empty = overrideHost('api.audible.com', () => jsonResponse({ products: [], total_results: 0 }));
    const { catalog, hosts } = makeCatalog(empty);
    const { author, books } = await catalog.getAuthorWithBooks(AUDIOBOOK_IDS.authorAsin);
    expect(hosts()).toContain('openlibrary.org');
    expect(author).toMatchObject({
      name: 'Andy Weir',
      asin: AUDIOBOOK_IDS.authorAsin,
      olid: AUDIOBOOK_IDS.olAuthor,
      birthDate: '16 June 1972',
      sources: ['audnexus', 'openlibrary'],
    });
    expect(books).toHaveLength(13);
    const phm = books.find((b) => b.olWorkId === AUDIOBOOK_IDS.olWork);
    expect(phm).toMatchObject({
      title: 'Project Hail Mary',
      authors: [{ name: 'Andy Weir', olid: AUDIOBOOK_IDS.olAuthor, asin: AUDIOBOOK_IDS.authorAsin }],
      sources: ['openlibrary'],
    });
  });

  it('serves an OpenLibrary-only author by OLID', async () => {
    const { catalog, hosts } = makeCatalog();
    const { author, books } = await catalog.getAuthorWithBooks({ olid: AUDIOBOOK_IDS.olAuthor });
    expect(new Set(hosts())).toEqual(new Set(['openlibrary.org']));
    expect(author.olid).toBe(AUDIOBOOK_IDS.olAuthor);
    expect(author.image).toBe('https://covers.openlibrary.org/a/id/8137363-L.jpg?default=false');
    expect(books).toHaveLength(13);
  });

  it('throws not-found when no source knows the author', async () => {
    const { catalog } = makeCatalog();
    const err = await catalog.getAuthorWithBooks({ name: 'Nobody Atall' }).catch((e: unknown) => e);
    expect(isMetadataError(err, 'not-found')).toBe(true);
  });
});

describe('AudiobookCatalog.getBook', () => {
  it('returns the canonical Audnexus record by ASIN', async () => {
    const { catalog, hosts } = makeCatalog();
    const result = await catalog.getBook(AUDIOBOOK_IDS.seriesBookAsin);
    expect(result).toMatchObject({
      asin: AUDIOBOOK_IDS.seriesBookAsin,
      title: 'All These Worlds',
      series: [{ name: 'Bobiverse', asin: AUDIOBOOK_IDS.seriesAsin, position: '3', positionNumber: 3 }],
      narrators: ['Ray Porter'],
      sources: ['audnexus'],
    });
    // The audio ISBN is unknown to OpenLibrary: one lookup, nothing merged.
    expect(hosts()).toEqual(['api.audnex.us', 'openlibrary.org']);
  });

  it('enriches the Audnexus record from OpenLibrary by ISBN', async () => {
    const withPrintIsbn = overrideHost('api.audnex.us', () =>
      jsonResponse({ ...audnexusFixtures.book, isbn: AUDIOBOOK_IDS.printIsbn }),
    );
    const { catalog } = makeCatalog(withPrintIsbn);
    const result = await catalog.getBook({ asin: AUDIOBOOK_IDS.bookAsin });
    expect(result).toMatchObject({
      asin: AUDIOBOOK_IDS.bookAsin,
      isbn: AUDIOBOOK_IDS.printIsbn,
      olWorkId: AUDIOBOOK_IDS.olWork,
      olEditionId: AUDIOBOOK_IDS.olEdition,
      // Audnexus wins on conflicting scalars.
      publisher: 'Audible Studios',
      releaseDate: '2021-05-04',
      runtimeMinutes: 970,
      sources: ['audnexus', 'openlibrary'],
    });
    expect(result.authors).toEqual([
      { name: 'Andy Weir', asin: AUDIOBOOK_IDS.authorAsin, olid: AUDIOBOOK_IDS.olAuthor },
    ]);
    expect(result.images.cover).toBe('https://m.media-amazon.com/images/I/81Nzlrfud+L.jpg');
    expect(result.images.thumbnail).toMatch(/covers\.openlibrary\.org/);
  });

  it('falls back to OpenLibrary by ISBN when Audnexus has no record', async () => {
    const { catalog } = makeCatalog();
    const result = await catalog.getBook({
      asin: AUDIOBOOK_IDS.missingAsin,
      isbn: '0-593-13520-2',
    });
    expect(result).toMatchObject({
      asin: AUDIOBOOK_IDS.missingAsin,
      isbn: AUDIOBOOK_IDS.printIsbn,
      olWorkId: AUDIOBOOK_IDS.olWork,
      olEditionId: AUDIOBOOK_IDS.olEdition,
      title: 'Project Hail Mary',
      language: 'english',
      publisher: 'Ballantine Books',
      releaseDate: '2021-05-04',
      sources: ['openlibrary'],
    });
    expect(result.overview).toMatch(/Ryland Grace/);
    expect(await catalog.getBook(AUDIOBOOK_IDS.printIsbn)).toMatchObject({
      olEditionId: AUDIOBOOK_IDS.olEdition,
    });
  });

  it('looks up an OpenLibrary work id', async () => {
    const { catalog, hosts } = makeCatalog();
    const result = await catalog.getBook({ olWorkId: AUDIOBOOK_IDS.olWork });
    expect(hosts()).toEqual(['openlibrary.org']);
    expect(result.olWorkId).toBe(AUDIOBOOK_IDS.olWork);
    expect(result.images.cover).toBe(
      'https://covers.openlibrary.org/b/id/11200092-L.jpg?default=false',
    );
  });

  it('throws not-found when nobody has the book, and passes other errors on', async () => {
    const { catalog } = makeCatalog();
    await expect(catalog.getBook(AUDIOBOOK_IDS.missingAsin)).rejects.toMatchObject({
      code: 'not-found',
    });
    const { catalog: throttled } = makeCatalog(() => jsonResponse({}, 429));
    await expect(throttled.getBook(AUDIOBOOK_IDS.bookAsin)).rejects.toMatchObject({
      code: 'rate-limited',
    });
  });

  it('gets chapters from Audnexus', async () => {
    const { catalog } = makeCatalog();
    const chapters = await catalog.getChapters(AUDIOBOOK_IDS.bookAsin, { region: 'us' });
    expect(chapters.chapters).toHaveLength(33);
  });

  it('passes an abort through instead of falling back', async () => {
    const { catalog, fake } = makeCatalog();
    const controller = new AbortController();
    controller.abort();
    await expect(
      catalog.searchBooks('Project Hail Mary', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('dedupeBooks', () => {
  it('merges by ASIN, keeping the first record’s values and unioning lists', () => {
    const merged = dedupeBooks([
      book({ asin: 'B000000001', title: 'One', narrators: ['A'], sources: ['audnexus'] }),
      book({ asin: 'B000000001', title: 'One (Unabridged)', narrators: ['B'], publisher: 'P' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      title: 'One',
      narrators: ['A', 'B'],
      publisher: 'P',
      sources: ['audnexus', 'audible'],
    });
  });

  it('merges by any shared ISBN, then by normalised title and author', () => {
    const merged = dedupeBooks([
      book({ asin: 'B000000001', title: 'Project Hail Mary', isbns: ['9780593135204'] }),
      book({ title: 'Something else', isbns: ['9780593135204', '9780593135211'], sources: ['openlibrary'] }),
      book({
        title: 'The Martian: A Novel',
        authors: [{ name: 'Weir, Andy' }],
        olWorkId: 'OL17091839W',
        sources: ['openlibrary'],
      }),
      book({ asin: 'B082BHJMFF', title: 'Martian', authors: [{ name: 'Andy Weir', asin: 'B00G0WYW92' }] }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ asin: 'B000000001', isbns: ['9780593135204', '9780593135211'] });
    expect(merged[1]).toMatchObject({
      title: 'The Martian: A Novel',
      asin: 'B082BHJMFF',
      olWorkId: 'OL17091839W',
      authors: [{ name: 'Weir, Andy', asin: 'B00G0WYW92' }],
    });
  });

  it('never merges two different ASINs, even with the same title and author', () => {
    const merged = dedupeBooks([
      book({ asin: 'B079Q9DPY2', title: 'Artemis', language: 'german' }),
      book({ asin: 'B072R1CY4P', title: 'Artemis', language: 'english' }),
      book({ title: 'Artemis', olWorkId: 'OL17837968W', sources: ['openlibrary'] }),
    ]);
    expect(merged.map((b) => [b.asin, b.olWorkId])).toEqual([
      ['B079Q9DPY2', 'OL17837968W'],
      ['B072R1CY4P', undefined],
    ]);
  });

  it('normalises titles and names for matching', () => {
    expect(titleAuthorKey(book({ title: 'The Égg (Unabridged)', authors: [{ name: 'Andy  Weir' }] }))).toBe(
      titleAuthorKey(book({ title: 'Egg: and other stories', authors: [{ name: 'Weir, Andy' }] })),
    );
    expect(titleAuthorKey(book({ title: 'X', authors: [] }))).toBeUndefined();
  });
});

describe('groupSeries', () => {
  it('orders books by numeric position, unnumbered last', () => {
    const s = (position?: string) => [
      {
        name: 'Bobiverse',
        asin: 'B01M1RDL6W',
        ...(position ? { position, positionNumber: Number(position) } : {}),
      },
    ];
    const series = groupSeries([
      book({ title: 'Three', series: s('3') }),
      book({ title: 'Extra', series: s() }),
      book({ title: 'One', series: s('1') }),
      book({ title: 'Two', series: s('2') }),
    ]);
    expect(series).toHaveLength(1);
    expect(series[0]?.books.map((e) => e.book.title)).toEqual(['One', 'Two', 'Three', 'Extra']);
  });
});
