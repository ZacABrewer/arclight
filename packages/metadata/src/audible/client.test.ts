import { describe, expect, it } from 'vitest';
import { isMetadataError } from '../types.js';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import {
  AUDIOBOOK_IDS,
  TEST_USER_AGENT,
  audibleFixtures,
  audibleRoute,
} from '../audiobook-test-support.js';
import { AUDIBLE_RESPONSE_GROUPS, createAudibleClient, type AudibleClientOptions } from './client.js';
import { isTranslatorCredit } from './map.js';
import { AUDIBLE_REGIONS, audibleApiBaseUrl, isAsin, requireAudibleRegion } from './regions.js';

function makeClient(
  route: Parameters<typeof createFakeFetch>[0] = audibleRoute,
  extra: Partial<AudibleClientOptions> = {},
) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const limiter = new RateLimiter({ clock, random: () => 0 });
  const client = createAudibleClient({
    userAgent: TEST_USER_AGENT,
    fetchImpl: fake.fetch,
    rateLimiter: limiter,
    now: () => new Date(clock.now()),
    ...extra,
  });
  return { client, fake, clock, limiter };
}

describe('Audible regions', () => {
  it('maps every region to its marketplace TLD', () => {
    expect(Object.fromEntries(AUDIBLE_REGIONS.map((r) => [r, audibleApiBaseUrl(r)]))).toEqual({
      us: 'https://api.audible.com',
      uk: 'https://api.audible.co.uk',
      ca: 'https://api.audible.ca',
      au: 'https://api.audible.com.au',
      de: 'https://api.audible.de',
      fr: 'https://api.audible.fr',
      it: 'https://api.audible.it',
      es: 'https://api.audible.es',
      jp: 'https://api.audible.co.jp',
      in: 'https://api.audible.in',
    });
  });

  it('requests the marketplace of the configured region', async () => {
    for (const [region, host] of [
      ['uk', 'api.audible.co.uk'],
      ['jp', 'api.audible.co.jp'],
      ['au', 'api.audible.com.au'],
    ] as const) {
      const { client, fake } = makeClient(audibleRoute, { region });
      expect(client.region).toBe(region);
      await client.searchProducts({ keywords: 'Project Hail Mary' });
      expect(fake.calls[0]?.url.host).toBe(host);
      expect(fake.calls[0]?.url.pathname).toBe('/1.0/catalog/products');
    }
  });

  it('validates regions and ASINs', () => {
    expect(requireAudibleRegion(undefined)).toBe('us');
    expect(requireAudibleRegion('UK')).toBe('uk');
    expect(() => requireAudibleRegion('mx')).toThrow(RangeError);
    expect(isAsin('B08G9PRS1K')).toBe(true);
    expect(isAsin('1799755193')).toBe(true);
    expect(isAsin('B08G9')).toBe(false);
  });
});

describe('Audible search', () => {
  it('asks for the response groups it maps and sends a 0-based page', async () => {
    const { client, fake, limiter } = makeClient();
    const page = await client.searchProducts({
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      pageSize: 10,
    });
    const q = fake.calls[0]?.url.searchParams;
    expect(q?.get('title')).toBe('Project Hail Mary');
    expect(q?.get('author')).toBe('Andy Weir');
    expect(q?.get('num_results')).toBe('10');
    expect(q?.get('page')).toBe('0');
    expect(q?.get('products_sort_by')).toBe('Relevance');
    expect(q?.get('response_groups')?.split(',')).toEqual([...AUDIBLE_RESPONSE_GROUPS]);
    for (const group of ['series', 'contributors', 'product_desc', 'media', 'rating']) {
      expect(q?.get('response_groups')).toContain(group);
    }
    expect((fake.calls[0]?.init?.headers as Record<string, string>)['User-Agent']).toBe(TEST_USER_AGENT);
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 10 });
    expect(page.results.map((p) => p.asin)).toEqual([AUDIOBOOK_IDS.bookAsin, 'B0CTZVXP8H']);
    expect(limiter.limitOf('audible').requestsPerSecond).toBe(2);
  });

  it('maps a product with narrators, runtime, rating, genres and image', async () => {
    const { client } = makeClient();
    const [book] = (await client.searchProducts({ title: 'Project Hail Mary' })).results;
    expect(book).toMatchObject({
      asin: AUDIOBOOK_IDS.bookAsin,
      region: 'us',
      title: 'Project Hail Mary',
      authors: [{ asin: AUDIOBOOK_IDS.authorAsin, name: 'Andy Weir' }],
      narrators: ['Ray Porter'],
      runtimeMinutes: 970,
      formatType: 'unabridged',
      deliveryType: 'MultiPartBook',
      language: 'english',
      releaseDate: '2021-05-04',
      publisher: 'Audible Studios',
      isAdult: false,
    });
    expect(book?.image).toMatch(/_SL500_\.jpg$/);
    expect(book?.images['500']).toBe(book?.image);
    expect(book?.rating?.average).toBeCloseTo(4.87, 2);
    expect(book?.rating?.count).toBeGreaterThan(1000);
    expect(book?.genres.slice(0, 2)).toEqual(['Literature & Fiction', 'Action & Adventure']);
    expect(new Set(book?.genres).size).toBe(book?.genres.length);
    expect(book?.overview).toMatch(/alien microbe/);
    expect(book?.overview).not.toMatch(/<p>/);
  });

  it('maps series with positions', async () => {
    const { client } = makeClient();
    const page = await client.searchProducts({ keywords: 'We Are Legion Bobiverse' });
    const bob = page.results.find((p) => p.asin === AUDIOBOOK_IDS.seriesBookAsin);
    expect(bob?.series).toEqual([
      { asin: AUDIOBOOK_IDS.seriesAsin, name: 'Bobiverse', position: '3', positionNumber: 3 },
    ]);
    expect(bob?.subtitle).toBe('Bobiverse, Book 3');
  });

  it('drops translator credits from the authors', async () => {
    const { client } = makeClient();
    const page = await client.searchProducts({ keywords: 'We Are Legion' });
    const first = page.results.find((p) => p.asin === 'B0GTS2XN16');
    expect(first?.authors.map((a) => a.name)).toEqual(['Dmitry Dornichev', 'Evgeny Fox']);
    expect(isTranslatorCredit('Nenad Savic - traducteur')).toBe(true);
    expect(isTranslatorCredit('Ciaran Patrick Traynor - Translator - translator')).toBe(true);
    expect(isTranslatorCredit('Andy Weir')).toBe(false);
  });

  it('converts later pages to Audible’s 0-based numbering', async () => {
    const { client, fake } = makeClient();
    await client.searchProducts({ keywords: 'x', page: 3, pageSize: 100 });
    expect(fake.calls[0]?.url.searchParams.get('page')).toBe('2');
    expect(fake.calls[0]?.url.searchParams.get('num_results')).toBe('50');
  });

  it('filters podcasts and episodes unless asked to keep them', async () => {
    const podcast = {
      ...audibleFixtures.search.products[0],
      asin: 'B0PODCAST1',
      title: 'Project Hail Mary review',
      content_delivery_type: 'PodcastEpisode',
      content_type: 'Podcast',
    };
    const body = { ...audibleFixtures.search, products: [podcast, ...audibleFixtures.search.products] };
    const { client } = makeClient(() => jsonResponse(body));
    const books = await client.searchProducts({ keywords: 'Project Hail Mary' });
    expect(books.results.map((p) => p.asin)).not.toContain('B0PODCAST1');
    const all = await client.searchProducts({ keywords: 'Project Hail Mary', page: 2 }, { includeNonBooks: true });
    expect(all.results.map((p) => p.asin)).toContain('B0PODCAST1');
  });

  it('tolerates missing and null fields, skipping products without an ASIN or title', async () => {
    const body = {
      products: [
        { asin: 'B0NULLS001', title: 'Sparse', authors: null, narrators: null, series: null, rating: null, product_images: null },
        { asin: null, title: 'No ASIN' },
        { asin: 'B0NOTITLE1' },
      ],
      total_results: null,
    };
    const { client } = makeClient(() => jsonResponse(body));
    const page = await client.searchProducts({ keywords: 'sparse' });
    expect(page.total).toBe(0);
    expect(page.results).toEqual([
      {
        asin: 'B0NULLS001',
        region: 'us',
        title: 'Sparse',
        authors: [],
        narrators: [],
        series: [],
        genres: [],
        images: {},
        isAdult: false,
      },
    ]);
    const { client: empty } = makeClient(() => jsonResponse({}));
    expect((await empty.searchProducts({ keywords: 'x' })).results).toEqual([]);
  });

  it('skips the request when the query is empty', async () => {
    const { client, fake } = makeClient();
    expect((await client.searchProducts({ title: '  ' })).results).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('caches searches (1 day) and spaces requests at 2 per second', async () => {
    const { client, fake, clock } = makeClient(audibleRoute, { cacheTtls: { search: 0 } });
    await client.searchProducts({ keywords: 'Project Hail Mary' });
    await client.searchProducts({ keywords: 'Project Hail Mary' });
    await client.searchProducts({ keywords: 'Project Hail Mary' });
    expect(fake.calls).toHaveLength(3);
    expect(clock.elapsed()).toBe(1000);

    const cached = makeClient();
    await cached.client.searchProducts({ keywords: 'Project Hail Mary' });
    await cached.client.searchProducts({ keywords: 'Project Hail Mary' });
    expect(cached.fake.calls).toHaveLength(1);
  });
});

describe('Audible bibliography', () => {
  it('pages through every result, newest first, keeping the author’s own products', async () => {
    const { client, fake } = makeClient();
    const books = await client.authorBibliography(
      { name: AUDIOBOOK_IDS.authorName, asin: AUDIOBOOK_IDS.authorAsin },
      { pageSize: 10 },
    );
    expect(fake.calls.map((c) => c.url.searchParams.get('page'))).toEqual(['0', '1', '2']);
    expect(fake.calls[0]?.url.searchParams.get('author')).toBe('Andy Weir');
    expect(fake.calls[0]?.url.searchParams.get('products_sort_by')).toBe('-ReleaseDate');
    expect(books).toHaveLength(25);
    expect(new Set(books.map((b) => b.asin)).size).toBe(25);
    expect(books.map((b) => b.asin)).toContain(AUDIOBOOK_IDS.bookAsin);
    // Credited by name only (no ASIN on the credit) still counts.
    expect(books.map((b) => b.asin)).toContain('1799755193');
  });

  it('filters out products credited to another author ASIN', async () => {
    const other = {
      ...audibleFixtures.search,
      total_results: 3,
      products: [
        ...audibleFixtures.search.products,
        { asin: 'B0OTHER001', title: 'Someone else', authors: [{ asin: 'B0NOTWEIR1', name: 'Andy Weir' }] },
      ],
    };
    const { client } = makeClient(() => jsonResponse(other));
    const books = await client.authorBibliography({ name: 'Andy Weir', asin: AUDIOBOOK_IDS.authorAsin });
    expect(books.map((b) => b.asin)).toEqual([AUDIOBOOK_IDS.bookAsin, 'B0CTZVXP8H']);
  });

  it('matches by exact normalised name when only a name is given', async () => {
    const body = {
      total_results: 2,
      products: [
        { asin: 'B0WEIR0001', title: 'One', authors: [{ name: 'Weir, Andy' }] },
        { asin: 'B0BUSH0001', title: 'Two', authors: [{ name: 'Andy Weir bush' }] },
      ],
    };
    const { client, fake } = makeClient(() => jsonResponse(body));
    const books = await client.authorBibliography('Andy Weir');
    expect(books.map((b) => b.asin)).toEqual(['B0WEIR0001']);
    expect(fake.calls).toHaveLength(1);
  });

  it('stops on an empty page even when the total says more', async () => {
    const { client, fake } = makeClient(() => jsonResponse({ total_results: 500, products: [] }));
    expect(await client.authorBibliography('Andy Weir')).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('Audible errors', () => {
  it('backs off on 429 and retries', async () => {
    let attempts = 0;
    const { client, clock } = makeClient((url) => {
      attempts += 1;
      return attempts === 1 ? jsonResponse({}, 429, { 'retry-after': '2' }) : audibleRoute(url);
    });
    const page = await client.searchProducts({ keywords: 'Project Hail Mary' });
    expect(page.results).toHaveLength(2);
    expect(clock.elapsed()).toBe(2000);
  });

  it('maps a persistent 503 to rate-limited and 403 to unauthorized', async () => {
    const { client } = makeClient(() => jsonResponse({ message: 'busy' }, 503), { maxRetries: 1 });
    const err = await client.searchProducts({ keywords: 'x' }).catch((e: unknown) => e);
    expect(isMetadataError(err, 'rate-limited')).toBe(true);
    const { client: denied } = makeClient(() => jsonResponse({ message: 'Forbidden' }, 403));
    await expect(denied.searchProducts({ keywords: 'x' })).rejects.toMatchObject({
      code: 'unauthorized',
      httpStatus: 403,
    });
  });
});

describe('Audible browse', () => {
  it('lists the catalogue by best sellers without search terms', async () => {
    const { client, fake } = makeClient();
    const page = await client.browseProducts({ sort: 'bestsellers', pageSize: 10 });
    const q = fake.calls[0]!.url.searchParams;
    expect(q.get('products_sort_by')).toBe('BestSellers');
    expect(q.get('num_results')).toBe('10');
    expect(q.get('page')).toBe('0');
    expect(q.has('keywords')).toBe(false);
    expect(q.has('title')).toBe(false);
    expect(page.results.map((r) => r.asin)).toContain(AUDIOBOOK_IDS.bookAsin);
  });

  it('lists the newest releases with -ReleaseDate', async () => {
    const { client, fake } = makeClient();
    await client.browseProducts({ sort: 'newest' });
    expect(fake.calls[0]!.url.searchParams.get('products_sort_by')).toBe('-ReleaseDate');
  });
});
