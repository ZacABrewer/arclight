import { describe, expect, it } from 'vitest';
import { MediaBrowserServerClient, mediaBrowserProviderIds, ticksToMs } from './media-browser.js';
import { fakeServer, fixture } from './test-utils.js';
import { MediaServerError } from './types.js';

const jf = fixture<Record<string, any>>('jellyfin.json'); // eslint-disable-line @typescript-eslint/no-explicit-any -- loose fixture JSON

function client(routes: Record<string, unknown>, kind: 'jellyfin' | 'emby' = 'jellyfin', pageSize?: number) {
  const server = fakeServer(routes);
  const c = new MediaBrowserServerClient({
    kind,
    url: 'http://jf.lan:8096/jellyfin/',
    apiKey: 'secret-key',
    fetch: server.fetch,
    ...(pageSize ? { pageSize } : {}),
  });
  return { c, calls: server.calls };
}

describe('MediaBrowserServerClient (Jellyfin/Emby)', () => {
  it('reads server info and sends the token in every header both servers understand', async () => {
    const { c, calls } = client({ 'GET /jellyfin/System/Info': jf.systemInfo });
    expect(await c.info()).toEqual({ name: 'Basement Jellyfin', version: '10.10.3', id: 'f00dcafe' });
    const h = calls[0]!.headers;
    expect(h['x-emby-token']).toBe('secret-key');
    expect(h['x-mediabrowser-token']).toBe('secret-key');
    expect(h['authorization']).toContain('Token="secret-key"');
    expect(h['x-emby-authorization']).toBe(h['authorization']);
  });

  it('lists virtual folders as typed libraries', async () => {
    const { c } = client({ 'GET /jellyfin/Library/VirtualFolders': jf.virtualFolders });
    const libs = await c.libraries();
    expect(libs.map((l) => [l.id, l.type])).toEqual([
      ['lib-movies', 'movie'],
      ['lib-tv', 'series'],
      ['lib-music', 'other'],
    ]);
    expect(libs[1]!.locations).toEqual(['/data/tv', '/data/anime']);
  });

  it('lists users with admin/disabled flags and drops placeholder activity dates', async () => {
    const { c } = client({ 'GET /jellyfin/Users': jf.users });
    const users = await c.users();
    expect(users).toHaveLength(3);
    expect(users[0]).toEqual({ id: 'u-alice', name: 'alice', isAdmin: true, isDisabled: false, lastActivityAt: '2026-10-20T21:14:05.000Z' });
    expect(users[1]!.lastActivityAt).toBeNull();
    expect(users[2]!.isDisabled).toBe(true);
  });

  it('parses provider ids regardless of key case and ignores junk', () => {
    expect(mediaBrowserProviderIds({ Tmdb: '1', TVDB: 2, imdb: 'TT0001', Other: 'x' })).toEqual({ tmdbId: 1, tvdbId: 2, imdbId: 'tt0001' });
    expect(mediaBrowserProviderIds({ Imdb: 'nope' }).imdbId).toBeNull();
    expect(mediaBrowserProviderIds(null)).toEqual({ tmdbId: null, tvdbId: null, imdbId: null });
  });

  it('converts ticks to milliseconds', () => {
    expect(ticksToMs(72_000_000_000)).toBe(7_200_000);
    expect(ticksToMs(undefined)).toBe(0);
  });

  it('finds an item through AnyProviderIdEquals and verifies the ids', async () => {
    const { c, calls } = client({ 'GET /jellyfin/Items': jf.movies });
    const found = await c.findItems({ mediaType: 'movie', tmdbId: 98765, imdbId: 'tt7654321' });
    expect(found.map((i) => i.id)).toEqual(['m1']);
    expect(found[0]).toMatchObject({ title: 'Harbour Lights', year: 2021, libraryId: 'lib-movies', ids: { tmdbId: 98765, imdbId: 'tt7654321' } });
    expect(calls[0]!.url.searchParams.get('AnyProviderIdEquals')).toBe('Tmdb.98765,Imdb.tt7654321');
  });

  it('falls back to the library index when the server ignores the provider filter', async () => {
    let n = 0;
    const { c, calls } = client({
      'GET /jellyfin/Items': (call: { url: URL }) => {
        n++;
        // First call (filtered) returns nothing useful; the index call returns everything.
        return call.url.searchParams.has('AnyProviderIdEquals') ? { json: { Items: [], TotalRecordCount: 0 } } : { json: jf.movies };
      },
    });
    const found = await c.findItems({ mediaType: 'movie', tmdbId: 555 });
    expect(found.map((i) => i.id)).toEqual(['m2']);
    expect(n).toBe(2);
    // The index is cached for the client's lifetime.
    await c.findItems({ mediaType: 'movie', tmdbId: 98765 });
    expect(calls.filter((x) => !x.url.searchParams.has('AnyProviderIdEquals'))).toHaveLength(1);
  });

  it('returns nothing without any id to look for', async () => {
    const { c, calls } = client({});
    expect(await c.findItems({ mediaType: 'series' })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('pages through listings', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ Id: `m${i}`, Name: `M${i}`, Type: 'Movie', ProviderIds: { Tmdb: String(i + 1) } }));
    const { c, calls } = client(
      {
        'GET /jellyfin/Items': (call: { url: URL }) => {
          const start = Number(call.url.searchParams.get('StartIndex'));
          const limit = Number(call.url.searchParams.get('Limit'));
          return { json: { Items: all.slice(start, start + limit), TotalRecordCount: all.length } };
        },
      },
      'jellyfin',
      2,
    );
    expect((await c.listItems('movie')).map((i) => i.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(calls.map((x) => x.url.searchParams.get('StartIndex'))).toEqual(['0', '2', '4']);
  });

  it('reads a movie play state for one user', async () => {
    const { c, calls } = client({ 'GET /jellyfin/Users/u-alice/Items/m2': jf.userMovies.Items[1] });
    const state = await c.playState({ id: 'm2', mediaType: 'movie' }, 'u-alice');
    expect(state).toEqual({ userId: 'u-alice', played: false, playCount: 0, lastPlayedAt: null, positionMs: 1_800_000, durationMs: 6_000_000 });
    expect(calls[0]!.url.pathname).toBe('/jellyfin/Users/u-alice/Items/m2');
  });

  it('aggregates a series play state from its present episodes', async () => {
    const s1 = jf.userEpisodes.Items.filter((e: { SeriesId: string }) => e.SeriesId === 's1');
    const { c, calls } = client({ 'GET /jellyfin/Users/u-bob/Items': { Items: s1, TotalRecordCount: s1.length } });
    const state = await c.playState({ id: 's1', mediaType: 'series' }, 'u-bob');
    expect(state.played).toBe(true); // the virtual episode is ignored
    expect(state.episodes).toEqual({ total: 2, played: 2 });
    expect(state.playCount).toBe(4);
    expect(state.lastPlayedAt).toBe('2026-10-02T20:00:00.000Z');
    expect(calls[0]!.url.searchParams.get('ParentId')).toBe('s1');
    expect(calls[0]!.url.searchParams.get('IsMissing')).toBe('false');
  });

  it('lists movie play states for a user in one paged call', async () => {
    const { c } = client({ 'GET /jellyfin/Users/u-alice/Items': jf.userMovies });
    const states = await c.listPlayStates('u-alice', 'movie');
    expect(states.map((s) => [s.item.id, s.state.played, s.state.playCount])).toEqual([
      ['m1', true, 2],
      ['m2', false, 0],
    ]);
    expect(states[0]!.state.lastPlayedAt).toBe('2026-09-01T20:00:00.000Z');
  });

  it('lists series play states by grouping episodes per series', async () => {
    const { c } = client({
      'GET /jellyfin/Users/u-alice/Items': (call: { url: URL }) =>
        call.url.searchParams.get('IncludeItemTypes') === 'Series' ? { json: jf.userSeries } : { json: jf.userEpisodes },
    });
    const states = await c.listPlayStates('u-alice', 'series');
    const s1 = states.find((s) => s.item.id === 's1')!;
    const s2 = states.find((s) => s.item.id === 's2')!;
    expect(s1.state).toMatchObject({ played: true, episodes: { total: 2, played: 2 } });
    expect(s2.state).toMatchObject({ played: false, playCount: 1, positionMs: 600_000, episodes: { total: 2, played: 1 } });
    expect(s2.item.ids.tvdbId).toBe(777);
  });

  it('counts a "marked played" item without plays as one play', async () => {
    const { c } = client({ 'GET /jellyfin/Users/u/Items/x': { Id: 'x', Type: 'Movie', UserData: { Played: true, PlayCount: 0 } } });
    expect((await c.playState({ id: 'x', mediaType: 'movie' }, 'u')).playCount).toBe(1);
  });

  it('asks for a partial refresh of a path, or a full refresh without one', async () => {
    const { c, calls } = client({ 'POST /jellyfin/Library/Media/Updated': { body: '' }, 'POST /jellyfin/Library/Refresh': { body: '' } }, 'emby');
    await c.refreshLibrary({ path: '/data/movies/X (2020)', updateType: 'Deleted' });
    await c.refreshLibrary();
    expect(calls[0]!.body).toEqual({ Updates: [{ Path: '/data/movies/X (2020)', UpdateType: 'Deleted' }] });
    expect(calls[1]!.url.pathname).toBe('/jellyfin/Library/Refresh');
  });

  it('maps 401 to an unauthorized MediaServerError without leaking the key', async () => {
    const { c } = client({ 'GET /jellyfin/Users': () => ({ status: 401, body: 'Access token is invalid' }) });
    const err = await c.users().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaServerError);
    expect((err as MediaServerError).code).toBe('unauthorized');
    expect((err as MediaServerError).status).toBe(401);
    expect((err as Error).message).not.toContain('secret-key');
  });

  it('maps transport failures to network errors', async () => {
    const c = new MediaBrowserServerClient({
      kind: 'emby',
      url: 'emby.lan:8096',
      apiKey: 'k',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(c.info()).rejects.toMatchObject({ code: 'network', server: 'emby' });
  });

  it('rejects missing settings up front', () => {
    expect(() => new MediaBrowserServerClient({ kind: 'jellyfin', url: '', apiKey: 'k' })).toThrow(MediaServerError);
    expect(() => new MediaBrowserServerClient({ kind: 'jellyfin', url: 'http://x', apiKey: ' ' })).toThrow(/API key/);
  });

  it('does not cache a failed listing', async () => {
    let fail = true;
    const { c } = client({
      'GET /jellyfin/Items': () => (fail ? { status: 500, body: 'boom' } : { json: jf.movies }),
    });
    await expect(c.listItems('movie')).rejects.toMatchObject({ code: 'remoteError' });
    fail = false;
    expect(await c.listItems('movie')).toHaveLength(2);
  });
});
