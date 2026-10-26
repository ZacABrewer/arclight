import { describe, expect, it } from 'vitest';
import { createMediaServerClient, isMediaServerKind, MediaBrowserServerClient, MediaServerError, PlexServerReadClient } from './index.js';
import { fakeServer } from './test-utils.js';

describe('createMediaServerClient', () => {
  it('builds the right client per kind', () => {
    const jf = createMediaServerClient({ kind: 'jellyfin', url: 'http://jf', apiKey: 'k' });
    const emby = createMediaServerClient({ kind: 'emby', url: 'http://emby', apiKey: 'k' });
    const plex = createMediaServerClient({ kind: 'plex', url: 'http://plex', apiKey: 't' });
    expect(jf).toBeInstanceOf(MediaBrowserServerClient);
    expect(emby.kind).toBe('emby');
    expect(plex).toBeInstanceOf(PlexServerReadClient);
  });

  it('rejects unknown kinds and validates kind strings', () => {
    expect(() => createMediaServerClient({ kind: 'kodi' as never, url: 'http://x', apiKey: 'k' })).toThrow(MediaServerError);
    expect(isMediaServerKind('plex')).toBe(true);
    expect(isMediaServerKind('kodi')).toBe(false);
  });

  it('passes the injected fetch through', async () => {
    const server = fakeServer({ 'GET /System/Info': { ServerName: 'E' } });
    const c = createMediaServerClient({ kind: 'emby', url: 'http://emby.lan', apiKey: 'k', fetch: server.fetch });
    expect((await c.info()).name).toBe('E');
    expect(server.calls).toHaveLength(1);
  });

  it('reports a non-JSON body as a remote error', async () => {
    const server = fakeServer({ 'GET /System/Info': () => ({ body: '<html>proxy login</html>' }) });
    const c = createMediaServerClient({ kind: 'jellyfin', url: 'http://jf.lan', apiKey: 'k', fetch: server.fetch });
    await expect(c.info()).rejects.toMatchObject({ code: 'remoteError' });
  });
});
