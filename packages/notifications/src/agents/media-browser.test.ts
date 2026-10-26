import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE, IMPORT, MEDIA_DELETED, RENAME, UPGRADE } from '../../fixtures/events.js';
import { createAgent } from '../index.js';
import { fakeFetch } from '../test-utils.js';

const JELLYFIN = { host: 'jellyfin.local', port: 8096, apiKey: 'jfkey' };

describe('MediaBrowserAgent (Jellyfin)', () => {
  it('reports the changed folder after an import with the api key in both auth headers', async () => {
    const http = fakeFetch();
    const agent = createAgent('jellyfin', JELLYFIN, { fetch: http.fetch });
    await agent.send(IMPORT);

    expect(http.calls).toHaveLength(1);
    const call = http.calls[0]!;
    expect(call.url).toBe('http://jellyfin.local:8096/Library/Media/Updated');
    expect(call.method).toBe('POST');
    expect(call.headers['x-mediabrowser-token']).toBe('jfkey');
    expect(call.headers.authorization).toContain('MediaBrowser Token="jfkey"');
    expect(call.json()).toEqual({ Updates: [{ Path: '/movies/Harbour Lights (2021)', UpdateType: 'Modified' }] });
  });

  it('marks deletions, handles upgrades and renames, and honours SSL + URL base', async () => {
    const http = fakeFetch();
    const agent = createAgent('jellyfin', { ...JELLYFIN, useSsl: true, port: 443, urlBase: '/jf/' }, { fetch: http.fetch });
    await agent.send(MEDIA_DELETED);
    await agent.send(UPGRADE);
    await agent.send(RENAME);

    expect(http.calls.map((c) => c.url)).toEqual(Array(3).fill('https://jellyfin.local:443/jf/Library/Media/Updated'));
    expect(http.calls[0]!.json()).toEqual({ Updates: [{ Path: '/movies/Harbour Lights (2021)', UpdateType: 'Deleted' }] });
    expect(http.calls[2]!.json()).toEqual({ Updates: [{ Path: '/tv/Signal Lost (2023)', UpdateType: 'Modified' }] });
  });

  it('falls back to a full refresh when the media has no path, and does nothing when updates are off', async () => {
    const http = fakeFetch();
    const agent = createAgent('jellyfin', JELLYFIN, { fetch: http.fetch });
    await agent.send({ ...IMPORT, media: { ...IMPORT.media, path: '' } });
    expect(http.calls[0]!.url).toBe('http://jellyfin.local:8096/Library/Refresh');

    const quiet = fakeFetch();
    await createAgent('jellyfin', { ...JELLYFIN, updateLibrary: false }, { fetch: quiet.fetch }).send(IMPORT);
    expect(quiet.calls).toHaveLength(0);
  });

  it('does not accept grabs or health events and pings System/Info on test()', async () => {
    const http = fakeFetch(() => ({ status: 200, json: { ServerName: 'jf' } }));
    const agent = createAgent('jellyfin', JELLYFIN, { fetch: http.fetch });
    expect(agent.supportedEvents.has('grab')).toBe(false);
    expect(agent.supportedEvents.has('healthIssue')).toBe(false);
    await expect(agent.send(GRAB)).rejects.toMatchObject({ code: 'unsupportedEvent' });
    await agent.test();
    expect(http.calls[0]).toMatchObject({ url: 'http://jellyfin.local:8096/System/Info', method: 'GET' });
  });

  it('maps a 401 to unauthorized', async () => {
    const agent = createAgent('jellyfin', JELLYFIN, { fetch: fakeFetch(() => ({ status: 401 })).fetch });
    await expect(agent.send(IMPORT)).rejects.toMatchObject({ agent: 'jellyfin', code: 'unauthorized', status: 401 });
  });
});

describe('MediaBrowserAgent (Emby)', () => {
  it('shows an admin notification for grabs and imports when notify is on', async () => {
    const http = fakeFetch();
    const agent = createAgent('emby', { ...JELLYFIN, notify: true }, { fetch: http.fetch });
    expect(agent.kind).toBe('emby');
    expect(agent.supportedEvents.has('grab')).toBe(true);
    expect(agent.supportedEvents.has('healthIssue')).toBe(true);

    await agent.send(GRAB);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe('http://jellyfin.local:8096/Notifications/Admin');
    expect(http.calls[0]!.json()).toMatchObject({ Name: 'Arclight: Episode Grabbed', Description: expect.stringContaining('Quality: WEBDL-1080p') });

    await agent.send(IMPORT);
    expect(http.calls.slice(1).map((c) => c.url)).toEqual([
      'http://jellyfin.local:8096/Notifications/Admin',
      'http://jellyfin.local:8096/Library/Media/Updated',
    ]);

    await agent.send(HEALTH_ISSUE);
    expect(http.calls.at(-1)!.json()).toMatchObject({ Name: 'Arclight: Health Issue: Error' });
  });
});
