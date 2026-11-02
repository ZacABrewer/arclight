import { describe, expect, it } from 'vitest';
import { isMetadataError } from '../types.js';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse, type Responder } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import { createGoogleBooksClient, googleBooksQueryString, type GoogleBooksClientOptions } from './google-books.js';

const VOLUME = {
  id: 'vol123',
  volumeInfo: {
    title: 'The Final Empire',
    subtitle: 'Mistborn Book One',
    authors: ['Brandon Sanderson'],
    publisher: 'Tor Books',
    publishedDate: '2006-07-17',
    description: '<p>For a thousand years the ash fell.</p>',
    industryIdentifiers: [
      { type: 'ISBN_10', identifier: '076531178X' },
      { type: 'ISBN_13', identifier: '9780765311788' },
    ],
    pageCount: 541,
    categories: ['Fiction / Fantasy / Epic'],
    averageRating: 4.5,
    language: 'en',
    imageLinks: {
      thumbnail: 'http://books.google.com/books/content?id=vol123&printsec=frontcover&img=1&zoom=1&edge=curl',
    },
    seriesInfo: { kind: 'books#volume_series_info', bookDisplayNumber: '1' },
  },
};

function makeClient(route: Responder, extra: Partial<GoogleBooksClientOptions> = {}) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const client = createGoogleBooksClient({
    fetchImpl: fake.fetch,
    rateLimiter: new RateLimiter({ clock, random: () => 0 }),
    now: () => new Date(clock.now()),
    cacheTtlMs: 0,
    ...extra,
  });
  return { client, fake };
}

describe('Google Books client', () => {
  it('builds qualified queries', () => {
    expect(googleBooksQueryString({ title: 'The Final Empire', author: 'Sanderson' })).toBe(
      'intitle:"The Final Empire" inauthor:Sanderson',
    );
    expect(googleBooksQueryString({ isbn: '978-0-7653-1178-8' })).toBe('isbn:9780765311788');
  });

  it('searches with the key and maps volumes', async () => {
    const { client, fake } = makeClient(() => jsonResponse({ totalItems: 1, items: [VOLUME] }), {
      apiKey: 'gb-key',
      userAgent: 'ArclightTest/1.0',
    });
    const page = await client.searchVolumes({ title: 'The Final Empire' }, { maxResults: 5 });
    const url = fake.calls[0]!.url;
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/books/v1/volumes');
    expect(url.searchParams.get('q')).toBe('intitle:"The Final Empire"');
    expect(url.searchParams.get('key')).toBe('gb-key');
    expect(url.searchParams.get('maxResults')).toBe('5');
    expect((fake.calls[0]!.init?.headers as Record<string, string>)['User-Agent']).toBe('ArclightTest/1.0');
    expect(page.total).toBe(1);
    expect(page.records[0]).toMatchObject({
      key: 'isbn:9780765311788',
      keys: ['isbn:9780765311788', 'gb:vol123'],
      title: 'The Final Empire',
      subtitle: 'Mistborn Book One',
      authors: [{ name: 'Brandon Sanderson' }],
      isbn13: '9780765311788',
      googleVolumeId: 'vol123',
      publisher: 'Tor Books',
      language: 'en',
      releaseDate: '2006-07-17',
      pageCount: 541,
      overview: 'For a thousand years the ash fell.',
      genres: ['Fiction', 'Fantasy', 'Epic'],
      rating: 4.5,
      series: [],
      sources: ['googleBooks'],
    });
    expect(page.records[0]!.coverUrl).toBe(
      'https://books.google.com/books/content?id=vol123&printsec=frontcover&img=1&zoom=1',
    );
  });

  it('works keyless', async () => {
    const { client, fake } = makeClient(() => jsonResponse({ totalItems: 0 }));
    expect((await client.searchVolumes({ q: 'nothing' })).records).toEqual([]);
    expect(fake.calls[0]!.url.searchParams.has('key')).toBe(false);
  });

  it('gets a volume and maps 404 to not-found', async () => {
    const { client, fake } = makeClient((url) =>
      url.pathname.endsWith('/vol123') ? jsonResponse(VOLUME) : jsonResponse({ error: { code: 404 } }, 404),
    );
    expect((await client.getVolume('vol123')).key).toBe('isbn:9780765311788');
    expect(fake.calls[0]!.url.pathname).toBe('/books/v1/volumes/vol123');
    await expect(client.getVolume('missing')).rejects.toSatisfy((e) => isMetadataError(e, 'not-found'));
  });

  it('finds a volume by ISBN', async () => {
    const { client, fake } = makeClient(() => jsonResponse({ totalItems: 1, items: [VOLUME] }));
    expect((await client.byIsbn('076531178X'))?.googleVolumeId).toBe('vol123');
    expect(fake.calls[0]!.url.searchParams.get('q')).toBe('isbn:076531178X');
    expect(await client.byIsbn('not-an-isbn')).toBeUndefined();
  });

  it('maps 403 to unauthorized and 500 to bad-response', async () => {
    const forbidden = makeClient(() => jsonResponse({ error: { code: 403 } }, 403));
    await expect(forbidden.client.searchVolumes({ q: 'x' })).rejects.toSatisfy((e) =>
      isMetadataError(e, 'unauthorized'),
    );
    const broken = makeClient(() => jsonResponse({}, 500));
    await expect(broken.client.searchVolumes({ q: 'x' })).rejects.toSatisfy((e) =>
      isMetadataError(e, 'bad-response'),
    );
  });

  it('retries after a 429 and gives up with rate-limited', async () => {
    let n = 0;
    const flaky = makeClient(() =>
      n++ === 0 ? jsonResponse({}, 429) : jsonResponse({ totalItems: 1, items: [VOLUME] }),
    );
    expect((await flaky.client.searchVolumes({ q: 'x' })).records).toHaveLength(1);
    expect(flaky.fake.calls).toHaveLength(2);
    const throttled = makeClient(() => jsonResponse({}, 429), { maxRetries: 1 });
    await expect(throttled.client.searchVolumes({ q: 'x' })).rejects.toSatisfy((e) =>
      isMetadataError(e, 'rate-limited'),
    );
    expect(throttled.fake.calls).toHaveLength(2);
  });
});
