import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse, type Responder } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import { createDeezerClient, parseDeezerPlaylistId } from './client.js';

function makeClient(route: Responder) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const client = createDeezerClient({ fetchImpl: fake.fetch, rateLimiter: new RateLimiter({ clock, random: () => 0 }), maxRetries: 0 });
  return { client, fake };
}

const t = (n: number, extra: Record<string, unknown> = {}) => ({
  id: 1000 + n,
  type: 'track',
  title: `Track ${n}`,
  duration: 180 + n,
  isrc: n === 2 ? '' : `GBAAA240000${n}`,
  artist: { name: 'Example Artist' },
  album: { title: 'Example Record' },
  ...extra,
});

describe('parseDeezerPlaylistId', () => {
  it('reads links and bare ids', () => {
    expect(parseDeezerPlaylistId('https://www.deezer.com/en/playlist/1234567890')).toBe('1234567890');
    expect(parseDeezerPlaylistId('https://deezer.com/playlist/42?utm=x')).toBe('42');
    expect(parseDeezerPlaylistId('908622995')).toBe('908622995');
    expect(parseDeezerPlaylistId('https://www.deezer.com/en/album/42')).toBeUndefined();
    expect(parseDeezerPlaylistId('https://example.com/playlist/42')).toBeUndefined();
  });
});

describe('createDeezerClient', () => {
  it('reads the playlist and pages through its tracks', async () => {
    const { client, fake } = makeClient((url) => {
      if (url.pathname === '/playlist/42') return jsonResponse({ id: 42, title: 'Road Trip', description: '', creator: { name: 'someone' } });
      if (url.pathname === '/playlist/42/tracks') {
        return url.searchParams.get('index') === '0'
          ? jsonResponse({ data: [t(1), t(2)], total: 3, next: 'https://api.deezer.com/playlist/42/tracks?index=2' })
          : jsonResponse({ data: [t(3), t(4, { title: '' })], total: 3 });
      }
      return jsonResponse({}, 404);
    });
    const playlist = await client.getPlaylist('https://www.deezer.com/fr/playlist/42');
    expect(playlist).toMatchObject({ id: '42', title: 'Road Trip', owner: 'someone' });
    expect(playlist.description).toBeUndefined();
    expect(playlist.tracks).toHaveLength(3);
    expect(playlist.tracks[0]).toEqual({ title: 'Track 1', artist: 'Example Artist', album: 'Example Record', durationMs: 181_000, isrc: 'GBAAA2400001', sourceId: '1001' });
    expect(playlist.tracks[1]!.isrc).toBeUndefined();
    expect(fake.calls[2]!.url.searchParams.get('index')).toBe('2');
  });

  it('maps "no data" (code 800) to not-found', async () => {
    const { client } = makeClient(() => jsonResponse({ error: { type: 'DataException', message: 'no data', code: 800 } }));
    await expect(client.getPlaylist('42')).rejects.toMatchObject({ name: 'MetadataError', code: 'not-found' });
  });

  it('maps the quota error to rate-limited', async () => {
    const { client } = makeClient(() => jsonResponse({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } }));
    await expect(client.getPlaylist('42')).rejects.toMatchObject({ code: 'rate-limited' });
  });
});
