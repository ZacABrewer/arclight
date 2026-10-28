import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse } from '../test-support.js';
import { MB_IDS, createInstantClock, fanartFixtures } from '../music-test-support.js';
import { createFanartClient } from './index.js';

function makeClient(route: Parameters<typeof createFakeFetch>[0], clientKey?: string) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock();
  const client = createFanartClient({
    apiKey: 'test-project-key',
    ...(clientKey ? { clientKey } : {}),
    fetchImpl: fake.fetch,
    rateLimiter: new RateLimiter({ clock }),
    now: () => new Date(clock.now()),
  });
  return { client, fake };
}

describe('createFanartClient', () => {
  it('requires an API key', () => {
    expect(() => createFanartClient({ apiKey: '' })).toThrow(/API key/);
  });

  it('fetches and maps artist images, most liked first', async () => {
    const { client, fake } = makeClient(() => jsonResponse(fanartFixtures.music), 'personal');
    const images = await client.getArtistImages(MB_IDS.artist);
    const url = fake.calls[0]?.url;
    expect(url?.origin + (url?.pathname ?? '')).toBe(
      `https://webservice.fanart.tv/v3/music/${MB_IDS.artist}`,
    );
    expect(url?.searchParams.get('api_key')).toBe('test-project-key');
    expect(url?.searchParams.get('client_key')).toBe('personal');
    expect(images?.name).toBe('Example Band');
    expect(images?.thumbs.map((t) => [t.id, t.likes])).toEqual([
      ['1002', 7],
      ['1001', 2],
    ]);
    expect(images?.backgrounds).toHaveLength(1);
    // HD logos come before legacy logos regardless of likes.
    expect(images?.logos.map((l) => l.id)).toEqual(['3001', '3101']);
    expect(images?.banners[0]?.likes).toBe(0);
    expect(images?.albums[MB_IDS.releaseGroup]?.covers[0]?.id).toBe('5001');
    expect(images?.albums[MB_IDS.releaseGroup]?.cdArt[0]?.id).toBe('6001');
  });

  it('returns undefined on 404 and for bad ids', async () => {
    const { client, fake } = makeClient(() =>
      jsonResponse({ status: 'error', 'error message': 'Not found' }, 404),
    );
    expect(await client.getArtistImages(MB_IDS.missing)).toBeUndefined();
    expect(await client.getArtistImages('nope')).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it('maps a rejected key to unauthorized', async () => {
    const { client } = makeClient(() => jsonResponse({ status: 'error' }, 401));
    await expect(client.getArtistImages(MB_IDS.artist)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
