import { describe, expect, it } from 'vitest';
import { isMetadataError } from '../types.js';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import {
  AUDIOBOOK_IDS,
  TEST_USER_AGENT,
  openLibraryRoute,
} from '../audiobook-test-support.js';
import {
  createOpenLibraryClient,
  type OpenLibraryClientOptions,
} from './client.js';
import { openLibraryAuthorPhotoUrl, openLibraryCoverUrl } from './covers.js';
import { olidFromKey, parseOlDate } from './map.js';

function makeClient(
  route: Parameters<typeof createFakeFetch>[0] = openLibraryRoute,
  extra: Partial<OpenLibraryClientOptions> = {},
) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const limiter = new RateLimiter({ clock, random: () => 0 });
  const client = createOpenLibraryClient({
    userAgent: TEST_USER_AGENT,
    fetchImpl: fake.fetch,
    rateLimiter: limiter,
    now: () => new Date(clock.now()),
    ...extra,
  });
  return { client, fake, clock, limiter };
}

describe('createOpenLibraryClient construction', () => {
  it('refuses to construct without a User-Agent', () => {
    expect(() => createOpenLibraryClient({ userAgent: '' })).toThrow(/User-Agent/);
    expect(() => createOpenLibraryClient({ userAgent: '  ' })).toThrow(/User-Agent/);
    expect(() =>
      createOpenLibraryClient(undefined as unknown as OpenLibraryClientOptions),
    ).toThrow(/User-Agent/);
  });

  it('sends the User-Agent at 1 req/s', async () => {
    const { client, fake, limiter, clock } = makeClient(openLibraryRoute, {
      cacheTtls: { record: 0 },
    });
    await client.getAuthor(AUDIOBOOK_IDS.olAuthor);
    await client.getAuthor(AUDIOBOOK_IDS.olAuthor);
    const headers = fake.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(TEST_USER_AGENT);
    expect(fake.calls[0]?.url.toString()).toBe(
      `https://openlibrary.org/authors/${AUDIOBOOK_IDS.olAuthor}.json`,
    );
    expect(limiter.limitOf('openlibrary').requestsPerSecond).toBe(1);
    expect(clock.elapsed()).toBe(1000);
  });
});

describe('OpenLibrary authors', () => {
  it('searches authors', async () => {
    const { client, fake } = makeClient();
    const page = await client.searchAuthors('Andy Weir', { limit: 5 });
    expect(fake.calls[0]?.url.pathname).toBe('/search/authors.json');
    expect(fake.calls[0]?.url.searchParams.get('limit')).toBe('5');
    expect(page.total).toBe(2);
    expect(page.results[0]).toMatchObject({
      olid: AUDIOBOOK_IDS.olAuthor,
      name: 'Andy Weir',
      birthDate: '16 June 1972',
      topWork: 'The Martian',
      workCount: 13,
    });
  });

  it('maps an author with bio, photos and the Amazon ASIN', async () => {
    const { client } = makeClient();
    const author = await client.getAuthor(`/authors/${AUDIOBOOK_IDS.olAuthor}`);
    expect(author).toMatchObject({
      olid: AUDIOBOOK_IDS.olAuthor,
      name: 'Andy Weir',
      amazonAsin: AUDIOBOOK_IDS.authorAsin,
      wikidataId: 'Q18590295',
      photoIds: [8137363, 14631002],
      alternateNames: ['Jack Sharp'],
    });
    expect(author.bio).toMatch(/software engineer/);
    expect(author.links[0]).toEqual({ title: 'Official Website', url: 'https://andyweirauthor.com' });
  });

  it('pages author works by offset', async () => {
    const { client, fake } = makeClient();
    const first = await client.authorWorks(AUDIOBOOK_IDS.olAuthor, { limit: 10 });
    expect(first.total).toBe(13);
    expect(first.offset).toBe(0);
    expect(first.results).toHaveLength(10);
    const second = await client.authorWorks(AUDIOBOOK_IDS.olAuthor, { limit: 10, offset: 10 });
    expect(second.results.map((w) => w.title)).toEqual(['Lacero', 'The Egg', 'Casey and Andy']);
    expect(fake.calls.map((c) => c.url.searchParams.get('offset'))).toEqual(['0', '10']);
  });

  it('collects every work across pages', async () => {
    const { client, fake } = makeClient();
    const works = await client.allAuthorWorks(AUDIOBOOK_IDS.olAuthor);
    expect(works).toHaveLength(13);
    expect(works.map((w) => w.olid)).toContain(AUDIOBOOK_IDS.olWork);
    expect(fake.calls).toHaveLength(2);
  });
});

describe('OpenLibrary works and editions', () => {
  it('maps a work, dropping placeholder cover ids', async () => {
    const { client } = makeClient();
    const work = await client.getWork(AUDIOBOOK_IDS.olWork);
    expect(work).toMatchObject({
      olid: AUDIOBOOK_IDS.olWork,
      title: 'Project Hail Mary',
      authorOlids: [AUDIOBOOK_IDS.olAuthor],
    });
    expect(work.description).toMatch(/Ryland Grace/);
    expect(work.coverIds).not.toContain(-1);
    expect(work.coverIds[0]).toBe(11200092);
    expect(work.subjects).toContain('Astronauts');
  });

  it('maps an edition', async () => {
    const { client } = makeClient();
    const edition = await client.getEdition(AUDIOBOOK_IDS.olEdition);
    expect(edition).toMatchObject({
      olid: AUDIOBOOK_IDS.olEdition,
      workOlids: [AUDIOBOOK_IDS.olWork],
      title: 'Project Hail Mary',
      publishDate: 'May 04, 2021',
      releaseDate: '2021-05-04',
      publishers: ['Ballantine Books'],
      isbn10: ['0593135202'],
      isbn13: [AUDIOBOOK_IDS.printIsbn],
      languages: ['english'],
      pages: 496,
      physicalFormat: 'hardcover',
    });
  });

  it('looks up an edition by ISBN, normalising it first', async () => {
    const { client, fake } = makeClient();
    const edition = await client.byIsbn('978-0-593-13520-4');
    expect(fake.calls[0]?.url.pathname).toBe(`/isbn/${AUDIOBOOK_IDS.printIsbn}.json`);
    expect(edition?.olid).toBe(AUDIOBOOK_IDS.olEdition);
  });

  it('resolves undefined for an ISBN OpenLibrary lacks (HTML 404) or an invalid one', async () => {
    const { client, fake } = makeClient();
    expect(await client.byIsbn(AUDIOBOOK_IDS.audioIsbn)).toBeUndefined();
    expect(await client.byIsbn('1234567890123')).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it('searches books with the fields it maps', async () => {
    const { client, fake } = makeClient();
    const page = await client.searchBooks({ title: 'Project Hail Mary', author: 'Andy Weir' }, { limit: 5 });
    const q = fake.calls[0]?.url.searchParams;
    expect(q?.get('title')).toBe('Project Hail Mary');
    expect(q?.get('author')).toBe('Andy Weir');
    expect(q?.get('fields')).toContain('isbn');
    expect(page.total).toBe(2);
    expect(page.results[0]).toMatchObject({
      olid: AUDIOBOOK_IDS.olWork,
      title: 'Project Hail Mary',
      authorNames: ['Andy Weir'],
      authorOlids: [AUDIOBOOK_IDS.olAuthor],
      firstPublishYear: 2021,
      coverId: 11200092,
    });
    expect(page.results[0]?.isbns).toContain(AUDIOBOOK_IDS.printIsbn);
    expect(page.results[0]?.languages).toContain('english');
  });
});

describe('OpenLibrary errors', () => {
  it('maps 404 to not-found and rejects malformed ids without a request', async () => {
    const { client, fake } = makeClient();
    const err = await client.getWork('OL1W').catch((e: unknown) => e);
    expect(isMetadataError(err, 'not-found')).toBe(true);
    await expect(client.getWork(AUDIOBOOK_IDS.olAuthor)).rejects.toMatchObject({ code: 'not-found' });
    await expect(client.getAuthor('nonsense')).rejects.toMatchObject({ code: 'not-found' });
    expect(fake.calls).toHaveLength(1);
  });

  it('retries after 503 with backoff and maps a persistent 429 to rate-limited', async () => {
    let attempts = 0;
    const { client, clock } = makeClient((url) => {
      attempts += 1;
      return attempts === 1 ? jsonResponse({ error: 'busy' }, 503) : openLibraryRoute(url);
    });
    const work = await client.getWork(AUDIOBOOK_IDS.olWork);
    expect(work.title).toBe('Project Hail Mary');
    // No Retry-After: exponential backoff (1 s base, jitter 0) then the 1 s token.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(500);

    const { client: throttled, fake } = makeClient(() => jsonResponse({}, 429), { maxRetries: 1 });
    await expect(throttled.getWork(AUDIOBOOK_IDS.olWork)).rejects.toMatchObject({
      code: 'rate-limited',
      httpStatus: 429,
    });
    expect(fake.calls).toHaveLength(2);
  });
});

describe('OpenLibrary helpers', () => {
  it('builds cover and author photo URLs', () => {
    expect(openLibraryCoverUrl({ id: 12455001 })).toBe(
      'https://covers.openlibrary.org/b/id/12455001-L.jpg?default=false',
    );
    expect(openLibraryCoverUrl({ isbn: '978-0-593-13520-4' }, { size: 'M', notFoundAs404: false })).toBe(
      'https://covers.openlibrary.org/b/isbn/9780593135204-M.jpg',
    );
    expect(openLibraryCoverUrl({ olid: AUDIOBOOK_IDS.olEdition }, { size: 'S' })).toBe(
      `https://covers.openlibrary.org/b/olid/${AUDIOBOOK_IDS.olEdition}-S.jpg?default=false`,
    );
    expect(openLibraryAuthorPhotoUrl({ olid: AUDIOBOOK_IDS.olAuthor }, { size: 'M' })).toBe(
      `https://covers.openlibrary.org/a/olid/${AUDIOBOOK_IDS.olAuthor}-M.jpg?default=false`,
    );
    expect(() => openLibraryCoverUrl({ id: -1 })).toThrow(RangeError);
  });

  it('reads OLIDs and free-text dates', () => {
    expect(olidFromKey('/works/OL21745884W')).toBe('OL21745884W');
    expect(olidFromKey('https://openlibrary.org/authors/OL7234434A.json')).toBe('OL7234434A');
    expect(olidFromKey('ol30036715m')).toBe('OL30036715M');
    expect(olidFromKey('/works/xyz')).toBeUndefined();
    expect(parseOlDate('May 04, 2021')).toBe('2021-05-04');
    expect(parseOlDate('September 2, 2020')).toBe('2020-09-02');
    expect(parseOlDate('2021')).toBe('2021');
    expect(parseOlDate('circa 1999?')).toBe('1999');
    expect(parseOlDate('')).toBeUndefined();
  });
});
