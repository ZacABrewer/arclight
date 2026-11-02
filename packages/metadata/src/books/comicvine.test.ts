import { describe, expect, it } from 'vitest';
import { isMetadataError } from '../types.js';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse, type Responder } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import { createComicVineClient, type ComicVineClientOptions } from './comicvine.js';

const VOLUME = {
  id: 91273,
  name: 'Batman',
  start_year: '2016',
  publisher: { name: 'DC Comics' },
  count_of_issues: 3,
  deck: null,
  description: '<p>The <b>Rebirth</b> run.</p>',
  image: { original_url: 'http://comicvine.example.com/batman.jpg' },
  issues: [{ id: 1, name: 'I Am Gotham', issue_number: '1' }],
};

function ok(results: unknown, extra: Record<string, unknown> = {}) {
  return jsonResponse({ status_code: 1, error: 'OK', results, ...extra });
}

function makeClient(route: Responder, extra: Partial<ComicVineClientOptions> = {}) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const limiter = new RateLimiter({ clock, random: () => 0 });
  const client = createComicVineClient({
    apiKey: 'cv-key',
    userAgent: 'ArclightTest/1.0 ( https://example.com )',
    fetchImpl: fake.fetch,
    rateLimiter: limiter,
    now: () => new Date(clock.now()),
    cacheTtlMs: 0,
    ...extra,
  });
  return { client, fake, limiter };
}

describe('ComicVine client', () => {
  it('requires a key and a User-Agent', () => {
    expect(() => createComicVineClient({ apiKey: '', userAgent: 'x' })).toThrow(/API key/);
    expect(() => createComicVineClient({ apiKey: 'k', userAgent: '' })).toThrow(/User-Agent/);
  });

  it('searches volumes with key, format and User-Agent at a conservative rate', async () => {
    const { client, fake, limiter } = makeClient(() => ok([VOLUME, { name: 'no id' }]));
    const results = await client.searchVolumes('batman');
    const url = fake.calls[0]!.url;
    expect(url.origin + url.pathname).toBe('https://comicvine.gamespot.com/api/search/');
    expect(url.searchParams.get('api_key')).toBe('cv-key');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('resources')).toBe('volume');
    expect(url.searchParams.get('query')).toBe('batman');
    expect((fake.calls[0]!.init?.headers as Record<string, string>)['User-Agent']).toMatch(/ArclightTest/);
    expect(limiter.limitOf('comicvine').requestsPerSecond).toBeLessThanOrEqual(1);
    expect(results).toEqual([
      {
        key: 'cv:91273',
        keys: ['cv:91273'],
        title: 'Batman',
        publisher: 'DC Comics',
        startYear: 2016,
        issueCount: 3,
        overview: 'The Rebirth run.',
        coverUrl: 'https://comicvine.example.com/batman.jpg',
        comicVineId: '91273',
        sources: ['comicVine'],
      },
    ]);
  });

  it('gets a volume with its minimal issues', async () => {
    const { client, fake } = makeClient(() => ok(VOLUME));
    const volume = await client.getVolume('cv:91273');
    expect(fake.calls[0]!.url.pathname).toBe('/api/volume/4050-91273/');
    expect(volume?.series.key).toBe('cv:91273');
    expect(volume?.issues).toEqual([
      expect.objectContaining({ key: 'cv-issue:1', issueNumber: '1', title: 'I Am Gotham' }),
    ]);
  });

  it('pages through issues', async () => {
    const page = (offset: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: offset + i + 1,
        issue_number: String(offset + i + 1),
        cover_date: '2016-08-01',
        store_date: '2016-06-15',
        image: { medium_url: `https://comicvine.example.com/${offset + i + 1}.jpg` },
      }));
    const { client, fake } = makeClient((url) => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return ok(page(offset, offset === 0 ? 100 : 20), { number_of_total_results: 120 });
    });
    const issues = await client.listIssues('91273');
    expect(fake.calls).toHaveLength(2);
    const first = fake.calls[0]!.url;
    expect(first.pathname).toBe('/api/issues/');
    expect(first.searchParams.get('filter')).toBe('volume:91273');
    expect(first.searchParams.get('sort')).toBe('issue_number:asc');
    expect(first.searchParams.get('limit')).toBe('100');
    expect(fake.calls[1]!.url.searchParams.get('offset')).toBe('100');
    expect(issues).toHaveLength(120);
    expect(issues[0]).toMatchObject({ key: 'cv-issue:1', coverDate: '2016-08-01', storeDate: '2016-06-15' });
  });

  it('reads status_code errors from the body', async () => {
    const badKey = makeClient(() => jsonResponse({ status_code: 100, error: 'Invalid API Key', results: [] }));
    await expect(badKey.client.searchVolumes('x')).rejects.toSatisfy((e) => isMetadataError(e, 'unauthorized'));
    const http401 = makeClient(() => jsonResponse({ status_code: 100, error: 'Invalid API Key' }, 401));
    await expect(http401.client.searchVolumes('x')).rejects.toSatisfy((e) => isMetadataError(e, 'unauthorized'));
    const missing = makeClient(() => jsonResponse({ status_code: 101, error: 'Object Not Found', results: [] }));
    expect(await missing.client.getVolume('5')).toBeUndefined();
    const http404 = makeClient(() => jsonResponse({ status_code: 101, error: 'Object Not Found' }, 404));
    expect(await http404.client.getVolume('5')).toBeUndefined();
    const limited = makeClient(() => jsonResponse({ status_code: 107, error: 'Rate limit exceeded', results: [] }));
    await expect(limited.client.searchVolumes('x')).rejects.toSatisfy((e) => isMetadataError(e, 'rate-limited'));
  });

  it('retries a 429 and reports 5xx as bad-response', async () => {
    let n = 0;
    const flaky = makeClient(() => (n++ === 0 ? jsonResponse({}, 429) : ok([VOLUME])));
    expect(await flaky.client.searchVolumes('batman')).toHaveLength(1);
    expect(flaky.fake.calls).toHaveLength(2);
    const broken = makeClient(() => jsonResponse({}, 500));
    await expect(broken.client.searchVolumes('x')).rejects.toSatisfy((e) => isMetadataError(e, 'bad-response'));
  });
});
