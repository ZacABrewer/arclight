import { describe, expect, it } from 'vitest';
import emptyRss from '../../fixtures/empty-rss.xml?raw';
import errorAuth from '../../fixtures/error-auth.xml?raw';
import errorLimit from '../../fixtures/error-limit.xml?raw';
import errorMissing from '../../fixtures/error-missing-param.xml?raw';
import errorUnsupported from '../../fixtures/error-unsupported.xml?raw';
import htmlPage from '../../fixtures/html-page.html?raw';
import capsXml from '../../fixtures/torznab-caps.xml?raw';
import searchXml from '../../fixtures/torznab-search.xml?raw';
import { fakeFetch, type FakeReply } from '../testing/fake-fetch.js';
import { IndexerError, type IndexerCapabilities, type IndexerDefinition, type ReleaseInfo } from '../types.js';
import { fetchCaps, search } from './index.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');

const def: IndexerDefinition = {
  name: 'ExampleTracker',
  baseUrl: 'http://jackett:9117/api/v2.0/indexers/exampletracker/results/torznab',
  apiKey: 'jackettkey',
  categories: [2000, 5000],
  protocol: 'torrent',
};

async function loadCaps(): Promise<IndexerCapabilities> {
  return fetchCaps(def, { fetch: fakeFetch({ body: capsXml }).fetch });
}

async function run(reply: FakeReply, overrides: Partial<IndexerDefinition> = {}): Promise<ReleaseInfo[]> {
  const caps = await loadCaps();
  return search({ ...def, ...overrides }, { kind: 'rss' }, caps, {
    fetch: fakeFetch(reply).fetch,
    now: () => NOW,
    indexerId: 7,
  });
}

async function errorOf(promise: Promise<unknown>): Promise<IndexerError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(IndexerError);
    return err as IndexerError;
  }
  throw new Error('expected an IndexerError');
}

describe('torznab caps', () => {
  it('requests t=caps with the apikey in the query only', async () => {
    const fake = fakeFetch({ body: capsXml });
    const caps = await fetchCaps(def, { fetch: fake.fetch });
    expect(caps.limits.max).toBe(100);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe(`${def.baseUrl}/api?t=caps&apikey=jackettkey`);
    const headers = new Headers(call?.init?.headers);
    const headerText: string[] = [];
    headers.forEach((value, key) => headerText.push(`${key}: ${value}`));
    expect(headerText.join('\n')).not.toMatch(/api|jackettkey/i);
  });

  it('turns an HTML caps reply into caps-failed', async () => {
    const err = await errorOf(fetchCaps(def, { fetch: fakeFetch({ body: htmlPage, contentType: 'text/html' }).fetch }));
    expect(err.code).toBe('caps-failed');
  });
});

describe('torznab result parsing', () => {
  it('maps a complete item', async () => {
    const releases = await run({ body: searchXml });
    const r = releases.find((x) => x.guid === 'https://tracker.example.invalid/details/1001');
    expect(r).toEqual({
      guid: 'https://tracker.example.invalid/details/1001',
      title: 'Show.Name.S01E02.1080p.WEB.h264-GROUP',
      size: 1503238553,
      publishDate: '2026-10-24T18:30:00.000Z',
      downloadUrl: 'http://jackett:9117/dl/exampletracker/?jackett_apikey=x&path=abc&file=Show.Name.S01E02',
      infoUrl: 'https://tracker.example.invalid/details/1001',
      infoHash: '0123456789abcdef0123456789abcdef01234567',
      seeders: 42,
      peers: 50,
      leechers: 8,
      categories: [5040, 100002],
      indexerId: 7,
      indexerName: 'ExampleTracker',
      protocol: 'torrent',
      tvdbId: 123456,
      imdbId: 'tt0944947',
      grabs: 311,
      downloadVolumeFactor: 0,
      uploadVolumeFactor: 1,
      minimumRatio: 1,
      minimumSeedTime: 172_800_000,
    });
  });

  it('handles a magnet-only item with seeders + leechers and a numeric timezone', async () => {
    const r = (await run({ body: searchXml })).find((x) => x.guid === 'magnet-only-guid-2002');
    expect(r?.downloadUrl).toMatch(/^magnet:\?xt=urn:btih:89ABCDEF/);
    expect(r?.magnetUrl).toBe(r?.downloadUrl);
    expect(r?.infoHash).toBe('89abcdef0123456789abcdef0123456789abcdef');
    expect(r?.seeders).toBe(10);
    expect(r?.leechers).toBe(3);
    expect(r?.peers).toBe(13);
    expect(r?.size).toBe(25769803776);
    expect(r?.publishDate).toBe('2026-10-23T11:15:00.000Z');
    expect(r?.tmdbId).toBe(550);
    expect(r?.downloadVolumeFactor).toBe(0.5);
    expect(r?.uploadVolumeFactor).toBe(2);
  });

  it('uses the magneturl attr, falls back to now for bad dates and maps tracker categories to parents', async () => {
    const r = (await run({ body: searchXml })).find((x) => x.guid.endsWith('/1003'));
    expect(r?.downloadUrl).toBe('https://tracker.example.invalid/download/1003.torrent');
    expect(r?.magnetUrl).toMatch(/^magnet:/);
    expect(r?.infoHash).toBe('fedcba9876543210fedcba9876543210fedcba98');
    expect(r?.publishDate).toBe(new Date(NOW).toISOString());
    expect(r?.categories).toEqual([100001, 2000]);
    expect(r?.seeders).toBeUndefined();
    expect(r?.leechers).toBeUndefined();
  });

  it('skips zero-size and untitled items', async () => {
    const releases = await run({ body: searchXml });
    expect(releases.map((r) => r.guid)).toEqual([
      'https://tracker.example.invalid/details/1001',
      'magnet-only-guid-2002',
      'https://tracker.example.invalid/details/1003',
      'https://tracker.example.invalid/details/1006',
    ]);
  });

  it('decodes entities and uses the enclosure when there is no link', async () => {
    const r = (await run({ body: searchXml })).find((x) => x.guid.endsWith('/1006'));
    expect(r?.title).toBe('Entity & Title S02 Complete 720p');
    expect(r?.downloadUrl).toBe('https://tracker.example.invalid/download/1006.torrent');
    expect(r?.size).toBe(7516192768);
    expect(r?.publishDate).toBe('2026-10-22T12:00:00.000Z');
    expect([r?.seeders, r?.peers, r?.leechers]).toEqual([0, 0, 0]);
  });

  it('drops releases below minimumSeeders but keeps ones with unknown seeders', async () => {
    const releases = await run({ body: searchXml }, { minimumSeeders: 5 });
    expect(releases.map((r) => r.seeders)).toEqual([42, 10, undefined]);
  });

  it('returns an empty list for an empty feed', async () => {
    expect(await run({ body: emptyRss })).toEqual([]);
  });
});

describe('torznab error handling', () => {
  it('maps <error code=100> to auth', async () => {
    const err = await errorOf(run({ body: errorAuth }));
    expect(err.code).toBe('auth');
    expect(err.indexerCode).toBe(100);
  });

  it('maps request-limit errors and HTTP 429 to rate-limited', async () => {
    expect((await errorOf(run({ body: errorLimit }))).code).toBe('rate-limited');
    expect((await errorOf(run({ status: 429, body: 'Too Many Requests', contentType: 'text/plain' }))).code).toBe('rate-limited');
  });

  it('maps "Missing parameter" without an apikey to auth, with one to bad-response', async () => {
    expect((await errorOf(run({ body: errorMissing }, { apiKey: '' }))).code).toBe('auth');
    expect((await errorOf(run({ body: errorMissing }))).code).toBe('bad-response');
  });

  it('maps function-not-available to unsupported-search', async () => {
    expect((await errorOf(run({ body: errorUnsupported }))).code).toBe('unsupported-search');
  });

  it('rejects HTML pages: bad-response on 200, auth on 403', async () => {
    const ok = await errorOf(run({ body: htmlPage, contentType: 'text/html' }));
    expect(ok.code).toBe('bad-response');
    expect(ok.message).toContain('HTML');
    expect((await errorOf(run({ status: 403, body: htmlPage, contentType: 'text/html' }))).code).toBe('auth');
  });

  it('maps 5xx, network failures and timeouts to unreachable, with the apikey redacted', async () => {
    expect((await errorOf(run({ status: 502, body: 'Bad gateway', contentType: 'text/plain' }))).code).toBe('unreachable');

    const caps = await loadCaps();
    const failing = fakeFetch(() => new TypeError('fetch failed'));
    const err = await errorOf(search(def, { kind: 'rss' }, caps, { fetch: failing.fetch }));
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain('apikey=REDACTED');
    expect(err.message).not.toContain('jackettkey');

    const hanging = fakeFetch(
      (_url) =>
        new Promise<FakeReply>(() => {
          /* never resolves; the timeout must abort */
        }),
    );
    const slowFetch: typeof fetch = (input, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        void hanging.fetch(input, init).then(resolve, reject);
      });
    const timeout = await errorOf(search(def, { kind: 'rss' }, caps, { fetch: slowFetch, timeoutMs: 20 }));
    expect(timeout.code).toBe('unreachable');
    expect(timeout.message).toContain('timed out');
  });

  it('rejects XML that is neither RSS nor an error', async () => {
    expect((await errorOf(run({ body: '<foo><bar/></foo>' }))).code).toBe('bad-response');
  });
});

describe('torznab paging', () => {
  function page(start: number, count: number): string {
    const items = Array.from({ length: count }, (_, i) => {
      const n = start + i;
      return `<item><title>Release ${n}</title><guid>g${n}</guid><link>https://t.invalid/${n}.torrent</link><torznab:attr name="size" value="${1000 + n}"/></item>`;
    }).join('');
    return `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>${items}</channel></rss>`;
  }

  it('pages with limit/offset until a short page', async () => {
    const caps = { ...(await loadCaps()), limits: { max: 3, default: 3 } };
    const fake = fakeFetch((url) => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return { body: page(offset, offset === 0 || offset === 3 ? 3 : 1) };
    });
    const releases = await search(def, { kind: 'search', query: 'release' }, caps, { fetch: fake.fetch });
    expect(releases).toHaveLength(7);
    expect(fake.calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual([null, '3', '6']);
    expect(fake.calls.every((c) => new URL(c.url).searchParams.get('limit') === '3')).toBe(true);
  });

  it('stops when an indexer ignores offset, and honours maxResults', async () => {
    const caps = { ...(await loadCaps()), limits: { max: 2, default: 2 } };
    const repeating = fakeFetch(() => ({ body: page(0, 2) }));
    const releases = await search(def, { kind: 'search', query: 'x' }, caps, { fetch: repeating.fetch });
    expect(releases).toHaveLength(2);
    expect(repeating.calls).toHaveLength(2);

    const endless = fakeFetch((url) => ({ body: page(Number(url.searchParams.get('offset') ?? 0), 2) }));
    const capped = await search(def, { kind: 'search', query: 'x' }, caps, { fetch: endless.fetch, maxResults: 5 });
    expect(capped).toHaveLength(5);
    expect(endless.calls).toHaveLength(3);
  });

  it('fetches a single page for RSS', async () => {
    const caps = { ...(await loadCaps()), limits: { max: 2, default: 2 } };
    const fake = fakeFetch(() => ({ body: page(0, 2) }));
    await search(def, { kind: 'rss' }, caps, { fetch: fake.fetch });
    expect(fake.calls).toHaveLength(1);
  });
});
