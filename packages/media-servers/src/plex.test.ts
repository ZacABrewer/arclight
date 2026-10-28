import { describe, expect, it } from 'vitest';
import { pathIsInside, plexProviderIds, PlexServerReadClient } from './plex.js';
import { fakeServer, fixture, type RecordedCall } from './test-utils.js';

const px = fixture<Record<string, any>>('plex.json'); // eslint-disable-line @typescript-eslint/no-explicit-any -- loose fixture JSON

const ROUTES: Record<string, unknown> = {
  'GET /': px.root,
  'GET /library/sections': px.sections,
  'GET /accounts': px.accounts,
  'GET /library/sections/1/all': px.movies,
  'GET /library/sections/2/all': px.shows,
  'GET /status/sessions/history/all': (call: RecordedCall) =>
    call.url.searchParams.get('accountID') === '5' ? { json: px.historyDave } : { json: { MediaContainer: { size: 0 } } },
  'GET /library/metadata/200': { MediaContainer: { Metadata: [px.shows.MediaContainer.Metadata[0]] } },
  'GET /library/metadata/102': { MediaContainer: { Metadata: [px.movies.MediaContainer.Metadata[1]] } },
  'GET /library/sections/1/refresh': { body: '' },
  'GET /library/sections/2/refresh': { body: '' },
};

function client(routes: Record<string, unknown> = ROUTES) {
  const server = fakeServer(routes);
  return { c: new PlexServerReadClient({ url: 'http://plex.lan:32400', token: 'plex-token', fetch: server.fetch }), calls: server.calls };
}

describe('PlexServerReadClient', () => {
  it('reads identity from the root container and sends the Plex headers', async () => {
    const { c, calls } = client();
    expect(await c.info()).toEqual({ name: 'Living Room Plex', version: '1.41.2.9200', id: 'abc123machine' });
    expect(calls[0]!.headers['x-plex-token']).toBe('plex-token');
    expect(calls[0]!.headers['accept']).toBe('application/json');
  });

  it('lists sections as typed libraries', async () => {
    const { c } = client();
    const libs = await c.libraries();
    expect(libs.map((l) => [l.id, l.type, l.locations[0]])).toEqual([
      ['1', 'movie', '/media/movies'],
      ['2', 'series', '/media/tv'],
      ['3', 'music', '/media/music'],
    ]);
  });

  it('lists server accounts, skipping the anonymous placeholder; the owner is admin', async () => {
    const { c } = client();
    expect(await c.users()).toEqual([
      { id: '1', name: 'owner', isAdmin: true, isDisabled: false, lastActivityAt: null },
      { id: '5', name: 'dave', isAdmin: false, isDisabled: false, lastActivityAt: null },
    ]);
  });

  it('reads ids from new-agent Guid arrays and legacy agent guids', () => {
    expect(plexProviderIds({ Guid: [{ id: 'tmdb://1' }, { id: 'tvdb://2' }, { id: 'imdb://tt3' }] })).toEqual({ tmdbId: 1, tvdbId: 2, imdbId: 'tt3' });
    expect(plexProviderIds({ guid: 'com.plexapp.agents.themoviedb://42?lang=en' }).tmdbId).toBe(42);
    expect(plexProviderIds({ guid: 'com.plexapp.agents.thetvdb://99/1/2?lang=en' }).tvdbId).toBe(99);
    expect(plexProviderIds({ guid: 'plex://movie/abc' })).toEqual({ tmdbId: null, tvdbId: null, imdbId: null });
  });

  it('indexes movie sections with guids and file paths', async () => {
    const { c, calls } = client();
    const items = await c.listItems('movie');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: '101', title: 'Harbour Lights', libraryId: '1', ids: { tmdbId: 98765, imdbId: 'tt7654321' } });
    expect(items[0]!.path).toContain('Harbour Lights (2021).mkv');
    const listing = calls.find((x) => x.url.pathname === '/library/sections/1/all')!;
    expect(listing.url.searchParams.get('includeGuids')).toBe('1');
    expect(listing.url.searchParams.get('X-Plex-Container-Start')).toBe('0');
  });

  it('finds items by any provider id from the cached index', async () => {
    const { c, calls } = client();
    expect((await c.findItems({ mediaType: 'movie', imdbId: 'tt0000001' })).map((i) => i.id)).toEqual(['102']);
    expect((await c.findItems({ mediaType: 'series', tvdbId: 424242 })).map((i) => i.id)).toEqual(['200']);
    expect((await c.findItems({ mediaType: 'movie', tmdbId: 98765 })).map((i) => i.id)).toEqual(['101']);
    expect(calls.filter((x) => x.url.pathname === '/library/sections/1/all')).toHaveLength(1);
  });

  it("uses the items' own view state for the owner", async () => {
    const { c } = client();
    const states = await c.listPlayStates('1', 'movie');
    expect(states.map((s) => [s.item.id, s.state.played, s.state.positionMs])).toEqual([
      ['101', true, 0],
      ['102', false, 600_000],
    ]);
    expect(states[0]!.state.lastPlayedAt).toBe(new Date(1759348800 * 1000).toISOString());
    const show = (await c.listPlayStates('1', 'series'))[0]!;
    expect(show.state).toMatchObject({ played: true, playCount: 4, episodes: { total: 3, played: 3 } });
  });

  it("derives other accounts' movie state from their watch history", async () => {
    const { c, calls } = client();
    const states = await c.listPlayStates('5', 'movie');
    const harbour = states.find((s) => s.item.id === '101')!;
    expect(harbour.state).toMatchObject({ userId: '5', played: true, playCount: 1, lastPlayedAt: new Date(1758000000 * 1000).toISOString() });
    expect(states.find((s) => s.item.id === '102')!.state.played).toBe(false);
    const history = calls.find((x) => x.url.pathname === '/status/sessions/history/all')!;
    expect(history.url.searchParams.get('accountID')).toBe('5');
  });

  it('counts a show as played by an account only when every episode is in its history', async () => {
    const { c } = client();
    const show = (await c.listPlayStates('5', 'series'))[0]!;
    // Episodes 201 and 202 watched (201 twice) of leafCount 3.
    expect(show.state).toMatchObject({ played: false, playCount: 3, episodes: { total: 3, played: 2 } });
    expect(show.state.lastPlayedAt).toBe(new Date(1760100000 * 1000).toISOString());
  });

  it('reads a single play state from item metadata (owner) or history (others)', async () => {
    const { c } = client();
    expect((await c.playState({ id: '102', mediaType: 'movie' }, '1')).positionMs).toBe(600_000);
    expect(await c.playState({ id: '200', mediaType: 'series' }, '5')).toMatchObject({ played: false, episodes: { total: 3, played: 2 } });
  });

  it('refreshes only the section that contains the path', async () => {
    const { c, calls } = client();
    await c.refreshLibrary({ path: '/media/tv/Signal Lost (2023)' });
    const refreshes = calls.filter((x) => x.url.pathname.endsWith('/refresh'));
    expect(refreshes.map((x) => x.url.pathname)).toEqual(['/library/sections/2/refresh']);
    expect(refreshes[0]!.url.searchParams.get('path')).toBe('/media/tv/Signal Lost (2023)');
  });

  it('refreshes every video section without a path (or with a path outside them)', async () => {
    const { c, calls } = client();
    await c.refreshLibrary();
    await c.refreshLibrary({ path: '/elsewhere/x', mediaType: 'movie' });
    const refreshes = calls.filter((x) => x.url.pathname.endsWith('/refresh'));
    expect(refreshes.map((x) => x.url.pathname)).toEqual(['/library/sections/1/refresh', '/library/sections/2/refresh', '/library/sections/1/refresh']);
    expect(refreshes[2]!.url.searchParams.has('path')).toBe(false);
  });

  it('compares paths across separators and drive-letter case', () => {
    expect(pathIsInside('D:\\Media\\TV\\Show', 'd:/media/tv')).toBe(true);
    expect(pathIsInside('/media/tvshows/x', '/media/tv')).toBe(false);
    expect(pathIsInside('/media/tv/', '/media/tv')).toBe(true);
  });

  it('maps a bad token to unauthorized', async () => {
    const { c } = client({ 'GET /accounts': () => ({ status: 401, body: '<html>Unauthorized</html>' }) });
    await expect(c.users()).rejects.toMatchObject({ code: 'unauthorized', server: 'plex' });
  });
});
