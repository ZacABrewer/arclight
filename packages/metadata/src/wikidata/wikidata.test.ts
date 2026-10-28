import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse } from '../test-support.js';
import { createInstantClock, wikidataFixtures } from '../music-test-support.js';
import {
  commonsThumbnailUrl,
  createWikidataClient,
  findWikidataId,
  wikidataIdFromUrl,
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
