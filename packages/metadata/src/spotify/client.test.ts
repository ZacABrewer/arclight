import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rate-limit.js';
import { createFakeFetch, jsonResponse, type Responder } from '../test-support.js';
import { createInstantClock } from '../music-test-support.js';
import { createSpotifyClient, parseSpotifyPlaylistId } from './client.js';

const ID = '37i9dQZF1DXcBWIGoYBM5M';

function track(n: number, extra: Record<string, unknown> = {}) {
  return {
    track: {
      id: `t${n}`,
      type: 'track',
      name: `Song ${n}`,
      duration_ms: 200_000 + n,
      external_ids: { isrc: `usabc2400${String(n).padStart(3, '0')}` },
      artists: [{ name: 'Example Band' }, { name: 'Guest' }],
      album: { name: 'Example Album', album_type: 'album', release_date: '2024-03-01' },
      ...extra,
    },
  };
}

function makeClient(route: Responder, now = { t: 0 }) {
  const fake = createFakeFetch(route);
  const clock = createInstantClock(0);
  const client = createSpotifyClient({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetchImpl: fake.fetch,
    rateLimiter: new RateLimiter({ clock, random: () => 0 }),
    now: () => new Date(now.t),
    maxRetries: 0,
  });
  return { client, fake };
}

function spotify(opts: { tokens?: string[]; pages?: unknown[][] } = {}): Responder {
  const tokens = [...(opts.tokens ?? ['tok-1'])];
  const pages = opts.pages ?? [[track(1), track(2)]];
  return (url, init) => {
    if (url.hostname === 'accounts.spotify.com') {
      return jsonResponse({ access_token: tokens.shift() ?? 'tok-x', token_type: 'Bearer', expires_in: 3600 });
    }
    const auth = (init?.headers as Record<string, string>)['Authorization'];
    if (auth !== 'Bearer tok-1' && auth !== 'Bearer tok-2') return jsonResponse({ error: { status: 401 } }, 401);
    if (url.pathname === `/v1/playlists/${ID}`) return jsonResponse({ id: ID, name: 'Weekly Mix', description: 'Fresh picks', owner: { display_name: 'someone' } });
    if (url.pathname === `/v1/playlists/${ID}/tracks`) {
      const offset = Number(url.searchParams.get('offset'));
      const index = offset === 0 ? 0 : 1;
      const items = pages[index] ?? [];
      return jsonResponse({ items, next: index < pages.length - 1 ? 'next' : null, total: 3 });
    }
    return jsonResponse({ error: 'nope' }, 404);
  };
}

describe('parseSpotifyPlaylistId', () => {
  it('reads links, URIs and bare ids', () => {
    expect(parseSpotifyPlaylistId(`https://open.spotify.com/playlist/${ID}?si=abc`)).toBe(ID);
    expect(parseSpotifyPlaylistId(`https://open.spotify.com/intl-de/playlist/${ID}`)).toBe(ID);
    expect(parseSpotifyPlaylistId(`spotify:playlist:${ID}`)).toBe(ID);
    expect(parseSpotifyPlaylistId(`spotify:user:someone:playlist:${ID}`)).toBe(ID);
    expect(parseSpotifyPlaylistId(ID)).toBe(ID);
    expect(parseSpotifyPlaylistId('https://example.com/playlist/' + ID)).toBeUndefined();
    expect(parseSpotifyPlaylistId('not a playlist')).toBeUndefined();
  });
});

describe('createSpotifyClient', () => {
  it('needs credentials', () => {
    expect(() => createSpotifyClient({ clientId: '', clientSecret: 'x' })).toThrow(/client id/);
  });

  it('gets a token once, then pages through the playlist', async () => {
    const { client, fake } = makeClient(spotify({ pages: [[track(1), track(2)], [track(3), { track: null }, track(4, { type: 'episode' })]] }));
    const playlist = await client.getPlaylist(`https://open.spotify.com/playlist/${ID}`);
    expect(playlist).toMatchObject({ id: ID, title: 'Weekly Mix', description: 'Fresh picks', owner: 'someone' });
    expect(playlist.tracks.map((t) => t.title)).toEqual(['Song 1', 'Song 2', 'Song 3']);
    expect(playlist.tracks[0]).toEqual({
      title: 'Song 1',
      artist: 'Example Band, Guest',
      album: 'Example Album',
      albumType: 'album',
      releaseDate: '2024-03-01',
      durationMs: 200_001,
      isrc: 'USABC2400001',
      sourceId: 't1',
    });
    const tokenCalls = fake.calls.filter((c) => c.url.hostname === 'accounts.spotify.com');
    expect(tokenCalls).toHaveLength(1);
    expect((tokenCalls[0]!.init?.headers as Record<string, string>)['Authorization']).toBe(`Basic ${btoa('client-id:client-secret')}`);
    expect(tokenCalls[0]!.init?.body).toBe('grant_type=client_credentials');
  });

  it('refreshes an expired token and retries a 401 once', async () => {
    const now = { t: 0 };
    let first = true;
    const base = spotify({ tokens: ['stale', 'tok-2'] });
    const { client, fake } = makeClient((url, init) => {
      if (url.hostname !== 'accounts.spotify.com' && first) {
        first = false;
        return jsonResponse({ error: { status: 401 } }, 401);
      }
      return base(url, init);
    }, now);
    const playlist = await client.getPlaylist(ID);
    expect(playlist.tracks).toHaveLength(2);
    expect(fake.calls.filter((c) => c.url.hostname === 'accounts.spotify.com')).toHaveLength(2);
  });

  it('maps rejected credentials to unauthorized', async () => {
    const { client } = makeClient((url) => (url.hostname === 'accounts.spotify.com' ? jsonResponse({ error: 'invalid_client' }, 400) : jsonResponse({}, 500)));
    await expect(client.getPlaylist(ID)).rejects.toMatchObject({ name: 'MetadataError', code: 'unauthorized' });
  });

  it('rejects input that is not a playlist', async () => {
    const { client, fake } = makeClient(spotify());
    await expect(client.getPlaylist('https://open.spotify.com/album/xyz')).rejects.toMatchObject({ code: 'not-found' });
    expect(fake.calls).toHaveLength(0);
  });
});
