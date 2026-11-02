import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LocalTrack } from './map.js';
import { jellyfinPusher, plexPusher, subsonicPusher } from './targets.js';

// The media-server pushers against small in-memory fakes of each API (no network).

const REC_A = '4a7fea2e-545b-4c63-bc9a-9943cc3a29d7';
const items: LocalTrack[] = [
  { path: '/data/music/Example Band/Example Album (2024)/01 - First.flac', recordingMbid: REC_A, title: 'First', artist: 'Example Band', durationMs: 200_000 },
  { path: '/data/music/Example Band/Example Album (2024)/02 - Second.flac', title: 'Second', artist: 'Example Band', durationMs: 180_000 },
  { path: '/data/music/Example Band/Example Album (2024)/03 - Third.flac', title: 'Third', artist: 'Example Band', durationMs: 150_000 },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recorder(route: (method: string, url: URL, body: string) => Response | Promise<Response>) {
  const calls: Array<{ method: string; url: URL; body: string }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ method, url, body });
    return route(method, url, body);
  };
  return { calls, fetchImpl };
}

describe('jellyfinPusher', () => {
  it('creates a playlist from matched items and reports the rest as missing', async () => {
    const { calls, fetchImpl } = recorder((method, url) => {
      if (url.pathname === '/jf/Users') return json([{ Id: 'viewer' }, { Id: 'admin', Policy: { IsAdministrator: true } }]);
      if (url.pathname === '/jf/Users/admin/Items') {
        return json({ Items: [{ Id: 'a', Name: 'First', ProviderIds: { MusicBrainzRecording: REC_A } }, { Id: 'b', Name: 'Second', Artists: ['Example Band'], RunTimeTicks: 1_800_000_000 }], TotalRecordCount: 2 });
      }
      if (url.pathname === '/jf/Playlists' && method === 'POST') return json({ Id: 'new' });
      return json({}, 404);
    });
    const r = await jellyfinPusher({ url: 'http://jf.example.com/jf/', apiKey: 'k', label: 'JF', fetchImpl }).push('Mix', items);
    expect(r).toEqual({ remoteId: 'new', pushed: 2, missing: 1 });
    const create = calls.find((c) => c.method === 'POST')!;
    expect(create.url.searchParams.get('Ids')).toBe('a,b');
    expect(create.url.searchParams.get('UserId')).toBe('admin');
  });

  it('recreates a playlist deleted on the server', async () => {
    const { calls, fetchImpl } = recorder((method, url) => {
      if (url.pathname === '/Users') return json([{ Id: 'u' }]);
      if (url.pathname === '/Users/u/Items') return json({ Items: [], TotalRecordCount: 0 });
      if (url.pathname === '/Playlists/old/Items') return json({}, 404);
      if (url.pathname === '/Playlists' && method === 'POST') return json({ Id: 'again' });
      return json({}, 404);
    });
    const r = await jellyfinPusher({ url: 'http://jf.example.com', apiKey: 'k', label: 'JF', fetchImpl }).push('Mix', items, 'old');
    expect(r.remoteId).toBe('again');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('plexPusher', () => {
  it('reads music sections, creates the playlist with a server uri and appends the rest', async () => {
    const metadata = Array.from({ length: 102 }, (_, i) => ({ ratingKey: String(500 + i), title: `T${i}`, grandparentTitle: 'Example Band', Media: [{ Part: [{ file: `/media/Example Band/Example Album (2024)/${i}.flac` }] }] }));
    metadata[0] = { ratingKey: '1', title: 'First', grandparentTitle: 'Example Band', Guid: [{ id: `mbid://${REC_A}` }] } as never;
    metadata[1] = { ratingKey: '2', title: 'x', grandparentTitle: 'x', Media: [{ Part: [{ file: '/media/Example Band/Example Album (2024)/02 - Second.flac' }] }] };
    const many: LocalTrack[] = [items[0]!, items[1]!, ...metadata.slice(2).map((m, i) => ({ path: `/data/music/Example Band/Example Album (2024)/${i + 2}.flac`, title: m.title!, artist: 'Example Band' }))];
    const { calls, fetchImpl } = recorder((method, url) => {
      if (url.pathname === '/identity') return json({ MediaContainer: { machineIdentifier: 'abc' } });
      if (url.pathname === '/library/sections') return json({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }, { key: '3', type: 'artist' }] } });
      if (url.pathname === '/library/sections/3/all') return json({ MediaContainer: { Metadata: metadata } });
      if (url.pathname === '/playlists' && method === 'POST') return json({ MediaContainer: { Metadata: [{ ratingKey: '900' }] } });
      if (url.pathname === '/playlists/900/items' && method === 'PUT') return json({});
      return json({}, 404);
    });
    const r = await plexPusher({ url: 'http://plex.example.com:32400', token: 't', label: 'Plex', fetchImpl }).push('Mix', many);
    expect(r).toEqual({ remoteId: '900', pushed: 102, missing: 0 });
    const create = calls.find((c) => c.method === 'POST')!;
    expect(create.url.searchParams.get('uri')).toMatch(/^server:\/\/abc\/com\.plexapp\.plugins\.library\/library\/metadata\/1,2,/);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(calls.some((c) => c.url.pathname === '/library/sections/1/all')).toBe(false);
  });

  it('clears an existing playlist before adding', async () => {
    const { calls, fetchImpl } = recorder((method, url) => {
      if (url.pathname === '/identity') return json({ MediaContainer: { machineIdentifier: 'abc' } });
      if (url.pathname === '/library/sections') return json({ MediaContainer: { Directory: [{ key: '3', type: 'artist' }] } });
      if (url.pathname === '/library/sections/3/all') return json({ MediaContainer: { Metadata: [{ ratingKey: '1', Guid: [{ id: `mbid://${REC_A}` }] }] } });
      if (url.pathname === '/playlists/900/items') return json({});
      return json({}, 404);
    });
    const r = await plexPusher({ url: 'http://plex.example.com', token: 't', label: 'Plex', fetchImpl }).push('Mix', items, '900');
    expect(r).toMatchObject({ remoteId: '900', pushed: 1, missing: 2 });
    expect(calls.map((c) => c.method).filter((m) => m !== 'GET')).toEqual(['DELETE', 'PUT']);
  });
});

describe('subsonicPusher', () => {
  const ok = (extra: Record<string, unknown> = {}) => json({ 'subsonic-response': { status: 'ok', ...extra } });

  it('signs requests with a salted token and creates, then updates, the playlist', async () => {
    const { calls, fetchImpl } = recorder((method, url, body) => {
      if (url.pathname === '/rest/search3') return ok({ searchResult3: { song: [{ id: 's1', musicBrainzId: REC_A }, { id: 's3', title: 'Third', artist: 'Example Band', duration: 150 }] } });
      if (url.pathname === '/rest/createPlaylist') return ok(new URLSearchParams(body).has('playlistId') ? {} : { playlist: { id: 'p1' } });
      return json({}, 404);
    });
    const pusher = subsonicPusher({ url: 'http://navidrome.example.com', user: 'example', password: 'pw', label: 'Navidrome', fetchImpl, salt: () => 'salt' });
    expect(await pusher.push('Mix', items)).toEqual({ remoteId: 'p1', pushed: 2, missing: 1 });
    const search = calls[0]!.url.searchParams;
    expect(search.get('t')).toBe(createHash('md5').update('pwsalt').digest('hex'));
    expect(search.get('s')).toBe('salt');
    expect(search.has('p')).toBe(false);
    const created = new URLSearchParams(calls[1]!.body);
    expect(created.get('name')).toBe('Mix');
    expect(created.getAll('songId')).toEqual(['s1', 's3']);

    expect(await pusher.push('Mix', items, 'p1')).toMatchObject({ remoteId: 'p1' });
    expect(new URLSearchParams(calls[3]!.body).get('playlistId')).toBe('p1');
  });

  it('turns a failed response into an error with the server message', async () => {
    const { fetchImpl } = recorder(() => json({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } }));
    await expect(subsonicPusher({ url: 'http://navidrome.example.com', user: 'x', password: 'y', label: 'Navidrome', fetchImpl }).push('Mix', items)).rejects.toThrow(/Wrong username or password/);
  });
});
