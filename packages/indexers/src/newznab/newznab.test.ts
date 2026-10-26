import { describe, expect, it } from 'vitest';
import capsXml from '../../fixtures/newznab-caps.xml?raw';
import searchXml from '../../fixtures/newznab-search.xml?raw';
import { fakeFetch } from '../testing/fake-fetch.js';
import type { IndexerDefinition } from '../types.js';
import { fetchCaps, search } from './index.js';

const def: IndexerDefinition = {
  name: 'Example Usenet',
  baseUrl: 'https://nzb.example.invalid/',
  apiKey: 'usenetkey',
  categories: [2000, 5000],
  animeCategories: [5070],
  protocol: 'usenet',
};

async function results() {
  const caps = await fetchCaps(def, { fetch: fakeFetch({ body: capsXml }).fetch });
  const fake = fakeFetch({ body: searchXml });
  const releases = await search(def, { kind: 'tv', query: 'Show Name', tvdbId: 123456, season: 1, episode: 2 }, caps, {
    fetch: fake.fetch,
  });
  return { releases, fake };
}

describe('newznab', () => {
  it('builds a tvsearch URL against /api with extended=1 and the apikey', async () => {
    const { fake } = await results();
    const url = new URL(fake.calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://nzb.example.invalid/api');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      t: 'tvsearch',
      tvdbid: '123456',
      season: '1',
      ep: '2',
      cat: '5000,5070',
      extended: '1',
      limit: '200',
      apikey: 'usenetkey',
    });
  });

  it('maps a usenet item, preferring usenetdate over pubDate', async () => {
    const { releases } = await results();
    expect(releases[0]).toEqual({
      guid: 'https://nzb.example.invalid/details/aaaa1111',
      title: 'Show.Name.S01E02.720p.HDTV.x264-GROUP',
      size: 734003200,
      publishDate: '2026-10-24T22:45:10.000Z',
      downloadUrl: 'https://nzb.example.invalid/getnzb/aaaa1111.nzb&i=1&r=REDACTED',
      infoUrl: 'https://nzb.example.invalid/details/aaaa1111',
      categories: [5000, 5040],
      indexerName: 'Example Usenet',
      protocol: 'usenet',
      tvdbId: 123456,
      grabs: 1250,
    });
  });

  it('takes size from the enclosure length and normalises bare imdb ids', async () => {
    const { releases } = await results();
    const movie = releases[1];
    expect(movie?.guid).toBe('bbbb2222');
    expect(movie?.size).toBe(9663676416);
    expect(movie?.imdbId).toBe('tt0137523');
    expect(movie?.publishDate).toBe('2026-10-23T08:00:00.000Z');
    expect(movie?.seeders).toBeUndefined();
    expect(movie?.infoHash).toBeUndefined();
  });

  it('skips items whose only enclosure is a torrent', async () => {
    const { releases } = await results();
    expect(releases.map((r) => r.guid)).toEqual(['https://nzb.example.invalid/details/aaaa1111', 'bbbb2222']);
  });

  it('stops paging once newznab:response total is reached', async () => {
    const caps = await fetchCaps(def, { fetch: fakeFetch({ body: capsXml }).fetch });
    const fake = fakeFetch({ body: searchXml });
    await search(def, { kind: 'search', query: 'x' }, { ...caps, limits: { max: 3, default: 3 } }, { fetch: fake.fetch });
    expect(fake.calls).toHaveLength(1);
  });
});
