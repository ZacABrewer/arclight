// Post-import refresh against fake Jellyfin/Emby/Plex HTTP servers (real clients, fake fetch).

import { describe, expect, it } from 'vitest';
import type { MediaServerConfig } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { setSection } from '../settings/service.js';
import { libraryKindsFor, MediaServersService } from './service.js';

interface Call {
  host: string;
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

const JELLYFIN_FOLDERS = [
  { Name: 'Movies', ItemId: 'm', CollectionType: 'movies', Locations: ['/data/movies'] },
  { Name: 'Music', ItemId: 'mu', CollectionType: 'music', Locations: ['/data/music'] },
  { Name: 'Audiobooks', ItemId: 'ab', CollectionType: 'books', Locations: ['/data/audiobooks'] },
];
const EMBY_FOLDERS = [{ Name: 'Movies', ItemId: 'm', CollectionType: 'movies', Locations: ['/data/movies'] }];
const PLEX_SECTIONS = {
  MediaContainer: {
    Directory: [
      { key: '1', title: 'Movies', type: 'movie', Location: [{ path: '/data/movies' }] },
      { key: '3', title: 'Music', type: 'artist', Location: [{ path: '/data/music' }] },
      { key: '4', title: 'Spoken', type: 'artist', Location: [{ path: '/data/audiobooks' }] },
    ],
  },
};

function fakeServers() {
  const calls: Call[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call = { host: url.hostname, method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams, body };
    calls.push(call);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (call.host === 'down.lan') return new Response('boom', { status: 500 });
    if (call.path === '/Library/VirtualFolders') return json(call.host === 'emby.lan' ? EMBY_FOLDERS : JELLYFIN_FOLDERS);
    if (call.path === '/Library/Media/Updated' && call.method === 'POST') return new Response(null, { status: 204 });
    if (call.path === '/library/sections') return json(PLEX_SECTIONS);
    if (/^\/library\/sections\/\d+\/refresh$/.test(call.path)) return new Response('', { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls };
}

const server = (id: string, kind: MediaServerConfig['kind'], host: string, o: Partial<MediaServerConfig> = {}): MediaServerConfig => ({
  id,
  kind,
  name: id,
  url: `http://${host}`,
  apiKey: 'key',
  enabled: true,
  usedForAvailability: false,
  usedForRetention: false,
  usedForRefresh: true,
  loginEnabled: false,
  createUsersOnLogin: false,
  ...o,
});

async function build(servers: MediaServerConfig[]) {
  const db = await createTestDb();
  setSection(db, 'mediaServers', { servers });
  const fake = fakeServers();
  return { service: new MediaServersService({ db, fetch: fake.fetch }), calls: fake.calls };
}

describe('MediaServersService.refreshPath', () => {
  it('refreshes the servers whose music libraries contain the path', async () => {
    const { service, calls } = await build([
      server('jf', 'jellyfin', 'jf.lan'),
      server('emby', 'emby', 'emby.lan'),
      server('plex', 'plex', 'plex.lan'),
      server('off', 'jellyfin', 'off.lan', { usedForRefresh: false }),
      server('down', 'jellyfin', 'down.lan'),
    ]);
    const path = '/data/music/Radiohead/OK Computer (1997)';
    const results = await service.refreshPath({ path, mediaType: 'music' });

    expect(results).toEqual([
      { serverId: 'jf', name: 'jf', status: 'refreshed', libraries: ['Music'] },
      { serverId: 'emby', name: 'emby', status: 'skipped', libraries: [], message: `No music library contains ${path}` },
      { serverId: 'plex', name: 'plex', status: 'refreshed', libraries: ['Music'] },
      { serverId: 'down', name: 'down', status: 'failed', libraries: [], message: expect.any(String) },
    ]);
    // Jellyfin: partial refresh of the album folder.
    const jf = calls.find((c) => c.host === 'jf.lan' && c.method === 'POST');
    expect(jf).toMatchObject({ path: '/Library/Media/Updated', body: { Updates: [{ Path: path, UpdateType: 'Modified' }] } });
    // Plex: only the music section, scoped to the path.
    const plex = calls.filter((c) => c.host === 'plex.lan' && c.path.endsWith('/refresh'));
    expect(plex.map((c) => c.path)).toEqual(['/library/sections/3/refresh']);
    expect(plex[0]!.query.get('path')).toBe(path);
    // Emby has no music library: nothing posted; the disabled server is never contacted.
    expect(calls.some((c) => c.host === 'emby.lan' && c.method === 'POST')).toBe(false);
    expect(calls.some((c) => c.host === 'off.lan')).toBe(false);
  });

  it('audiobooks match books libraries, and Plex artist sections by path', async () => {
    const { service, calls } = await build([server('jf', 'jellyfin', 'jf.lan'), server('plex', 'plex', 'plex.lan')]);
    const path = '/data/audiobooks/Brandon Sanderson/Elantris';
    const results = await service.refreshPath({ path, mediaType: 'audiobook', updateType: 'Created' });
    expect(results.map((r) => [r.serverId, r.status, r.libraries])).toEqual([
      ['jf', 'refreshed', ['Audiobooks']],
      ['plex', 'refreshed', ['Spoken']],
    ]);
    expect(calls.find((c) => c.host === 'jf.lan' && c.method === 'POST')!.body).toEqual({ Updates: [{ Path: path, UpdateType: 'Created' }] });
    expect(calls.filter((c) => c.host === 'plex.lan' && c.path.endsWith('/refresh')).map((c) => c.path)).toEqual(['/library/sections/4/refresh']);
  });

  it('a music path outside every music library refreshes nothing', async () => {
    const { service, calls } = await build([server('plex', 'plex', 'plex.lan')]);
    const results = await service.refreshPath({ path: '/data/movies/Film (2020)', mediaType: 'music' });
    expect(results).toMatchObject([{ status: 'skipped' }]);
    expect(calls.some((c) => c.path.endsWith('/refresh'))).toBe(false);
  });

  it('video paths still work', async () => {
    const { service } = await build([server('jf', 'jellyfin', 'jf.lan')]);
    expect(await service.refreshPath({ path: '/data/movies/Film (2020)', mediaType: 'movie' })).toMatchObject([{ status: 'refreshed', libraries: ['Movies'] }]);
  });

  it('library kinds per media type', () => {
    expect(libraryKindsFor('music')).toEqual(['music']);
    expect(libraryKindsFor('audiobook')).toEqual(['audiobook', 'music']);
  });
});
