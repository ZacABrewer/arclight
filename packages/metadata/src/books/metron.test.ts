import { describe, expect, it } from 'vitest';
import { isMetadataError } from '../types.js';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse, type Responder } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import { createMetronClient, metronAuthorization, type MetronClientOptions } from './metron.js';

const SERIES = {
  id: 2049,
  name: 'Batman',
  year_began: 2016,
  year_end: null,
  publisher: { id: 2, name: 'DC Comics' },
  issue_count: 150,
  desc: 'Rebirth.',
  status: 'Completed',
  cv_id: 91273,
};

function makeClient(route: Responder, extra: Partial<MetronClientOptions> = {}) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const limiter = new RateLimiter({ clock, random: () => 0 });
  const client = createMetronClient({
    username: 'tester',
    password: 'secret',
    fetchImpl: fake.fetch,
    rateLimiter: limiter,
    now: () => new Date(clock.now()),
    cacheTtlMs: 0,
    ...extra,
  });
  return { client, fake, limiter };
}

describe('Metron client', () => {
  it('requires credentials and sends Basic auth at about 20 requests a minute', async () => {
    expect(() => createMetronClient({ username: '', password: 'x' })).toThrow(/username/);
    expect(metronAuthorization('tester', 'secret')).toBe(`Basic ${btoa('tester:secret')}`);
    const { client, fake, limiter } = makeClient(() => jsonResponse(SERIES));
    await client.getSeries('metron:2049');
    expect(fake.calls[0]!.url.toString()).toBe('https://metron.cloud/api/series/2049/');
    expect((fake.calls[0]!.init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa('tester:secret')}`,
    );
    expect(limiter.limitOf('metron').requestsPerSecond * 60).toBeCloseTo(20);
  });

  it('maps a series with cv_id and status', async () => {
    const { client } = makeClient(() => jsonResponse(SERIES));
    expect(await client.getSeries('2049')).toEqual({
      key: 'metron:2049',
      keys: ['metron:2049', 'cv:91273'],
      title: 'Batman',
      publisher: 'DC Comics',
      startYear: 2016,
      issueCount: 150,
      overview: 'Rebirth.',
      comicVineId: '91273',
      metronId: '2049',
      status: 'ended',
      sources: ['metron'],
    });
  });

  it('searches series by name', async () => {
    const { client, fake } = makeClient(() =>
      jsonResponse({
        count: 1,
        next: null,
        results: [{ id: 2049, series: 'Batman (2016)', year_began: 2016, issue_count: 150 }],
      }),
    );
    const results = await client.searchSeries('batman');
    expect(fake.calls[0]!.url.pathname).toBe('/api/series/');
    expect(fake.calls[0]!.url.searchParams.get('name')).toBe('batman');
    expect(results[0]).toMatchObject({ key: 'metron:2049', title: 'Batman', startYear: 2016 });
  });

  it('follows next links for issues, same origin only', async () => {
    const { client, fake } = makeClient((url) => {
      if (url.searchParams.get('page') === '2') {
        return jsonResponse({
          count: 3,
          next: 'https://elsewhere.example.com/api/issue/?page=3',
          results: [{ id: 3, number: '3', cover_date: '2016-09-01', store_date: '2016-07-20' }],
        });
      }
      return jsonResponse({
        count: 3,
        next: 'https://metron.cloud/api/issue/?series_id=2049&page=2',
        results: [
          {
            id: 1,
            number: '1',
            name: ['I Am Gotham, Part One'],
            cover_date: '2016-08-01',
            store_date: '2016-06-15',
            image: 'https://static.example.com/1.jpg',
            cv_id: 501,
          },
          { id: 2, number: '2', cover_date: '2016-08-15', store_date: '2016-07-06' },
        ],
      });
    });
    const issues = await client.listIssues('2049');
    expect(fake.calls.map((c) => c.url.host)).toEqual(['metron.cloud', 'metron.cloud']);
    expect(fake.calls[0]!.url.searchParams.get('series_id')).toBe('2049');
    expect(issues).toHaveLength(3);
    expect(issues[0]).toEqual({
      key: 'metron-issue:1',
      keys: ['metron-issue:1', 'cv-issue:501'],
      issueNumber: '1',
      title: 'I Am Gotham, Part One',
      coverDate: '2016-08-01',
      storeDate: '2016-06-15',
      coverUrl: 'https://static.example.com/1.jpg',
      comicVineId: '501',
      metronId: '1',
      sources: ['metron'],
    });
  });

  it('links a ComicVine volume through cv_id', async () => {
    const { client, fake } = makeClient((url) =>
      url.pathname === '/api/series/'
        ? jsonResponse({ count: 1, next: null, results: [{ id: 2049, series: 'Batman (2016)' }] })
        : jsonResponse(SERIES),
    );
    expect((await client.seriesByComicVineId('cv:91273'))?.metronId).toBe('2049');
    expect(fake.calls[0]!.url.searchParams.get('cv_id')).toBe('91273');
    expect(await client.seriesByComicVineId('11111')).toBeUndefined();
  });

  it('maps errors', async () => {
    const missing = makeClient(() => jsonResponse({ detail: 'Not found.' }, 404));
    expect(await missing.client.getSeries('1')).toBeUndefined();
    const denied = makeClient(() => jsonResponse({ detail: 'Invalid username/password.' }, 401));
    await expect(denied.client.getSeries('1')).rejects.toSatisfy((e) => isMetadataError(e, 'unauthorized'));
    const throttled = makeClient(() => jsonResponse({}, 429), { maxRetries: 1 });
    await expect(throttled.client.getSeries('1')).rejects.toSatisfy((e) => isMetadataError(e, 'rate-limited'));
    expect(throttled.fake.calls).toHaveLength(2);
  });
});
