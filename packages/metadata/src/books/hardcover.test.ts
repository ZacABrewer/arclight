import { describe, expect, it } from 'vitest';
import { isMetadataError } from '../types.js';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse, type Responder } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import {
  HARDCOVER_QUERIES,
  createHardcoverClient,
  hardcoverAuthorization,
  type HardcoverClientOptions,
} from './hardcover.js';

const BOOK = {
  id: 386446,
  title: 'The Final Empire',
  subtitle: null,
  description: 'A heist in a world of ash.',
  release_date: '2006-07-17',
  pages: 541,
  rating: 4.4,
  cached_tags: { Genre: [{ tag: 'Fantasy' }, { tag: 'Fiction' }] },
  contributions: [
    { contribution: null, author: { id: 204214, name: 'Brandon Sanderson' } },
    { contribution: 'Narrator', author: { id: 5, name: 'Michael Kramer' } },
  ],
  book_series: [{ position: 1, series: { id: 1, name: 'Mistborn' } }],
  editions: [
    { isbn_13: '9780765311788', isbn_10: '076531178X' },
    { isbn_13: null, isbn_10: null },
  ],
  image: { url: 'https://assets.hardcover.app/books/386446.jpg' },
};

type Body = { query: string; variables: Record<string, unknown> };

function bodyOf(init: RequestInit | undefined): Body {
  return JSON.parse(String(init?.body)) as Body;
}

function makeClient(route: Responder, extra: Partial<HardcoverClientOptions> = {}) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const client = createHardcoverClient({
    token: 'Bearer test-token',
    userAgent: 'ArclightTest/1.0',
    fetchImpl: fake.fetch,
    rateLimiter: new RateLimiter({ clock, random: () => 0 }),
    ...extra,
  });
  return { client, fake };
}

describe('Hardcover client', () => {
  it('requires a token and accepts it with or without Bearer', () => {
    expect(() => createHardcoverClient({ token: '  ' })).toThrow(/token/);
    expect(hardcoverAuthorization('abc')).toBe('Bearer abc');
    expect(hardcoverAuthorization('Bearer abc')).toBe('Bearer abc');
    expect(hardcoverAuthorization('bearer  abc ')).toBe('Bearer abc');
  });

  it('POSTs GraphQL with the bearer token and maps a book', async () => {
    const { client, fake } = makeClient(() => jsonResponse({ data: { books: [BOOK] } }), {
      token: 'test-token',
    });
    const book = await client.getBook('hc:386446');
    const call = fake.calls[0]!;
    expect(call.url.toString()).toBe('https://api.hardcover.app/v1/graphql');
    expect(call.init?.method).toBe('POST');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-token');
    expect(headers['User-Agent']).toBe('ArclightTest/1.0');
    expect(bodyOf(call.init)).toEqual({ query: HARDCOVER_QUERIES.bookById, variables: { id: 386446 } });
    expect(book).toMatchObject({
      key: 'isbn:9780765311788',
      title: 'The Final Empire',
      authors: [{ name: 'Brandon Sanderson', key: 'hc:204214' }],
      isbn13: '9780765311788',
      isbns: ['9780765311788'],
      hardcoverId: '386446',
      releaseDate: '2006-07-17',
      pageCount: 541,
      rating: 4.4,
      genres: ['Fantasy', 'Fiction'],
      series: [{ name: 'Mistborn', position: '1' }],
      coverUrl: 'https://assets.hardcover.app/books/386446.jpg',
      sources: ['hardcover'],
    });
  });

  it('degrades to the minimal document when the schema drifted', async () => {
    const { client, fake } = makeClient((_url, init) => {
      const { query } = bodyOf(init);
      if (query === HARDCOVER_QUERIES.bookById) {
        return jsonResponse({
          errors: [
            {
              message: 'field "cached_tags" not found in type: "books"',
              extensions: { code: 'validation-failed' },
            },
          ],
        });
      }
      return jsonResponse({
        data: { books: [{ id: 7, title: 'Bare Book', contributions: [{ author: { name: 'A Writer' } }] }] },
      });
    });
    const book = await client.getBook('7');
    expect(fake.calls).toHaveLength(2);
    expect(bodyOf(fake.calls[1]!.init).query).toBe(HARDCOVER_QUERIES.bookByIdMinimal);
    expect(book).toMatchObject({ key: 'hc:7', title: 'Bare Book', authors: [{ name: 'A Writer' }], series: [] });
  });

  it('searches books and authors through loosely typed results', async () => {
    const { client, fake } = makeClient((_url, init) => {
      const { variables } = bodyOf(init);
      if (variables.type === 'Author') {
        return jsonResponse({
          data: {
            search: {
              results: {
                found: 1,
                hits: [
                  { document: { id: '204214', name: 'Brandon Sanderson', books: ['Mistborn'], books_count: 300 } },
                  { document: { name: 'no id' } },
                ],
              },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          search: {
            results: {
              hits: [
                {
                  document: {
                    id: '386446',
                    title: 'The Final Empire',
                    author_names: ['Brandon Sanderson'],
                    isbns: ['076531178X', '9780765311788'],
                    release_year: 2006,
                    featured_series: { position: 1, series: { name: 'Mistborn' } },
                    image: { url: 'https://assets.hardcover.app/x.jpg' },
                  },
                },
                'garbage',
              ],
            },
          },
        },
      });
    });
    const books = await client.searchBooks('final empire', { perPage: 5 });
    expect(bodyOf(fake.calls[0]!.init).variables).toEqual({ query: 'final empire', type: 'Book', perPage: 5 });
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({
      key: 'hc:386446',
      isbns: ['9780765311788'],
      releaseDate: '2006',
      series: [{ name: 'Mistborn', position: '1' }],
      authors: [{ name: 'Brandon Sanderson' }],
    });
    const authors = await client.searchAuthors('sanderson');
    expect(authors).toEqual([
      expect.objectContaining({ key: 'hc:204214', name: 'Brandon Sanderson', topWork: 'Mistborn', workCount: 300 }),
    ]);
  });

  it('gets an author with only the books they wrote', async () => {
    const { client } = makeClient(() =>
      jsonResponse({
        data: {
          authors: [
            {
              id: 204214,
              name: 'Brandon Sanderson',
              bio: 'Writes long books.',
              contributions: [
                { contribution: null, book: BOOK },
                { contribution: 'Narrator', book: { id: 9, title: 'Narrated Thing' } },
              ],
            },
          ],
        },
      }),
    );
    const result = await client.getAuthor('204214');
    expect(result?.author).toMatchObject({
      key: 'hc:204214',
      name: 'Brandon Sanderson',
      overview: 'Writes long books.',
    });
    expect(result?.books.map((b) => b.title)).toEqual(['The Final Empire']);
  });

  it('finds a book by ISBN', async () => {
    const { client, fake } = makeClient(() =>
      jsonResponse({ data: { editions: [{ isbn_13: '9780765311788', book: BOOK }] } }),
    );
    expect((await client.byIsbn('076531178X'))?.isbn13).toBe('9780765311788');
    expect(bodyOf(fake.calls[0]!.init).variables).toEqual({ isbn: '9780765311788' });
    expect(await client.byIsbn('nope')).toBeUndefined();
  });

  it('returns undefined for unknown ids', async () => {
    const { client } = makeClient(() => jsonResponse({ data: { books: [] } }));
    expect(await client.getBook('123')).toBeUndefined();
    expect(await client.getBook('abc')).toBeUndefined();
  });

  it('maps auth failures, throttling and server errors', async () => {
    const http401 = makeClient(() => jsonResponse({ error: 'bad' }, 401));
    await expect(http401.client.getBook('1')).rejects.toSatisfy((e) => isMetadataError(e, 'unauthorized'));
    const jwt = makeClient(() =>
      jsonResponse({ errors: [{ message: 'Could not verify JWT', extensions: { code: 'invalid-jwt' } }] }),
    );
    await expect(jwt.client.getBook('1')).rejects.toSatisfy((e) => isMetadataError(e, 'unauthorized'));
    let n = 0;
    const flaky = makeClient(() => (n++ === 0 ? jsonResponse({}, 429) : jsonResponse({ data: { books: [BOOK] } })));
    expect((await flaky.client.getBook('1'))?.title).toBe('The Final Empire');
    expect(flaky.fake.calls).toHaveLength(2);
    const throttled = makeClient(() => jsonResponse({}, 429), { maxRetries: 0 });
    await expect(throttled.client.getBook('1')).rejects.toSatisfy((e) => isMetadataError(e, 'rate-limited'));
    const broken = makeClient(() => jsonResponse({}, 502));
    await expect(broken.client.getBook('1')).rejects.toSatisfy((e) => isMetadataError(e, 'bad-response'));
  });
});
