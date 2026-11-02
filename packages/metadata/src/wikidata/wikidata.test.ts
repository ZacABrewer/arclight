import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse } from '../test-support.js';
import { createInstantClock, wikidataFixtures } from '../music-test-support.js';
import {
  commonsThumbnailUrl,
  createWikidataClient,
  findWikidataId,
  wikidataIdFromUrl,
  wikipediaArticleFromUrl,
} from './index.js';

const UA = 'Arclight-test/0.0 ( https://example.invalid/arclight )';
const LINKS = [
  { type: 'official homepage', url: 'https://band.example.invalid/' },
  { type: 'wikidata', url: 'https://www.wikidata.org/wiki/Q44190' },
];

function makeClient(route: Parameters<typeof createFakeFetch>[0]) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock();
  const client = createWikidataClient({
    userAgent: UA,
    fetchImpl: fake.fetch,
    rateLimiter: new RateLimiter({ clock }),
    now: () => new Date(clock.now()),
  });
  return { client, fake, clock };
}

describe('Wikidata helpers', () => {
  it('extracts entity ids from Wikidata URLs', () => {
    expect(wikidataIdFromUrl('https://www.wikidata.org/wiki/Q44190')).toBe('Q44190');
    expect(wikidataIdFromUrl('http://www.wikidata.org/entity/Q1')).toBe('Q1');
    expect(wikidataIdFromUrl('https://m.wikidata.org/wiki/Q42/')).toBe('Q42');
    expect(wikidataIdFromUrl('https://example.invalid/wiki/Q42')).toBeUndefined();
    expect(wikidataIdFromUrl('https://www.wikidata.org/wiki/P18')).toBeUndefined();
    expect(wikidataIdFromUrl('not a url')).toBeUndefined();
    expect(findWikidataId(LINKS)).toBe('Q44190');
    expect(findWikidataId([{ type: 'discogs', url: 'https://www.wikidata.org/wiki/Q5' }])).toBeUndefined();
  });

  it('builds Commons Special:FilePath thumbnails', () => {
    expect(commonsThumbnailUrl('Some band (live) 2020.jpg', 500)).toBe(
      'https://commons.wikimedia.org/wiki/Special:FilePath/Some_band_(live)_2020.jpg?width=500',
    );
  });
});

describe('createWikidataClient', () => {
  it('requires a User-Agent', () => {
    expect(() => createWikidataClient({ userAgent: '' })).toThrow(/User-Agent/);
  });

  it('resolves an artist image from MusicBrainz url-rels', async () => {
    const { client, fake } = makeClient(() => jsonResponse(wikidataFixtures.claims));
    const image = await client.resolveArtistImage(LINKS, { width: 800 });
    const url = fake.calls[0]?.url;
    expect(url?.searchParams.get('action')).toBe('wbgetclaims');
    expect(url?.searchParams.get('entity')).toBe('Q44190');
    expect(url?.searchParams.get('property')).toBe('P18');
    expect((fake.calls[0]?.init?.headers as Record<string, string>)['User-Agent']).toBe(UA);
    expect(image).toEqual({
      wikidataId: 'Q44190',
      fileName: 'RadioheadO2211125 composite.jpg',
      url: 'https://commons.wikimedia.org/wiki/Special:FilePath/RadioheadO2211125_composite.jpg?width=800',
      pageUrl: 'https://commons.wikimedia.org/wiki/File:RadioheadO2211125_composite.jpg',
    });
  });

  it('prefers preferred-rank claims and skips deprecated ones', async () => {
    const claim = (value: string, rank: string) => ({
      rank,
      mainsnak: { snaktype: 'value', datavalue: { value, type: 'string' } },
    });
    const { client } = makeClient(() =>
      jsonResponse({
        claims: {
          P18: [claim('old.jpg', 'deprecated'), claim('normal.jpg', 'normal'), claim('best.jpg', 'preferred')],
        },
      }),
    );
    expect(await client.getImageFileName('Q1')).toBe('best.jpg');
  });

  it('returns undefined without a wikidata link, image, or entity', async () => {
    const { client, fake } = makeClient(() =>
      jsonResponse({ error: { code: 'no-such-entity', info: 'missing' } }),
    );
    expect(await client.resolveArtistImage([{ type: 'discogs', url: 'https://x.invalid' }])).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
    expect(await client.resolveArtistImage(LINKS)).toBeUndefined();
    const { client: empty } = makeClient(() => jsonResponse({ claims: {} }));
    expect(await empty.getImageFileName('Q44190')).toBeUndefined();
  });

  it('caches lookups and is rate limited', async () => {
    const { client, fake } = makeClient(() => jsonResponse(wikidataFixtures.claims));
    await client.getImageFileName('Q44190');
    await client.getImageFileName('Q44190');
    expect(fake.calls).toHaveLength(1);
  });
});

describe('Wikipedia artist summaries', () => {
  const summary = (title: string, extra: Record<string, unknown> = {}) =>
    jsonResponse({ type: 'standard', title, extract: `${title} is an example band.`, content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${title}` } }, ...extra });

  it('parses Wikipedia article URLs', () => {
    expect(wikipediaArticleFromUrl('https://en.wikipedia.org/wiki/Example_Band')).toEqual({ lang: 'en', title: 'Example Band' });
    expect(wikipediaArticleFromUrl('https://de.m.wikipedia.org/wiki/Caf%C3%A9_Band')).toEqual({ lang: 'de', title: 'Café Band' });
    expect(wikipediaArticleFromUrl('https://example.com/wiki/X')).toBeUndefined();
  });

  it('uses a direct wikipedia url-rel first', async () => {
    const { client, fake } = makeClient((url) => summary(decodeURIComponent(url.pathname.split('/').pop() ?? '')));
    const found = await client.resolveArtistSummary!([{ type: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Example_Band' }, ...LINKS]);
    expect(found).toMatchObject({ lang: 'en', text: 'Example_Band is an example band.' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url.pathname).toBe('/api/rest_v1/page/summary/Example_Band');
  });

  it('follows the Wikidata sitelink in the wanted language, falling back to English', async () => {
    const { client, fake } = makeClient((url) => {
      if (url.hostname === 'www.wikidata.org') {
        expect(url.searchParams.get('action')).toBe('wbgetentities');
        expect(url.searchParams.get('sitefilter')).toBe('frwiki|enwiki');
        return jsonResponse({ entities: { Q44190: { sitelinks: { enwiki: { title: 'Example Band' } } } } });
      }
      expect(url.hostname).toBe('en.wikipedia.org');
      return summary('Example Band');
    });
    const found = await client.resolveArtistSummary!(LINKS, { lang: 'fr' });
    expect(found).toMatchObject({ lang: 'en', pageUrl: 'https://en.wikipedia.org/wiki/Example Band' });
    expect(fake.calls).toHaveLength(2);
  });

  it('skips disambiguation pages and answers undefined without links', async () => {
    const { client } = makeClient((url) =>
      url.hostname === 'www.wikidata.org'
        ? jsonResponse({ entities: { Q44190: { sitelinks: { enwiki: { title: 'Example' } } } } })
        : summary('Example', { type: 'disambiguation' }),
    );
    expect(await client.resolveArtistSummary!(LINKS)).toBeUndefined();
    expect(await client.resolveArtistSummary!([{ type: 'discogs', url: 'https://www.discogs.com/artist/1' }])).toBeUndefined();
  });
});
