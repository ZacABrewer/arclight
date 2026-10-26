import { describe, expect, it } from 'vitest';
import errorAuth from '../fixtures/error-auth.xml?raw';
import newznabSearch from '../fixtures/newznab-search.xml?raw';
import capsXml from '../fixtures/torznab-caps.xml?raw';
import searchXml from '../fixtures/torznab-search.xml?raw';
import { createIndexer, createRateLimiter, type IndexerDefinition } from './index.js';
import { capsAndSearch, fakeFetch } from './testing/fake-fetch.js';

const def: IndexerDefinition = {
  name: 'ExampleTracker',
  baseUrl: 'http://jackett:9117/api/v2.0/indexers/exampletracker/results/torznab',
  apiKey: 'k',
  categories: [5000],
  protocol: 'torrent',
};

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

describe('createIndexer', () => {
  it('fetches caps once and reuses them across searches', async () => {
    const fake = fakeFetch(capsAndSearch(capsXml, searchXml));
    const indexer = createIndexer(def, { fetch: fake.fetch });
    await indexer.rss();
    await indexer.search({ kind: 'tv', tvdbId: 123456, season: 1 });
    const kinds = fake.calls.map((c) => new URL(c.url).searchParams.get('t'));
    expect(kinds).toEqual(['caps', 'search', 'tvsearch']);
    expect((await indexer.caps()).limits.max).toBe(100);
    expect(fake.calls).toHaveLength(3);
  });

  it('does not remember a failed caps fetch', async () => {
    let fail = true;
    const fake = fakeFetch((url) => {
      if (url.searchParams.get('t') === 'caps') return fail ? { body: errorAuth } : { body: capsXml };
      return { body: searchXml };
    });
    const indexer = createIndexer(def, { fetch: fake.fetch });
    await expect(indexer.caps()).rejects.toMatchObject({ code: 'auth' });
    fail = false;
    await expect(indexer.caps()).resolves.toMatchObject({ limits: { max: 100 } });
  });

  it('spaces requests by rateLimitMs', async () => {
    const clock = fakeClock();
    const fake = fakeFetch(capsAndSearch(capsXml, searchXml));
    const indexer = createIndexer({ ...def, rateLimitMs: 2000 }, { fetch: fake.fetch, now: clock.now, sleep: clock.sleep });
    await indexer.rss(); // caps (no wait) + search (waits 2000)
    clock.advance(500);
    await indexer.rss(); // waits the remaining 1500
    expect(clock.sleeps).toEqual([2000, 1500]);
  });

  it('test() reports success with a release count', async () => {
    const indexer = createIndexer(def, { fetch: fakeFetch(capsAndSearch(capsXml, searchXml)).fetch });
    const result = await indexer.test();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.releaseCount).toBe(4);
  });

  it('test() returns the typed error instead of throwing', async () => {
    const indexer = createIndexer(def, { fetch: fakeFetch({ body: errorAuth }).fetch });
    const result = await indexer.test();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('auth');
  });

  it('uses the Newznab parser for usenet definitions', async () => {
    const indexer = createIndexer(
      { ...def, protocol: 'usenet' },
      { fetch: fakeFetch(capsAndSearch(capsXml, newznabSearch)).fetch },
    );
    const releases = await indexer.rss();
    expect(releases.map((r) => r.protocol)).toEqual(['usenet', 'usenet']);
  });
});

describe('createRateLimiter', () => {
  it('queues concurrent callers one interval apart', async () => {
    const clock = fakeClock();
    const waits: number[] = [];
    const limit = createRateLimiter(1000, clock.now, async (ms) => {
      waits.push(ms);
    });
    await Promise.all([limit(), limit(), limit()]);
    expect(waits).toEqual([1000, 2000]);
  });

  it('is a no-op when the interval is zero', async () => {
    const waits: number[] = [];
    const limit = createRateLimiter(0, () => 0, async (ms) => {
      waits.push(ms);
    });
    await limit();
    await limit();
    expect(waits).toEqual([]);
  });
});
