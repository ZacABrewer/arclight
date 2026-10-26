import { describe, expect, it } from 'vitest';
import sections from '../../fixtures/plex-sections.json' with { type: 'json' };
import { GRAB, IMPORT, MEDIA_DELETED, UPGRADE } from '../../fixtures/events.js';
import { createAgent } from '../index.js';
import { fakeFetch, type RecordedCall } from '../test-utils.js';
import { pathIsInside } from './plex.js';

const SETTINGS = { host: 'plex.local', port: 32400, authToken: 'plex-token' };

function plexServer(call: RecordedCall) {
  const url = new URL(call.url);
  if (url.pathname === '/library/sections') return { status: 200, json: sections };
  if (/^\/library\/sections\/\d+\/refresh$/.test(url.pathname)) return { status: 200 };
  if (url.pathname === '/identity') return { status: 200, json: { MediaContainer: { machineIdentifier: 'abc' } } };
  return { status: 404 };
}

describe('pathIsInside', () => {
  it('compares normalised paths including Windows separators and trailing slashes', () => {
    expect(pathIsInside('/tv/Show (2020)', '/tv')).toBe(true);
    expect(pathIsInside('/tv/Show (2020)', '/tv/')).toBe(true);
    expect(pathIsInside('/tv2/Show', '/tv')).toBe(false);
    expect(pathIsInside('D:\\Media\\Anime\\Show', 'd:/media/anime/')).toBe(true);
    expect(pathIsInside('/tv', '/tv')).toBe(true);
  });
});

describe('PlexAgent', () => {
  it('looks up the sections then refreshes the matching movie section by path', async () => {
    const http = fakeFetch(plexServer);
    const agent = createAgent('plex', SETTINGS, { fetch: http.fetch });
    await agent.send(IMPORT);

    expect(http.calls).toHaveLength(2);
    expect(http.calls[0]!).toMatchObject({ url: 'http://plex.local:32400/library/sections', method: 'GET' });
    expect(http.calls[0]!.headers).toMatchObject({ accept: 'application/json', 'x-plex-token': 'plex-token' });
    expect(http.calls[0]!.url).not.toContain('plex-token');

    const refresh = new URL(http.calls[1]!.url);
    expect(refresh.pathname).toBe('/library/sections/1/refresh');
    expect(refresh.searchParams.get('path')).toBe('/movies/Harbour Lights (2021)');
  });

  it('refreshes the TV section for series events and every matching section', async () => {
    const http = fakeFetch(plexServer);
    const agent = createAgent('plex', { ...SETTINGS, useSsl: true }, { fetch: http.fetch });
    await agent.send(UPGRADE);
    await agent.send({ ...MEDIA_DELETED, media: GRAB.media });

    const refreshes = http.calls.filter((c) => c.url.includes('/refresh')).map((c) => new URL(c.url));
    expect(refreshes.map((u) => u.pathname)).toEqual(['/library/sections/1/refresh', '/library/sections/2/refresh']);
    expect(refreshes[0]!.protocol).toBe('https:');
    expect(refreshes[1]!.searchParams.get('path')).toBe('/tv/Signal Lost (2023)');
  });

  it('matches Windows-style section locations', async () => {
    const http = fakeFetch(plexServer);
    const agent = createAgent('plex', SETTINGS, { fetch: http.fetch });
    await agent.send({ ...UPGRADE, media: { ...GRAB.media, path: 'D:\\Media\\Anime\\Some Show' } });
    expect(new URL(http.calls[1]!.url).pathname).toBe('/library/sections/3/refresh');
  });

  it('fails with notFound when no section contains the path, and reports auth errors', async () => {
    const agent = createAgent('plex', SETTINGS, { fetch: fakeFetch(plexServer).fetch });
    await expect(agent.send({ ...IMPORT, media: { ...IMPORT.media, path: '/elsewhere/Film' } })).rejects.toMatchObject({
      agent: 'plex',
      code: 'notFound',
      message: expect.stringContaining('/elsewhere/Film'),
    });

    const denied = createAgent('plex', SETTINGS, { fetch: fakeFetch(() => ({ status: 401, body: '<html>Unauthorized</html>' })).fetch });
    await expect(denied.send(IMPORT)).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('does not refresh for grabs, skips when updates are off, and pings /identity on test()', async () => {
    const http = fakeFetch(plexServer);
    const agent = createAgent('plex', SETTINGS, { fetch: http.fetch });
    expect(agent.supportedEvents.has('grab')).toBe(false);
    await agent.test();
    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0]!.url).pathname).toBe('/identity');

    const quiet = fakeFetch(plexServer);
    await createAgent('plex', { ...SETTINGS, updateLibrary: false }, { fetch: quiet.fetch }).send(IMPORT);
    expect(quiet.calls).toHaveLength(0);
  });
});
