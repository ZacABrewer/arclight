import { describe, expect, it } from 'vitest';
import { parsePlexWebhook, PlexServerReadClient } from './plex.js';
import { fakeServer, fixture, type RecordedCall } from './test-utils.js';

const px = fixture<Record<string, any>>('plex.json'); // eslint-disable-line @typescript-eslint/no-explicit-any -- loose fixture JSON

/** Section listings answer by `type` (1 movies, 4 episodes) like Plex does. */
function sectionAll(rows: Record<string, unknown>[]) {
  return (call: RecordedCall) => {
    let out = rows;
    if (call.url.searchParams.get('sort') === 'lastViewedAt:desc') {
      out = [...rows].sort((a, b) => Number(b['lastViewedAt'] ?? 0) - Number(a['lastViewedAt'] ?? 0));
    }
    return { json: { MediaContainer: { size: out.length, totalSize: out.length, Metadata: out } } };
  };
}

const MOVIES = px.movies.MediaContainer.Metadata as Record<string, unknown>[];
const EPISODES = px.episodes.MediaContainer.Metadata as Record<string, unknown>[];
const DAVE = px.historyDave.MediaContainer.Metadata as Record<string, unknown>[];

function routes(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'GET /': px.root,
    'GET /library/sections': px.sections,
    'GET /accounts': px.accounts,
    'GET /library/sections/1/all': sectionAll(MOVIES),
    'GET /library/sections/2/all': (call: RecordedCall) =>
      call.url.searchParams.get('type') === '4' ? sectionAll(EPISODES)(call) : { json: px.shows },
    'GET /status/sessions/history/all': (call: RecordedCall) => {
      if (call.url.searchParams.get('accountID') !== '5') return { json: { MediaContainer: { size: 0 } } };
      const item = call.url.searchParams.get('metadataItemID');
      const rows = item ? DAVE.filter((h) => String(h['ratingKey'] ?? String(h['key']).split('/').pop()) === item) : DAVE;
      return { json: { MediaContainer: { size: rows.length, Metadata: rows } } };
    },
    'GET /library/metadata/201,202': { MediaContainer: { Metadata: [EPISODES[0], EPISODES[1]] } },
    'GET /library/metadata/200': { MediaContainer: { Metadata: [px.shows.MediaContainer.Metadata[0]] } },
    'GET /status/sessions': px.sessions,
    'GET /api/v2/user': px.plexTvUser,
    'GET /api/v2/friends': px.friends,
    'GET /api/v2/home/users': px.homeUsers,
    'GET /api/v2/resources': px.resources,
    ...over,
  };
}

function client(over: Record<string, unknown> = {}) {
  const server = fakeServer(routes(over));
  const c = new PlexServerReadClient({ url: 'http://plex.example.com:32400', plexTvUrl: 'https://plextv.example.com', token: 'owner-token', fetch: server.fetch });
  return { c, calls: server.calls };
}

describe('PlexServerReadClient accounts', () => {
  it('merges the server accounts with plex.tv friends and Home users, keyed by plex.tv id', async () => {
    const { c, calls } = client();
    const { accounts, complete } = await c.accounts();
    expect(complete).toBe(true);
    const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
    expect(byId['1000001']).toMatchObject({ localId: '1', name: 'owner', kind: 'owner', isAdmin: true });
    expect(byId['5']).toMatchObject({ localId: '5', name: 'dave', kind: 'shared', isAdmin: false });
    expect(byId['6']).toMatchObject({ localId: '6', name: 'erin', kind: 'shared' });
    expect(byId['9']).toMatchObject({ localId: '9', name: 'Kids', kind: 'managed' });
    // frank shares another server only; gina has not accepted.
    expect(byId['7']).toBeUndefined();
    expect(byId['8']).toBeUndefined();
    expect(accounts.filter((a) => a.isAdmin)).toHaveLength(1);
    const tv = calls.find((x) => x.url.pathname === '/api/v2/user');
    expect(tv?.url.origin).toBe('https://plextv.example.com');
    expect(tv?.headers['x-plex-token']).toBe('owner-token');
  });

  it('falls back to the stored owner id and marks the list incomplete when plex.tv fails', async () => {
    const { c } = client({ 'GET /api/v2/user': () => ({ status: 503, body: 'down' }) });
    const { accounts, complete } = await c.accounts({ ownerId: '1000001' });
    expect(complete).toBe(false);
    expect(accounts.map((a) => [a.id, a.localId, a.kind])).toEqual([
      ['1000001', '1', 'owner'],
      ['5', '5', 'local'],
    ]);
  });

  it('fails without plex.tv and without a stored owner id', async () => {
    const { c } = client({ 'GET /api/v2/user': () => ({ status: 503, body: 'down' }) });
    await expect(c.accounts()).rejects.toThrow();
  });

  it('keeps the owner and the friends when Home users cannot be read, but says so', async () => {
    const { c } = client({ 'GET /api/v2/home/users': () => ({ status: 401, body: '' }) });
    const { accounts, complete } = await c.accounts();
    expect(complete).toBe(false);
    expect(accounts.map((a) => a.id).sort()).toEqual(['1000001', '5', '6']);
  });

  it("finds this server's token for a user's plex.tv token", async () => {
    const { c, calls } = client();
    expect(await c.serverTokenFor('erin-plex-tv-token')).toBe('server-token-erin');
    const call = calls.find((x) => x.url.pathname === '/api/v2/resources');
    expect(call?.headers['x-plex-token']).toBe('erin-plex-tv-token');
    expect(call?.url.searchParams.get('includeHttps')).toBe('1');
    const none = client({ 'GET /api/v2/resources': [] });
    expect(await none.c.serverTokenFor('x')).toBeNull();
  });
});

describe('PlexServerReadClient watchItems', () => {
  it("reads the owner's movies and episodes with their own state", async () => {
    const { c } = client();
    const items = await c.watchItems({ localId: '1' });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId['101']).toMatchObject({ type: 'Movie', played: true, playCount: 1, lastPlayedAt: new Date(1759348800_000).toISOString(), ids: { tmdbId: 98765, imdbId: 'tt7654321' } });
    expect(byId['102']).toMatchObject({ played: false, positionMs: 600000, ids: { imdbId: 'tt0000001' } });
    expect(byId['201']).toMatchObject({ type: 'Episode', seriesId: '200', seasonId: '210', seasonNumber: 1, episodeNumber: 1, played: true, playCount: 2, ids: { tvdbId: 9000001 } });
    expect(byId['202']).toMatchObject({ played: false, positionMs: 900000 });
    expect(byId['203']).toMatchObject({ played: false, playCount: 0, lastPlayedAt: null });
  });

  it('stops an incremental owner read at the first item played before the cut-off', async () => {
    const { c, calls } = client();
    const since = new Date(1759500000_000).toISOString();
    const items = await c.watchItems({ localId: '1' }, { playedSince: since });
    expect(items.map((i) => i.id).sort()).toEqual(['201', '202']);
    expect(calls.filter((x) => x.url.pathname.endsWith('/all')).every((x) => x.url.searchParams.get('sort') === 'lastViewedAt:desc')).toBe(true);
  });

  it("derives another account's state from its history on a full read", async () => {
    const { c } = client();
    const items = await c.watchItems({ localId: '5' });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId['101']).toMatchObject({ played: true, playCount: 1, positionMs: 0 });
    expect(byId['201']).toMatchObject({ played: true, playCount: 2, lastPlayedAt: new Date(1760100000_000).toISOString(), seriesId: '200' });
    expect(byId['202']).toMatchObject({ played: true, playCount: 1, positionMs: 0 });
    expect(byId['203']).toMatchObject({ played: false, playCount: 0 });
    expect(byId['102']).toMatchObject({ played: false });
  });

  it('reads only recent history on an incremental read, with full play counts per item', async () => {
    const { c, calls } = client();
    const items = await c.watchItems({ localId: '5' }, { playedSince: new Date(1759500000_000).toISOString() });
    expect(items.map((i) => [i.id, i.playCount]).sort()).toEqual([
      ['201', 2],
      ['202', 1],
    ]);
    expect(calls.some((x) => x.url.pathname === '/library/metadata/201,202')).toBe(true);
    expect(calls.some((x) => x.url.pathname.startsWith('/library/sections/'))).toBe(false);
  });

  it("reads with a user's own server token when given one", async () => {
    const { c, calls } = client();
    await c.watchItems({ localId: '6' }, { token: 'server-token-erin' });
    const listing = calls.filter((x) => x.url.pathname.startsWith('/library/sections/') && x.url.pathname.endsWith('/all'));
    expect(listing.length).toBeGreaterThan(0);
    expect(listing.every((x) => x.headers['x-plex-token'] === 'server-token-erin')).toBe(true);
    expect(calls.some((x) => x.url.pathname === '/status/sessions/history/all')).toBe(false);
  });
});

describe('PlexServerReadClient live playback', () => {
  it('lists sessions with account, player, state and play method', async () => {
    const { c } = client();
    const sessions = await c.sessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      sessionKey: '12',
      accountId: '5',
      accountName: 'dave',
      playerId: 'tv-dave',
      device: 'Bedroom TV',
      client: 'Plex for LG',
      state: 'playing',
      playMethod: 'DirectPlay',
      item: { ratingKey: '202', type: 'episode', grandparentRatingKey: '200', seasonNumber: 1, episodeNumber: 2, positionMs: 1200000, durationMs: 2700000 },
    });
    expect(sessions[1]).toMatchObject({ accountId: '1', state: 'paused', playMethod: 'Transcode', item: { ids: { tmdbId: 98765 } } });
  });

  it('reads the ids of one item, null when it is gone', async () => {
    const { c } = client();
    expect(await c.itemIds('200')).toMatchObject({ title: 'Signal Lost', ids: { tvdbId: 424242, tmdbId: 123456 } });
    expect(await c.itemIds('999')).toBeNull();
  });

  it('parses a webhook payload from its JSON string', () => {
    const event = parsePlexWebhook(JSON.stringify(px.webhookScrobble));
    expect(event).toMatchObject({
      event: 'media.scrobble',
      accountId: '1',
      accountName: 'owner',
      serverUuid: 'abc123machine',
      playerId: 'web-owner',
      device: 'Chrome',
      item: { ratingKey: '101', type: 'movie', positionMs: 6600000, durationMs: 7200000, ids: { tmdbId: 98765, imdbId: 'tt7654321' } },
    });
  });

  it('rejects payloads that are not Plex events', () => {
    expect(parsePlexWebhook('not json')).toBeNull();
    expect(parsePlexWebhook({ hello: 'world' })).toBeNull();
    expect(parsePlexWebhook({ event: 'library.new', Server: { uuid: 'x' } })).toMatchObject({ event: 'library.new', item: null });
  });
});
