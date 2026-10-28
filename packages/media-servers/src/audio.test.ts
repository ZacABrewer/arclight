// Music and audiobook support across the clients, against fake HTTP servers.

import { describe, expect, it } from 'vitest';
import { createMediaServerClient, idsMatchQuery } from './index.js';
import { MediaBrowserServerClient, mediaBrowserLibraryKind, mediaBrowserProviderIds } from './media-browser.js';
import { plexLibraryKind, plexProviderIds, PlexServerReadClient } from './plex.js';
import { fakeServer, type RecordedCall } from './test-utils.js';

const RG = 'b1392450-e666-3926-a536-22c65f834433';
const ARTIST = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';

describe('library type mapping', () => {
  it('Jellyfin/Emby: music -> music, books -> audiobook', () => {
    expect(mediaBrowserLibraryKind('music')).toBe('music');
    expect(mediaBrowserLibraryKind('books')).toBe('audiobook');
    expect(mediaBrowserLibraryKind('audiobooks')).toBe('audiobook');
    expect(mediaBrowserLibraryKind('movies')).toBe('movie');
    expect(mediaBrowserLibraryKind('tvshows')).toBe('series');
    expect(mediaBrowserLibraryKind('photos')).toBe('other');
    expect(mediaBrowserLibraryKind(null)).toBe('other');
  });

  it('Plex: artist -> music', () => {
    expect(plexLibraryKind('artist')).toBe('music');
    expect(plexLibraryKind('show')).toBe('series');
    expect(plexLibraryKind('photo')).toBe('other');
  });
});

describe('audio provider ids', () => {
  it('reads MusicBrainz, Audible and ISBN ids from MediaBrowser items', () => {
    expect(
      mediaBrowserProviderIds({ MusicBrainzReleaseGroup: RG.toUpperCase(), MusicBrainzAlbumArtist: ARTIST, MusicBrainzArtist: 'ignored', Audible: 'b003zwfo7e', Isbn: '978-0-7653-2635-5' }),
    ).toEqual({ tmdbId: null, tvdbId: null, imdbId: null, mbReleaseGroupId: RG, mbArtistId: ARTIST, asin: 'B003ZWFO7E', isbn: '9780765326355' });
    expect(mediaBrowserProviderIds({ MusicBrainzReleaseGroup: 'nope' })).toEqual({ tmdbId: null, tvdbId: null, imdbId: null });
  });

  it('reads mbid guids from Plex albums and artists', () => {
    expect(plexProviderIds({ type: 'album', Guid: [{ id: `mbid://${RG}` }] }).mbReleaseGroupId).toBe(RG);
    expect(plexProviderIds({ type: 'artist', Guid: [{ id: `mbid://${ARTIST}` }] }).mbArtistId).toBe(ARTIST);
  });

  it('matches queries on audio ids', () => {
    const ids = { tmdbId: null, tvdbId: null, imdbId: null, mbReleaseGroupId: RG, isbn: '9780765326355' };
    expect(idsMatchQuery(ids, { mbReleaseGroupId: RG.toUpperCase() })).toBe(true);
    expect(idsMatchQuery(ids, { isbn: '978-0765326355' })).toBe(true);
    expect(idsMatchQuery(ids, { asin: 'B000000000' })).toBe(false);
  });
});

describe('Jellyfin music and audiobooks', () => {
  const folders = [
    { Name: 'Movies', ItemId: 'm', CollectionType: 'movies', Locations: ['/data/movies'] },
    { Name: 'Music', ItemId: 'mu', CollectionType: 'music', Locations: ['/data/music'] },
    { Name: 'Books', ItemId: 'b', CollectionType: 'books', Locations: ['/data/audiobooks'] },
  ];

  it('lists music libraries, albums by release group and refreshes a music path', async () => {
    const server = fakeServer({
      'GET /Library/VirtualFolders': folders,
      'GET /Items': (call: RecordedCall) => {
        const type = call.url.searchParams.get('IncludeItemTypes');
        if (type === 'MusicAlbum') {
          return {
            json: {
              Items: [{ Id: 'al1', Type: 'MusicAlbum', Name: 'OK Computer', ProductionYear: 1997, ProviderIds: { MusicBrainzReleaseGroup: RG }, Path: '/data/music/Radiohead/OK Computer (1997)' }],
              TotalRecordCount: 1,
            },
          };
        }
        if (type === 'AudioBook') return { json: { Items: [{ Id: 'bk1', Type: 'AudioBook', Name: 'Elantris', ProviderIds: { Audible: 'B002UZMLXM' } }], TotalRecordCount: 1 } };
        return { json: { Items: [], TotalRecordCount: 0 } };
      },
      'POST /Library/Media/Updated': { body: '' },
    });
    const c = new MediaBrowserServerClient({ kind: 'jellyfin', url: 'http://jf.lan:8096', apiKey: 'k', fetch: server.fetch });
    expect((await c.libraries()).map((l) => l.type)).toEqual(['movie', 'music', 'audiobook']);

    const albums = await c.findItems({ mediaType: 'music', mbReleaseGroupId: RG });
    expect(albums).toMatchObject([{ id: 'al1', mediaType: 'music', title: 'OK Computer', ids: { mbReleaseGroupId: RG } }]);
    const find = server.calls.find((x) => x.url.searchParams.get('AnyProviderIdEquals'));
    expect(find!.url.searchParams.get('AnyProviderIdEquals')).toBe(`MusicBrainzReleaseGroup.${RG}`);

    expect(await c.listItems('audiobook')).toMatchObject([{ id: 'bk1', mediaType: 'audiobook', ids: { asin: 'B002UZMLXM' } }]);

    await c.refreshLibrary({ path: '/data/music/Radiohead', mediaType: 'music' });
    const update = server.calls.find((x) => x.method === 'POST');
    expect(update!.body).toEqual({ Updates: [{ Path: '/data/music/Radiohead', UpdateType: 'Modified' }] });
  });
});

describe('Plex music and audiobooks', () => {
  const sections = {
    MediaContainer: {
      Directory: [
        { key: '1', title: 'Movies', type: 'movie', Location: [{ path: '/media/movies' }] },
        { key: '3', title: 'Music', type: 'artist', Location: [{ path: '/media/music' }] },
        { key: '4', title: 'Audiobooks', type: 'artist', Location: [{ path: '/media/audiobooks' }] },
      ],
    },
  };
  const routes = {
    'GET /library/sections': sections,
    'GET /library/sections/3/all': (call: RecordedCall) =>
      call.url.searchParams.get('type') === '9'
        ? { json: { MediaContainer: { size: 1, totalSize: 1, Metadata: [{ ratingKey: '900', type: 'album', title: 'OK Computer', year: 1997, Guid: [{ id: `mbid://${RG}` }] }] } } }
        : { json: { MediaContainer: { size: 0 } } },
    'GET /library/sections/4/all': { MediaContainer: { size: 0 } },
    'GET /library/sections/1/refresh': { body: '' },
    'GET /library/sections/3/refresh': { body: '' },
    'GET /library/sections/4/refresh': { body: '' },
  };

  it('indexes albums of artist sections and finds them by release group', async () => {
    const server = fakeServer(routes);
    const c = new PlexServerReadClient({ url: 'http://plex.lan:32400', token: 't', fetch: server.fetch });
    expect(await c.findItems({ mediaType: 'music', mbReleaseGroupId: RG })).toMatchObject([{ id: '900', mediaType: 'music', libraryId: '3' }]);
  });

  it('refreshes only the music section containing a music path', async () => {
    const server = fakeServer(routes);
    const c = createMediaServerClient({ kind: 'plex', url: 'http://plex.lan:32400', apiKey: 't', fetch: server.fetch });
    await c.refreshLibrary({ path: '/media/music/Radiohead', mediaType: 'music' });
    const refreshes = server.calls.filter((x) => x.url.pathname.endsWith('/refresh'));
    expect(refreshes.map((x) => x.url.pathname)).toEqual(['/library/sections/3/refresh']);
    expect(refreshes[0]!.url.searchParams.get('path')).toBe('/media/music/Radiohead');
  });

  it('audiobooks live in artist sections: the path decides', async () => {
    const server = fakeServer(routes);
    const c = createMediaServerClient({ kind: 'plex', url: 'http://plex.lan:32400', apiKey: 't', fetch: server.fetch });
    await c.refreshLibrary({ path: '/media/audiobooks/Brandon Sanderson', mediaType: 'audiobook' });
    expect(server.calls.filter((x) => x.url.pathname.endsWith('/refresh')).map((x) => x.url.pathname)).toEqual(['/library/sections/4/refresh']);
  });

  it('a video refresh without a type never touches music sections', async () => {
    const server = fakeServer(routes);
    const c = createMediaServerClient({ kind: 'plex', url: 'http://plex.lan:32400', apiKey: 't', fetch: server.fetch });
    await c.refreshLibrary();
    expect(server.calls.filter((x) => x.url.pathname.endsWith('/refresh')).map((x) => x.url.pathname)).toEqual(['/library/sections/1/refresh']);
  });
});
