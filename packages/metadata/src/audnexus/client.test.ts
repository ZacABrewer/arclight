import { describe, expect, it } from 'vitest';
import { MetadataError, isMetadataError } from '../types.js';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import {
  AUDIOBOOK_IDS,
  TEST_USER_AGENT,
  audnexusFixtures,
  audnexusRoute,
} from '../audiobook-test-support.js';
import { createAudnexusClient, type AudnexusClientOptions } from './client.js';

function makeClient(
  route: Parameters<typeof createFakeFetch>[0] = audnexusRoute,
  extra: Partial<AudnexusClientOptions> = {},
) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const limiter = new RateLimiter({ clock, random: () => 0 });
  const client = createAudnexusClient({
    userAgent: TEST_USER_AGENT,
    fetchImpl: fake.fetch,
    rateLimiter: limiter,
    now: () => new Date(clock.now()),
    ...extra,
  });
  return { client, fake, clock, limiter };
}

describe('createAudnexusClient construction', () => {
  it('calls the public host with the region and sends the User-Agent', async () => {
    const { client, fake, limiter } = makeClient();
    await client.getBook(AUDIOBOOK_IDS.bookAsin);
    const call = fake.calls[0];
    expect(call?.url.origin).toBe('https://api.audnex.us');
    expect(call?.url.pathname).toBe(`/books/${AUDIOBOOK_IDS.bookAsin}`);
    expect(call?.url.searchParams.get('region')).toBe('us');
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(TEST_USER_AGENT);
    expect(headers.Accept).toBe('application/json');
    expect(client.providerKey).toBe('audnexus');
    expect(limiter.limitOf('audnexus').requestsPerSecond).toBe(1);
  });

  it('uses a self-hosted base URL on its own bucket and rate', async () => {
    const { client, fake, limiter } = makeClient(audnexusRoute, {
      baseUrl: 'http://audnexus.local:3000',
      requestsPerSecond: 5,
    });
    expect(client.providerKey).toBe('audnexus@audnexus.local:3000');
    expect(limiter.limitOf(client.providerKey).requestsPerSecond).toBe(5);
    await client.getBook(AUDIOBOOK_IDS.bookAsin);
    expect(fake.calls[0]?.url.toString()).toBe(
      `http://audnexus.local:3000/books/${AUDIOBOOK_IDS.bookAsin}?region=us`,
    );
  });

  it('passes the per-call region, falling back to the client default', async () => {
    const { client, fake } = makeClient(audnexusRoute, { region: 'uk' });
    await client.getAuthor(AUDIOBOOK_IDS.authorAsin);
    await client.getAuthor(AUDIOBOOK_IDS.authorAsin, { region: 'de' });
    expect(fake.calls.map((c) => c.url.searchParams.get('region'))).toEqual(['uk', 'de']);
  });

  it('rejects an unknown region', () => {
    expect(() => createAudnexusClient({ region: 'xx' as never })).toThrow(/Audible region/);
  });
});

describe('Audnexus mapping', () => {
  it('maps a book with narrators, runtime, genres, ISBN and release date', async () => {
    const { client } = makeClient();
    const book = await client.getBook(AUDIOBOOK_IDS.bookAsin.toLowerCase());
    expect(book).toMatchObject({
      asin: AUDIOBOOK_IDS.bookAsin,
      region: 'us',
      title: 'Project Hail Mary',
      authors: [{ asin: AUDIOBOOK_IDS.authorAsin, name: 'Andy Weir' }],
      narrators: ['Ray Porter'],
      runtimeMinutes: 970,
      formatType: 'unabridged',
      literatureType: 'fiction',
      image: 'https://m.media-amazon.com/images/I/81Nzlrfud+L.jpg',
      releaseDate: '2021-05-04',
      copyrightYear: 2021,
      publisher: 'Audible Studios',
      language: 'english',
      isbn: AUDIOBOOK_IDS.audioIsbn,
      rating: 4.9,
      isAdult: false,
    });
    expect(book.seriesPrimary).toBeUndefined();
    expect(book.genres[0]).toEqual({ asin: '18574426011', name: 'Literature & Fiction', type: 'genre' });
    expect(book.genres.some((g) => g.type === 'tag' && g.name === 'Hard Science Fiction')).toBe(true);
    expect(book.summaryHtml).toMatch(/^<p>/);
    expect(book.overview).not.toMatch(/<[a-z]/i);
    expect(book.overview).toMatch(/NEW YORK TIMES/);
  });

  it('maps series primary and secondary with positions', async () => {
    const withSecondary = {
      ...audnexusFixtures.bookSeries,
      seriesSecondary: { asin: 'B0SECOND01', name: 'Bobiverse Omnibus', position: '1-3' },
    };
    const { client } = makeClient(() => jsonResponse(withSecondary));
    const book = await client.getBook(AUDIOBOOK_IDS.seriesBookAsin);
    expect(book.subtitle).toBe('Bobiverse, Book 3');
    expect(book.seriesPrimary).toEqual({
      asin: AUDIOBOOK_IDS.seriesAsin,
      name: 'Bobiverse',
      position: '3',
      positionNumber: 3,
    });
    expect(book.seriesSecondary).toEqual({
      asin: 'B0SECOND01',
      name: 'Bobiverse Omnibus',
      position: '1-3',
    });
    expect(book.authors).toEqual([{ asin: 'B010ETTBJC', name: 'Dennis E. Taylor' }]);
  });

  it('maps chapters with 1-based indexes and millisecond offsets', async () => {
    const { client, fake } = makeClient();
    const chapters = await client.getChapters(AUDIOBOOK_IDS.bookAsin);
    expect(fake.calls[0]?.url.pathname).toBe(`/books/${AUDIOBOOK_IDS.bookAsin}/chapters`);
    expect(chapters).toMatchObject({
      asin: AUDIOBOOK_IDS.bookAsin,
      accurate: true,
      runtimeMs: 58244201,
      brandIntroMs: 0,
      brandOutroMs: 0,
    });
    expect(chapters.chapters).toHaveLength(33);
    expect(chapters.chapters[0]).toEqual({ index: 1, title: 'Opening Credits', startMs: 0, lengthMs: 11264 });
    expect(chapters.chapters[2]).toMatchObject({ index: 3, title: 'Chapter 1', startMs: 17173 });
  });

  it('maps an author with genres and similar authors', async () => {
    const { client } = makeClient();
    const author = await client.getAuthor(AUDIOBOOK_IDS.authorAsin);
    expect(author.name).toBe('Andy Weir');
    expect(author.description).toMatch(/software engineer/);
    expect(author.image).toMatch(/^https:\/\//);
    expect(author.genres.length).toBeGreaterThan(0);
    expect(author.similar).toContainEqual({ asin: 'B001IGFHW6', name: 'Brandon Sanderson' });
  });

  it('collapses the repeated entries of an author name search', async () => {
    const { client, fake } = makeClient();
    const results = await client.searchAuthors('  Andy Weir ');
    expect(fake.calls[0]?.url.searchParams.get('name')).toBe('Andy Weir');
    expect(results.filter((r) => r.asin === AUDIOBOOK_IDS.authorAsin)).toHaveLength(1);
    expect(results[0]).toEqual({ asin: AUDIOBOOK_IDS.authorAsin, name: 'Andy Weir' });
    expect(new Set(results.map((r) => r.asin)).size).toBe(results.length);
  });

  it('skips the request for an empty author search', async () => {
    const { client, fake } = makeClient();
    expect(await client.searchAuthors('   ')).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('Audnexus caching and rate limiting', () => {
  it('caches books for the configured TTL', async () => {
    const fake = createFakeFetch(audnexusRoute);
    let now = 0;
    const client = createAudnexusClient({
      fetchImpl: fake.fetch,
      rateLimiter: new RateLimiter({ clock: createInstantClock(0) }),
      now: () => new Date(now),
      cacheTtls: { book: 1000 },
    });
    await client.getBook(AUDIOBOOK_IDS.bookAsin);
    await client.getBook(AUDIOBOOK_IDS.bookAsin);
    expect(fake.calls).toHaveLength(1);
    now += 2000;
    await client.getBook(AUDIOBOOK_IDS.bookAsin);
    expect(fake.calls).toHaveLength(2);
  });

  it('keys the cache by region', async () => {
    const { client, fake } = makeClient();
    await client.getBook(AUDIOBOOK_IDS.bookAsin, { region: 'us' });
    await client.getBook(AUDIOBOOK_IDS.bookAsin, { region: 'uk' });
    expect(fake.calls).toHaveLength(2);
  });

  it('spaces calls one second apart by default', async () => {
    const { client, clock } = makeClient(audnexusRoute, { cacheTtls: { book: 0 } });
    await client.getBook(AUDIOBOOK_IDS.bookAsin);
    await client.getBook(AUDIOBOOK_IDS.bookAsin);
    await client.getBook(AUDIOBOOK_IDS.bookAsin);
    expect(clock.elapsed()).toBe(2000);
  });

  it('backs off after a 429, honouring Retry-After, then succeeds', async () => {
    let attempts = 0;
    const { client, clock } = makeClient((url) => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({ error: 'Too many requests' }, 429, { 'retry-after': '4' })
        : audnexusRoute(url);
    });
    const book = await client.getBook(AUDIOBOOK_IDS.bookAsin);
    expect(book.title).toBe('Project Hail Mary');
    expect(attempts).toBe(2);
    expect(clock.elapsed()).toBe(4000);
  });
});

describe('Audnexus errors', () => {
  it('maps 404 (unknown ASIN or not in region) to not-found', async () => {
    const { client } = makeClient();
    const err = await client.getBook(AUDIOBOOK_IDS.missingAsin).catch((e: unknown) => e);
    expect(isMetadataError(err, 'not-found')).toBe(true);
    expect((err as MetadataError).httpStatus).toBe(404);
  });

  it('rejects malformed ASINs without a request', async () => {
    const { client, fake } = makeClient();
    await expect(client.getBook('not-an-asin')).rejects.toMatchObject({ code: 'not-found' });
    expect(fake.calls).toHaveLength(0);
  });

  it('maps a persistent 503 to rate-limited after the retries', async () => {
    const { client, fake } = makeClient(() => jsonResponse({ error: 'busy' }, 503), {
      maxRetries: 2,
    });
    const err = await client.getBook(AUDIOBOOK_IDS.bookAsin).catch((e: unknown) => e);
    expect(isMetadataError(err, 'rate-limited')).toBe(true);
    expect((err as MetadataError).httpStatus).toBe(503);
    expect(fake.calls).toHaveLength(3);
  });

  it('maps malformed bodies to bad-response', async () => {
    const { client } = makeClient(() => jsonResponse({ unexpected: true }));
    await expect(client.getBook(AUDIOBOOK_IDS.bookAsin)).rejects.toMatchObject({
      code: 'bad-response',
    });
  });
});
