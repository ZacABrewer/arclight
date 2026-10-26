import { describe, expect, it } from 'vitest';
import { MediaBrowserClient, PlexServerClient, PlexTvClient, idsMatch, plexGuidIds, providerIdsOf } from './media-server.js';
import { NotificationError } from './types.js';

// Hand-written fake servers: a router over (method, path) returning JSON fixtures.

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

type Route = (call: Call) => { status?: number; json?: unknown } | undefined;

function fakeServer(route: Route) {
  const calls: Call[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const out = route(call) ?? { status: 404, json: { error: 'no route' } };
    return new Response(JSON.stringify(out.json ?? {}), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

describe('MediaBrowserClient (Jellyfin/Emby)', () => {
  it('signs in by name with a MediaBrowser authorization header and returns the account and token', async () => {
    const srv = fakeServer((c) =>
      c.method === 'POST' && c.url.pathname === '/jf/Users/AuthenticateByName'
        ? { json: { AccessToken: 'tok', User: { Id: 'u1', Name: 'alice', Policy: { IsAdministrator: true, IsDisabled: false } } } }
        : undefined,
    );
    const client = new MediaBrowserClient({ kind: 'jellyfin', url: 'http://jf.lan:8096/jf/', fetch: srv.fetch });
    const out = await client.authenticateByName('alice', 'pw', 'dev-1');
    expect(out).toEqual({ accessToken: 'tok', account: { id: 'u1', username: 'alice', isAdmin: true, isDisabled: false } });
    const call = srv.calls[0]!;
    expect(JSON.parse(call.body!)).toEqual({ Username: 'alice', Pw: 'pw' });
    expect(call.headers['Authorization']).toContain('DeviceId="dev-1"');
    expect(call.headers['X-Emby-Authorization']).toBe(call.headers['Authorization']);
    expect(call.headers['X-Emby-Token']).toBeUndefined();
  });

  it('maps a rejected sign-in to an unauthorized NotificationError', async () => {
    const srv = fakeServer(() => ({ status: 401, json: {} }));
    const client = new MediaBrowserClient({ kind: 'emby', url: 'http://emby', fetch: srv.fetch });
    await expect(client.authenticateByName('a', 'b', 'd')).rejects.toMatchObject({ code: 'unauthorized', agent: 'emby' });
  });

  it('lists users with admin/disabled flags using the API key', async () => {
    const srv = fakeServer((c) =>
      c.url.pathname === '/Users'
        ? {
            json: [
              { Id: 'a', Name: 'admin', Policy: { IsAdministrator: true } },
              { Id: 'b', Name: 'kid', Policy: { IsDisabled: true } },
              { Name: 'no id' },
            ],
          }
        : undefined,
    );
    const users = await new MediaBrowserClient({ kind: 'jellyfin', url: 'http://jf', apiKey: 'key', fetch: srv.fetch }).users();
    expect(users).toEqual([
      { id: 'a', username: 'admin', isAdmin: true, isDisabled: false },
      { id: 'b', username: 'kid', isAdmin: false, isDisabled: true },
    ]);
    expect(srv.calls[0]!.headers['X-Emby-Token']).toBe('key');
  });

  it('refuses admin calls without an API key', async () => {
    const client = new MediaBrowserClient({ kind: 'jellyfin', url: 'http://jf', fetch: fakeServer(() => undefined).fetch });
    await expect(client.users()).rejects.toBeInstanceOf(NotificationError);
  });

  it('pages favourites and maps provider ids, skipping non movie/series items', async () => {
    const page = (start: number) =>
      start === 0
        ? Array.from({ length: 200 }, (_, i) => ({ Id: `m${i}`, Name: `Movie ${i}`, Type: 'Movie', ProductionYear: 2000, ProviderIds: { Tmdb: String(i + 1) } }))
        : [
            { Id: 's1', Name: 'Show', Type: 'Series', ProviderIds: { tvdb: '81189', IMDB: 'tt0903747' } },
            { Id: 'e1', Name: 'Episode', Type: 'Episode' },
          ];
    const srv = fakeServer((c) => {
      if (c.url.pathname !== '/Users/u1/Items') return undefined;
      expect(c.url.searchParams.get('Filters')).toBe('IsFavorite');
      const start = Number(c.url.searchParams.get('StartIndex'));
      return { json: { Items: page(start), TotalRecordCount: 202 } };
    });
    const items = await new MediaBrowserClient({ kind: 'jellyfin', url: 'http://jf', apiKey: 'key', fetch: srv.fetch }).favorites('u1', 'user-token');
    expect(items).toHaveLength(201);
    expect(items[0]).toEqual({ id: 'm0', mediaType: 'movie', title: 'Movie 0', year: 2000, ids: { tmdbId: 1, tvdbId: null, imdbId: null } });
    expect(items[200]).toMatchObject({ mediaType: 'series', ids: { tmdbId: null, tvdbId: 81189, imdbId: 'tt0903747' } });
    expect(srv.calls.every((c) => c.headers['X-Emby-Token'] === 'user-token')).toBe(true);
  });

  it('finds a series by provider id and counts present episodes per season', async () => {
    const srv = fakeServer((c) => {
      if (c.url.pathname !== '/Items') return undefined;
      if (c.url.searchParams.get('IncludeItemTypes') === 'Series') {
        expect(c.url.searchParams.get('AnyProviderIdEquals')).toBe('Tmdb.1399,Tvdb.121361');
        return { json: { Items: [{ Id: 'other', Name: 'Other', Type: 'Series', ProviderIds: { Tmdb: '5' } }, { Id: 'got', Name: 'Thrones', Type: 'Series', ProviderIds: { Tvdb: '121361' } }] } };
      }
      expect(c.url.searchParams.get('ParentId')).toBe('got');
      return {
        json: {
          Items: [
            { ParentIndexNumber: 1, IndexNumber: 1 },
            { ParentIndexNumber: 1, IndexNumber: 2, IndexNumberEnd: 3 },
            { ParentIndexNumber: 2, IndexNumber: 1 },
            { ParentIndexNumber: 2, IndexNumber: 2, LocationType: 'Virtual' },
          ],
        },
      };
    });
    const match = await new MediaBrowserClient({ kind: 'emby', url: 'http://emby', apiKey: 'k', fetch: srv.fetch }).findByIds('series', 1399, 121361);
    expect(match?.item).toMatchObject({ id: 'got', title: 'Thrones' });
    expect(match?.seasons).toEqual([
      { seasonNumber: 1, episodes: 3 },
      { seasonNumber: 2, episodes: 1 },
    ]);
  });

  it('returns null when no item carries the asked id (server ignored the filter)', async () => {
    const srv = fakeServer(() => ({ json: { Items: [{ Id: 'x', Name: 'X', Type: 'Movie', ProviderIds: { Tmdb: '1' } }] } }));
    expect(await new MediaBrowserClient({ kind: 'jellyfin', url: 'http://jf', apiKey: 'k', fetch: srv.fetch }).findByIds('movie', 603)).toBeNull();
  });

  it('reads server info', async () => {
    const srv = fakeServer((c) => (c.url.pathname === '/System/Info' ? { json: { ServerName: 'Den', Version: '10.10.3', Id: 'abc' } } : undefined));
    expect(await new MediaBrowserClient({ kind: 'jellyfin', url: 'http://jf', apiKey: 'k', fetch: srv.fetch }).info()).toEqual({ name: 'Den', version: '10.10.3', id: 'abc' });
  });
});

describe('provider id helpers', () => {
  it('reads provider ids regardless of key case and matches by tmdb or tvdb', () => {
    const ids = providerIdsOf({ TMDB: '603', Tvdb: 99, Imdb: 'tt0133093', Other: 'x' });
    expect(ids).toEqual({ tmdbId: 603, tvdbId: 99, imdbId: 'tt0133093' });
    expect(idsMatch(ids, 603)).toBe(true);
    expect(idsMatch({ tmdbId: null, tvdbId: 99, imdbId: null }, 1, 99)).toBe(true);
    expect(idsMatch({ tmdbId: null, tvdbId: 99, imdbId: null }, 1)).toBe(false);
  });

  it('parses Plex guids from the new agent list and legacy agents', () => {
    expect(plexGuidIds({ Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://603' }, { id: 'tvdb://169' }] })).toEqual({ tmdbId: 603, tvdbId: 169, imdbId: 'tt0133093' });
    expect(plexGuidIds({ guid: 'com.plexapp.agents.themoviedb://603?lang=en' }).tmdbId).toBe(603);
    expect(plexGuidIds({ guid: 'com.plexapp.agents.thetvdb://121361/1/1?lang=en' }).tvdbId).toBe(121361);
    expect(plexGuidIds({ guid: 'com.plexapp.agents.imdb://tt0133093?lang=en' }).imdbId).toBe('tt0133093');
    expect(plexGuidIds({ guid: 'plex://movie/5d776' })).toEqual({ tmdbId: null, tvdbId: null, imdbId: null });
  });
});

describe('PlexServerClient', () => {
  it('indexes movie and show libraries page by page with the owner token', async () => {
    const srv = fakeServer((c) => {
      expect(c.headers['X-Plex-Token']).toBe('owner');
      if (c.url.pathname === '/library/sections') {
        return { json: { MediaContainer: { Directory: [{ key: '1', type: 'movie' }, { key: '2', type: 'show' }, { key: '3', type: 'artist' }] } } };
      }
      if (c.url.pathname === '/library/sections/1/all') {
        const start = Number(c.url.searchParams.get('X-Plex-Container-Start'));
        const rows = start === 0 ? Array.from({ length: 500 }, (_, i) => ({ ratingKey: `${i}`, title: `M${i}`, Guid: [{ id: `tmdb://${i + 1}` }] })) : [{ ratingKey: 'last', title: 'Last', guid: 'com.plexapp.agents.themoviedb://9999' }];
        return { json: { MediaContainer: { totalSize: 501, Metadata: rows } } };
      }
      if (c.url.pathname === '/library/sections/2/all') return { json: { MediaContainer: { Metadata: [{ ratingKey: 7700, title: 'Thrones', Guid: [{ id: 'tvdb://121361' }] }] } } };
      return undefined;
    });
    const items = await new PlexServerClient({ url: 'http://plex:32400', token: 'owner', fetch: srv.fetch }).libraryItems();
    expect(items).toHaveLength(502);
    expect(items.find((i) => i.ratingKey === 'last')?.ids.tmdbId).toBe(9999);
    expect(items.find((i) => i.ratingKey === '7700')).toMatchObject({ mediaType: 'series', ids: { tvdbId: 121361 } });
    expect(srv.calls.some((c) => c.url.pathname.includes('/sections/3/'))).toBe(false);
  });

  it('reports seasons with their present episode count and the server identity', async () => {
    const srv = fakeServer((c) => {
      if (c.url.pathname === '/library/metadata/77/children') return { json: { MediaContainer: { Metadata: [{ index: 2, leafCount: 3 }, { index: 1, leafCount: 10 }, { title: 'All episodes' }] } } };
      if (c.url.pathname === '/identity') return { json: { MediaContainer: { machineIdentifier: 'mach', version: '1.40' } } };
      return undefined;
    });
    const client = new PlexServerClient({ url: 'http://plex:32400/', token: 't', fetch: srv.fetch });
    expect(await client.seasonPresence('77')).toEqual([
      { seasonNumber: 1, episodes: 10 },
      { seasonNumber: 2, episodes: 3 },
    ]);
    expect(await client.info()).toEqual({ name: 'Plex', version: '1.40', id: 'mach' });
  });
});

describe('PlexTvClient', () => {
  it('creates a strong PIN with an app.plex.tv auth URL and polls it', async () => {
    let approved = false;
    const srv = fakeServer((c) => {
      if (c.method === 'POST' && c.url.pathname === '/api/v2/pins') {
        expect(c.url.searchParams.get('strong')).toBe('true');
        return { json: { id: 42, code: 'abcd' } };
      }
      if (c.url.pathname === '/api/v2/pins/42') return { json: { id: 42, authToken: approved ? 'user-token' : null } };
      return undefined;
    });
    const tv = new PlexTvClient({ fetch: srv.fetch, baseUrl: 'http://plextv' });
    const pin = await tv.createPin();
    expect(pin.id).toBe(42);
    expect(pin.authUrl).toContain('https://app.plex.tv/auth#?');
    expect(pin.authUrl).toContain('code=abcd');
    expect(pin.authUrl).toContain('clientID=arclight');
    expect(await tv.checkPin(42)).toBeNull();
    approved = true;
    expect(await tv.checkPin(42)).toBe('user-token');
    expect(srv.calls.every((c) => c.headers['X-Plex-Client-Identifier'] === 'arclight')).toBe(true);
  });

  it('reads the account, reachable servers and friends', async () => {
    const srv = fakeServer((c) => {
      if (c.url.pathname === '/api/v2/user') return { json: { id: 7, username: 'bob', email: 'Bob@x.io', thumb: 'https://plex.tv/users/7/avatar' } };
      if (c.url.pathname === '/api/v2/resources') return { json: [{ clientIdentifier: 'mach', provides: 'server' }, { clientIdentifier: 'phone', provides: 'client,player' }] };
      if (c.url.pathname === '/api/v2/friends') return { json: [{ id: 8, username: 'carol', email: 'c@x.io' }, { title: 'no id' }] };
      return undefined;
    });
    const tv = new PlexTvClient({ fetch: srv.fetch, baseUrl: 'http://plextv' });
    expect(await tv.account('t')).toEqual({ id: '7', username: 'bob', email: 'Bob@x.io', thumb: 'https://plex.tv/users/7/avatar', isAdmin: false, isDisabled: false });
    expect(await tv.serverIds('t')).toEqual(['mach']);
    expect(await tv.friends('owner')).toEqual([{ id: '8', username: 'carol', email: 'c@x.io', isAdmin: false, isDisabled: false }]);
  });
});
