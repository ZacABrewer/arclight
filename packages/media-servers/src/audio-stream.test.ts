// Audio streaming for Arclight's player (Jellyfin/Emby engine), against a fake server.

import { describe, expect, it } from 'vitest';
import { MediaBrowserServerClient, mediaBrowserAudioStream } from './media-browser.js';
import { MediaServerError } from './types.js';
import { fakeServer } from './test-utils.js';

describe('mediaBrowserAudioStream', () => {
  it('streams originals as static files', () => {
    expect(mediaBrowserAudioStream('abc', { format: 'original' })).toEqual({ path: 'Audio/abc/stream', query: { static: 'true', mediaSourceId: 'abc' } });
  });

  it('maps transcodes to container, codec, bits per second and ticks', () => {
    const { path, query } = mediaBrowserAudioStream('abc', { format: 'opus', bitrateKbps: 128, startMs: 1500, playSessionId: 'p1' });
    expect(path).toBe('Audio/abc/stream.ogg');
    expect(query).toMatchObject({ static: 'false', container: 'ogg', audioCodec: 'opus', audioBitRate: '128000', startTimeTicks: '15000000', maxAudioChannels: '2', playSessionId: 'p1' });
    expect(mediaBrowserAudioStream('abc', { format: 'aac' }).path).toBe('Audio/abc/stream.aac');
    expect(mediaBrowserAudioStream('abc', { format: 'mp3', startMs: 0 }).query).not.toHaveProperty('startTimeTicks');
  });
});

describe('MediaBrowserServerClient audio', () => {
  it('lists audio paths, narrowed by a search term', async () => {
    const server = fakeServer({
      'GET /Items': (call: { url: URL }) => ({
        json: {
          Items: call.url.searchParams.get('SearchTerm') ? [{ Id: 'a1', Path: '/music/A/01.flac' }] : [{ Id: 'a1', Path: '/music/A/01.flac' }, { Id: 'a2' }],
          TotalRecordCount: 2,
        },
      }),
    });
    const client = new MediaBrowserServerClient({ kind: 'jellyfin', url: 'http://jf.test', apiKey: 'k', fetch: server.fetch });
    expect(await client.audioPaths({ searchTerm: 'Song' })).toEqual([{ id: 'a1', path: '/music/A/01.flac' }]);
    expect(server.calls[0]!.url.searchParams.get('IncludeItemTypes')).toBe('Audio');
    expect(server.calls[0]!.url.searchParams.get('Fields')).toBe('Path');
    expect(await client.audioPaths()).toEqual([{ id: 'a1', path: '/music/A/01.flac' }]);
  });

  it('forwards Range, keeps the key in headers and returns non-2xx responses', async () => {
    const server = fakeServer({}, (call) => (call.url.pathname === '/Audio/a1/stream' ? { status: 416, body: '' } : undefined));
    const client = new MediaBrowserServerClient({ kind: 'jellyfin', url: 'http://jf.test', apiKey: 'secret', fetch: server.fetch });
    const res = await client.audioStream('a1', { format: 'original' }, { range: 'bytes=10-' });
    expect(res.status).toBe(416);
    const call = server.calls[0]!;
    expect(call.headers['range']).toBe('bytes=10-');
    expect(call.headers['x-emby-token']).toBe('secret');
    expect(call.url.search).not.toContain('secret');
  });

  it('throws a network error when the server is unreachable', async () => {
    const client = new MediaBrowserServerClient({
      kind: 'jellyfin',
      url: 'http://jf.test',
      apiKey: 'k',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(client.audioStream('a1', { format: 'original' })).rejects.toMatchObject({ code: 'network' });
    await expect(client.audioStream('a1', { format: 'original' })).rejects.toBeInstanceOf(MediaServerError);
  });
});
