import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { makeItem, makeRequest, makeTitle, stubApi } from '../features/requests/test-utils.js';
import { ContractError } from './client.js';
import { discoverApi, requestsApi, watchlistApi } from './requests.js';

afterEach(() => vi.unstubAllGlobals());

describe('requests api client', () => {
  it('lists requests with the query string and parses the page', async () => {
    const calls = stubApi({ '/api/v1/request': { pageInfo: { total: 1, take: 20, skip: 0 }, results: [makeRequest()] } });
    const page = await requestsApi.list({ filter: 'pending', mediaType: 'movie', take: 20, skip: 0 });
    expect(page.results[0]?.mediaTitle).toBe('The Matrix');
    expect(calls[0]?.url).toBe('/api/v1/request?filter=pending&mediaType=movie&take=20&skip=0');
  });

  it('tells a created request (201) from an accepted message (202)', async () => {
    let accepted = false;
    stubApi({}, (_url, method) =>
      method === 'POST' ? (accepted ? { status: 202, body: { message: 'Nothing left to request' } } : { status: 201, body: makeRequest({ id: 9 }) }) : undefined,
    );
    expect(await requestsApi.create({ mediaType: 'movie', tmdbId: 603 })).toMatchObject({ kind: 'created', request: { id: 9 } });
    accepted = true;
    expect(await requestsApi.create({ mediaType: 'series', tmdbId: 1, seasons: 'all' })).toEqual({ kind: 'accepted', message: 'Nothing left to request' });
  });

  it('parses a title detail and a discover page; drift raises ContractError', async () => {
    stubApi({
      '/api/v1/discover/tv/1399': makeTitle({ mediaType: 'series', tmdbId: 1399, title: 'Dragons' }),
      '/api/v1/discover/movies': { page: 1, totalPages: 3, totalResults: 60, results: [makeItem({ mediaStatus: 'available' })] },
      '/api/v1/discover/person/5': { tmdbId: 5, name: 'Missing everything else' },
    });
    expect((await discoverApi.title('tv', 1399)).title).toBe('Dragons');
    const page = await discoverApi.movies({ sortBy: 'popularity.desc', page: 1 });
    expect(page.results[0]?.mediaStatus).toBe('available');
    await expect(discoverApi.person(5)).rejects.toBeInstanceOf(ContractError);
  });

  it('sends the bulk ids and the decline reason as JSON bodies', async () => {
    const calls = stubApi({}, (url) =>
      url.includes('/bulk/') ? { body: { ok: [1, 2], failed: [] } } : url.endsWith('/decline') ? { body: makeRequest({ status: 'declined' }) } : undefined,
    );
    expect(await requestsApi.bulkApprove([1, 2])).toEqual({ ok: [1, 2], failed: [] });
    await requestsApi.decline(1, 'Not on any service');
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/api/v1/request/bulk/approve', { ids: [1, 2] }],
      ['POST', '/api/v1/request/1/decline', { reason: 'Not on any service' }],
    ]);
  });

  it('omits userId from the watchlist query when not given', async () => {
    const calls = stubApi({ '/api/v1/watchlist': [] });
    await watchlistApi.list();
    await watchlistApi.list(4).catch(() => undefined);
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/watchlist', '/api/v1/watchlist?userId=4']);
  });
});
