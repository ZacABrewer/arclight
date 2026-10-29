import { describe, expect, it } from 'vitest';
import { AudiobookshelfServerClient, audiobookshelfLibraryKind, audiobookshelfProviderIds } from './audiobookshelf.js';
import { createMediaServerClient } from './index.js';
import { fakeServer, fixture, type RecordedCall } from './test-utils.js';

const abs = fixture<Record<string, any>>('audiobookshelf.json'); // eslint-disable-line @typescript-eslint/no-explicit-any -- loose fixture JSON

const ROUTES: Record<string, unknown> = {
  'GET /status': abs.status,
  'GET /api/libraries': abs.libraries,
  'GET /api/libraries/lib-books/items': (call: RecordedCall) => ({ json: call.url.searchParams.get('page') === '1' ? abs.itemsPage1 : abs.itemsPage0 }),
  'GET /api/libraries/lib-kids/items': abs.kidsItems,
  'GET /api/users': abs.users,
  'GET /api/users/usr-2': abs.reader,
  'POST /api/libraries/lib-books/scan': () => ({ body: 'OK' }),
  'POST /api/libraries/lib-kids/scan': () => ({ body: 'OK' }),
};

function client(routes: Record<string, unknown> = ROUTES) {
  const server = fakeServer(routes);
  return { c: new AudiobookshelfServerClient({ url: 'http://abs.lan:13378/', token: 'abs-token', fetch: server.fetch, pageSize: 2 }), calls: server.calls };
}

describe('AudiobookshelfServerClient', () => {
  it('reads the server version from /status and sends the Bearer token', async () => {
    const { c, calls } = client();
    expect(await c.info()).toEqual({ name: 'Audiobookshelf', version: '2.17.2' });
    expect(calls[0]!.url.pathname).toBe('/status');
    expect(calls[0]!.headers['authorization']).toBe('Bearer abs-token');
    // The token never travels in the query string.
    expect(calls[0]!.url.search).toBe('');
  });

  it('lists libraries with folder paths; book libraries are audiobook, podcasts other', async () => {
    const { c } = client();
    expect(await c.libraries()).toEqual([
      { id: 'lib-books', name: 'Audiobooks', type: 'audiobook', locations: ['/data/audiobooks'] },
      { id: 'lib-kids', name: 'Kids', type: 'audiobook', locations: ['/data/kids-books'] },
      { id: 'lib-pods', name: 'Podcasts', type: 'other', locations: ['/data/podcasts'] },
    ]);
    expect(audiobookshelfLibraryKind('BOOK')).toBe('audiobook');
    expect(audiobookshelfLibraryKind(undefined)).toBe('other');
  });

  it('accepts a bare library array from older servers', async () => {
    const { c } = client({ ...ROUTES, 'GET /api/libraries': abs.libraries.libraries });
    expect((await c.libraries()).map((l) => l.id)).toEqual(['lib-books', 'lib-kids', 'lib-pods']);
  });

  it('pages book items across book libraries and caches the index', async () => {
    const { c, calls } = client();
    const items = await c.listItems('audiobook');
    expect(items.map((i) => [i.id, i.title, i.year, i.libraryId])).toEqual([
      ['li-1', 'Lantern Road', 2019, 'lib-books'],
      ['li-2', 'Quiet Harbour', 2021, 'lib-books'],
      ['li-3', 'Paper Moons', null, 'lib-books'],
    ]);
    expect(items[0]!.path).toBe('/data/audiobooks/Fixture Author/Lantern Road');
    const pages = calls.filter((x) => x.url.pathname === '/api/libraries/lib-books/items');
    expect(pages.map((p) => [p.url.searchParams.get('page'), p.url.searchParams.get('limit')])).toEqual([
      ['0', '2'],
      ['1', '2'],
    ]);
    // Podcast libraries are not listed; video and music kinds list nothing.
    expect(calls.some((x) => x.url.pathname.includes('lib-pods'))).toBe(false);
    expect(await c.listItems('movie')).toEqual([]);
    await c.listItems('audiobook');
    expect(calls.filter((x) => x.url.pathname === '/api/libraries/lib-books/items')).toHaveLength(2);
  });

  it('finds books by ASIN or ISBN client-side', async () => {
    const { c } = client();
    expect((await c.findItems({ mediaType: 'audiobook', asin: 'b0fixture1' })).map((i) => i.id)).toEqual(['li-1']);
    expect((await c.findItems({ mediaType: 'audiobook', isbn: '9780000000002' })).map((i) => i.id)).toEqual(['li-2']);
    expect((await c.findItems({ mediaType: 'audiobook', asin: 'B0FIXTURE3' })).map((i) => i.id)).toEqual(['li-3']);
    expect(await c.findItems({ mediaType: 'audiobook', asin: 'B0NOTHERE0' })).toEqual([]);
    expect(await c.findItems({ mediaType: 'movie', tmdbId: 1 })).toEqual([]);
    const loose = audiobookshelfProviderIds({ asin: 'not-an-asin', isbn: '978 0 00 000000 2' });
    expect(loose.isbn).toBe('9780000000002');
    expect(loose.asin ?? null).toBeNull();
  });

  it('lists users with roles and reads book progress', async () => {
    const { c } = client();
    expect(await c.users()).toEqual([
      { id: 'root', name: 'admin', isAdmin: true, isDisabled: false, lastActivityAt: '2026-01-01T00:00:00.000Z' },
      { id: 'usr-2', name: 'reader', isAdmin: false, isDisabled: false, lastActivityAt: null },
      { id: 'usr-3', name: 'old', isAdmin: false, isDisabled: true, lastActivityAt: null },
    ]);
    expect(await c.playState({ id: 'li-1', mediaType: 'audiobook' }, 'usr-2')).toEqual({
      userId: 'usr-2',
      played: true,
      playCount: 1,
      lastPlayedAt: '2026-01-01T00:00:00.000Z',
      positionMs: 0,
      durationMs: 36_000_000,
    });
    const states = await c.listPlayStates('usr-2', 'audiobook');
    expect(states.map((s) => [s.item.id, s.state.played, s.state.positionMs])).toEqual([
      ['li-1', true, 0],
      ['li-2', false, 4_500_500],
      ['li-3', false, 0],
    ]);
  });

  it('scans only the book libraries whose folders contain the path', async () => {
    const { c, calls } = client();
    await c.refreshLibrary({ path: '/data/audiobooks/Fixture Author/Lantern Road', mediaType: 'audiobook', updateType: 'Created' });
    const scans = calls.filter((x) => x.method === 'POST');
    expect(scans.map((s) => s.url.pathname)).toEqual(['/api/libraries/lib-books/scan']);
    expect(scans[0]!.headers['authorization']).toBe('Bearer abs-token');

    // Outside every library: nothing is scanned. Other media kinds: no request at all.
    const before = calls.length;
    await c.refreshLibrary({ path: '/elsewhere/book', mediaType: 'audiobook' });
    expect(calls.slice(before).filter((x) => x.method === 'POST')).toEqual([]);
    const afterOutside = calls.length;
    await c.refreshLibrary({ path: '/data/audiobooks/x', mediaType: 'music' });
    expect(calls.length).toBe(afterOutside);

    // No path: every book library.
    const { c: c2, calls: calls2 } = client();
    await c2.refreshLibrary();
    expect(calls2.filter((x) => x.method === 'POST').map((s) => s.url.pathname)).toEqual(['/api/libraries/lib-books/scan', '/api/libraries/lib-kids/scan']);
  });

  it('maps a rejected token to unauthorized and validates settings', async () => {
    const { c } = client({ 'GET /api/libraries': () => ({ status: 401, body: 'Unauthorized' }) });
    await expect(c.libraries()).rejects.toMatchObject({ code: 'unauthorized', server: 'audiobookshelf' });
    expect(() => new AudiobookshelfServerClient({ url: 'http://abs', token: ' ' })).toThrow(/token/);
    expect(createMediaServerClient({ kind: 'audiobookshelf', url: 'http://abs', apiKey: 't' })).toBeInstanceOf(AudiobookshelfServerClient);
  });
});
