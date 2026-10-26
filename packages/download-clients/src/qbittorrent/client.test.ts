import { beforeEach, describe, expect, it } from 'vitest';
import categoriesFixture from '../../fixtures/qbittorrent/categories.json' with { type: 'json' };
import filesFixture from '../../fixtures/qbittorrent/files.json' with { type: 'json' };
import prefsFixture from '../../fixtures/qbittorrent/preferences.json' with { type: 'json' };
import propertiesFixture from '../../fixtures/qbittorrent/properties.json' with { type: 'json' };
import legacyFixture from '../../fixtures/qbittorrent/torrents-info-legacy.json' with { type: 'json' };
import torrentsFixture from '../../fixtures/qbittorrent/torrents-info.json' with { type: 'json' };
import { createQBittorrentClient } from '../index.js';
import { V1_TORRENT, V1_TORRENT_HASH } from '../test-support.js';
import { DownloadClientError, type DownloadClient } from '../types.js';
import type { QBittorrentSettings } from './client.js';
import { FakeQBittorrent } from './fake-qbittorrent.js';

const MAGNET_HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const MAGNET = `magnet:?xt=urn:btih:${MAGNET_HASH.toUpperCase()}&dn=Show.S01E01&tr=udp%3A%2F%2Ftracker.test%3A1337`;

const baseSettings: QBittorrentSettings = {
  host: '192.168.1.20',
  port: 8080,
  useSsl: false,
  username: 'admin',
  password: 'secret',
  category: 'tv',
};

let qbt: FakeQBittorrent;
let sleeps: number[];

function client(overrides: Partial<QBittorrentSettings> = {}): DownloadClient {
  return createQBittorrentClient(
    { ...baseSettings, ...overrides },
    {
      fetch: qbt.fetch,
      now: () => 1_761_400_000_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
}

async function expectError(promise: Promise<unknown>, code: DownloadClientError['code']): Promise<DownloadClientError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DownloadClientError);
  const typed = error as DownloadClientError;
  expect(typed.code).toBe(code);
  return typed;
}

beforeEach(() => {
  qbt = new FakeQBittorrent();
  sleeps = [];
  qbt.on('GET', '/api/v2/app/preferences', { body: prefsFixture });
  qbt.on('GET', '/api/v2/torrents/categories', { body: categoriesFixture });
  qbt.on('GET', '/api/v2/torrents/info', { body: torrentsFixture });
  qbt.on('GET', '/api/v2/torrents/properties', { body: propertiesFixture });
  qbt.on('GET', '/api/v2/torrents/files', { body: filesFixture });
  for (const path of ['add', 'delete', 'setCategory', 'createCategory', 'topPrio', 'setForceStart', 'setShareLimits', 'stop', 'start', 'pause', 'resume']) {
    qbt.on('POST', `/api/v2/torrents/${path}`, { body: path === 'add' ? 'Ok.' : '' });
  }
});

describe('authentication', () => {
  it('logs in once with form credentials and reuses the SID cookie', async () => {
    const c = client();
    await c.getItems('tv');
    await c.getItems('tv');
    const logins = qbt.calls('/api/v2/auth/login');
    expect(logins).toHaveLength(1);
    expect(logins[0]?.form).toEqual({ username: 'admin', password: 'secret' });
    const info = qbt.calls('/api/v2/torrents/info');
    expect(info).toHaveLength(2);
    expect(info.every((r) => r.headers.get('cookie') === 'SID=sid-1')).toBe(true);
    expect(info[0]?.query.get('category')).toBe('tv');
  });

  it('logs in again and retries when the session expires (403)', async () => {
    const c = client();
    await c.getItems('tv');
    qbt.nextSid = 'sid-2';
    qbt.validSid = 'expired';
    const items = await c.getItems('tv');
    expect(items.length).toBeGreaterThan(0);
    expect(qbt.calls('/api/v2/auth/login')).toHaveLength(2);
    expect(qbt.calls('/api/v2/torrents/info').at(-1)?.headers.get('cookie')).toBe('SID=sid-2');
  });

  it('maps rejected credentials and IP bans to auth errors', async () => {
    qbt.password = 'other';
    const bad = await expectError(client().getItems('tv'), 'auth');
    expect(bad.message).toMatch(/username or password/);

    qbt.once('POST', '/api/v2/auth/login', { status: 403, body: 'Your IP address has been banned' });
    const banned = await expectError(client().test(), 'auth');
    expect(banned.message).toMatch(/banned/);
  });

  it('fails with auth when a 403 persists after re-login', async () => {
    qbt.on('GET', '/api/v2/torrents/info', { status: 403, body: 'Forbidden' });
    await expectError(client().getItems('tv'), 'auth');
    expect(qbt.calls('/api/v2/auth/login')).toHaveLength(2);
  });

  it('skips login when no credentials are configured (localhost bypass)', async () => {
    qbt.requireAuth = false;
    await client({ username: '', password: '' }).getItems('tv');
    expect(qbt.calls('/api/v2/auth/login')).toHaveLength(0);

    qbt.requireAuth = true;
    await expectError(client({ username: '', password: '' }).getItems('tv'), 'auth');
  });

  it('honours urlBase and https in request URLs', async () => {
    let seen = '';
    const c = createQBittorrentClient(
      { ...baseSettings, useSsl: true, urlBase: '/qbt/' },
      {
        fetch: (input, init) => {
          seen = input.toString();
          return qbt.fetch(input, init);
        },
      },
    );
    await c.getItems('');
    expect(seen).toBe('https://192.168.1.20:8080/qbt/api/v2/torrents/info');
  });
});

describe('error mapping', () => {
  it('maps network failures and timeouts to unreachable', async () => {
    qbt.networkError = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 192.168.1.20:8080') });
    const refused = await expectError(client().getItems('tv'), 'unreachable');
    expect(refused.message).toMatch(/ECONNREFUSED/);

    qbt.networkError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const timeout = await expectError(client().getItems('tv'), 'unreachable');
    expect(timeout.message).toMatch(/timed out/);
  });

  it('maps malformed payloads and server errors to bad-response', async () => {
    qbt.on('GET', '/api/v2/torrents/info', { body: '<html>not json</html>' });
    await expectError(client().getItems('tv'), 'bad-response');

    qbt.on('GET', '/api/v2/torrents/info', { body: [{ hash: 'x' }] });
    await expectError(client().getItems('tv'), 'bad-response');

    qbt.on('GET', '/api/v2/torrents/info', { status: 500, body: 'boom' });
    const e = await expectError(client().getItems('tv'), 'bad-response');
    expect(e.httpStatus).toBe(500);
  });

  it('maps 404 to not-found and a missing v2 API to bad-response on test()', async () => {
    qbt.on('POST', '/api/v2/torrents/setCategory', { status: 404, body: '' });
    await expectError(client().setCategory(MAGNET_HASH, 'tv'), 'not-found');

    qbt.on('GET', '/api/v2/app/webapiVersion', { status: 404, body: '' });
    const e = await expectError(client().test(), 'bad-response');
    expect(e.message).toMatch(/4\.1 or newer/);
  });
});

describe('addTorrent', () => {
  it('adds a magnet with category, stopped=false on qBittorrent 5 and returns the lowercase hash', async () => {
    const result = await client().addTorrent({ magnet: MAGNET, title: 'Show.S01E01', category: 'tv' });
    expect(result).toEqual({ id: MAGNET_HASH, warnings: [] });
    const add = qbt.calls('/api/v2/torrents/add');
    expect(add).toHaveLength(1);
    expect(add[0]?.form).toEqual({ urls: MAGNET, category: 'tv', stopped: 'false' });
    expect(add[0]?.files).toEqual([]);
    // "tv" already exists in categories.json.
    expect(qbt.calls('/api/v2/torrents/createCategory')).toHaveLength(0);
  });

  it('uses the qBittorrent 4.x "paused" field, creates a missing category with its save path, and sends share limits', async () => {
    qbt.on('GET', '/api/v2/app/webapiVersion', { body: '2.9.3' });
    await client({ initialState: 'pause' }).addTorrent({
      magnet: MAGNET,
      title: 'Movie',
      category: 'movies-uhd',
      savePath: '/data/uhd',
      seedRatioLimit: 2,
      seedTimeLimitMinutes: 1440,
    });
    expect(qbt.calls('/api/v2/torrents/createCategory')[0]?.form).toEqual({
      category: 'movies-uhd',
      savePath: '/data/uhd',
    });
    expect(qbt.calls('/api/v2/torrents/add')[0]?.form).toEqual({
      urls: MAGNET,
      category: 'movies-uhd',
      savepath: '/data/uhd',
      autoTMM: 'false',
      paused: 'true',
      ratioLimit: '2',
      seedingTimeLimit: '1440',
    });
    expect(qbt.calls('/api/v2/torrents/setShareLimits')).toHaveLength(0);
  });

  it('uploads a torrent file as multipart and returns its info-hash', async () => {
    const result = await client().addTorrent({
      torrentFile: V1_TORRENT,
      title: 'Show: The/Episode',
      category: 'tv',
      paused: true,
    });
    expect(result.id).toBe(V1_TORRENT_HASH);
    const add = qbt.calls('/api/v2/torrents/add')[0];
    expect(add?.files).toHaveLength(1);
    expect(add?.files[0]?.field).toBe('torrents');
    expect(add?.files[0]?.filename).toBe('Show_ The_Episode.torrent');
    expect(add?.files[0]?.bytes).toEqual(V1_TORRENT);
    expect(add?.form).toEqual({ category: 'tv', stopped: 'true' });
  });

  it('rejects duplicates ("Fails." or 409), invalid input and trackerless magnets without DHT', async () => {
    qbt.once('POST', '/api/v2/torrents/add', { body: 'Fails.' });
    await expectError(client().addTorrent({ magnet: MAGNET, title: 't', category: 'tv' }), 'rejected');

    qbt.once('POST', '/api/v2/torrents/add', { status: 409, body: 'Torrent already exists' });
    await expectError(client().addTorrent({ magnet: MAGNET, title: 't', category: 'tv' }), 'rejected');

    await expectError(client().addTorrent({ title: 't', category: 'tv' }), 'rejected');
    await expectError(client().addTorrent({ magnet: 'magnet:?dn=nothing', title: 't', category: 'tv' }), 'rejected');

    qbt.on('GET', '/api/v2/app/preferences', { body: { ...prefsFixture, dht: false } });
    const trackerless = `magnet:?xt=urn:btih:${MAGNET_HASH}`;
    const e = await expectError(client().addTorrent({ magnet: trackerless, title: 't', category: 'tv' }), 'rejected');
    expect(e.message).toMatch(/DHT/);
  });

  it('waits for the torrent, then applies top priority and force start', async () => {
    qbt.once('GET', '/api/v2/torrents/properties', { status: 404, body: '' });
    const result = await client({ initialState: 'forceStart', recentPriority: 'first' }).addTorrent({
      magnet: MAGNET,
      title: 't',
      category: 'tv',
      isRecent: true,
    });
    expect(result.warnings).toEqual([]);
    expect(sleeps).toEqual([100]);
    expect(qbt.calls('/api/v2/torrents/add')[0]?.form['stopped']).toBe('false');
    expect(qbt.calls('/api/v2/torrents/topPrio')[0]?.form).toEqual({ hashes: MAGNET_HASH });
    expect(qbt.calls('/api/v2/torrents/setForceStart')[0]?.form).toEqual({ hashes: MAGNET_HASH, value: 'true' });
  });

  it('applies share limits after adding on old APIs and reports non-fatal follow-up failures', async () => {
    qbt.on('GET', '/api/v2/app/webapiVersion', { body: '2.2.0' });
    qbt.on('POST', '/api/v2/torrents/topPrio', { status: 409, body: '' });
    const result = await client({ olderPriority: 'first' }).addTorrent({
      magnet: MAGNET,
      title: 't',
      category: 'tv',
      seedRatioLimit: 1.5,
    });
    expect(qbt.calls('/api/v2/torrents/add')[0]?.form['ratioLimit']).toBeUndefined();
    expect(qbt.calls('/api/v2/torrents/setShareLimits')[0]?.form).toMatchObject({
      hashes: MAGNET_HASH,
      ratioLimit: '1.5',
      seedingTimeLimit: '-2',
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/queueing is disabled/);
  });

  it('gives up waiting after ten attempts without failing the grab', async () => {
    qbt.on('GET', '/api/v2/torrents/properties', { status: 404, body: '' });
    const result = await client({ initialState: 'forceStart' }).addTorrent({ magnet: MAGNET, title: 't', category: 'tv' });
    expect(result.id).toBe(MAGNET_HASH);
    expect(sleeps).toHaveLength(10);
    expect(result.warnings[0]).toMatch(/did not appear/);
    expect(qbt.calls('/api/v2/torrents/setForceStart')).toHaveLength(0);
  });
});

describe('getItems', () => {
  it('lists and maps every torrent in the category', async () => {
    const items = await client().getItems('tv');
    expect(items).toHaveLength(torrentsFixture.length);
    const statuses = new Map(items.map((i) => [i.title.slice(-28), i.status]));
    expect(new Set(statuses.values())).toEqual(new Set(['downloading', 'queued', 'warning', 'paused', 'seeding', 'completed']));
    expect(items[0]?.id).toBe('0101010101010101010101010101010101010101');
  });

  it('derives outputPath from the file list and checks properties on qBittorrent 4.x payloads', async () => {
    qbt.on('GET', '/api/v2/torrents/info', { body: legacyFixture });
    const [done, active] = await client({ category: 'movies' }).getItems('movies');
    expect(done).toMatchObject({
      status: 'completed',
      outputPath: '/data/movies/Movie.Title.2020.1080p.BluRay.x264-GRP',
      // properties.json says is_private=false and no limits are configured.
      canBeRemoved: true,
    });
    expect(active?.status).toBe('downloading');
    expect(active?.outputPath).toBe('/data/movies/');
    expect(qbt.calls('/api/v2/torrents/files')).toHaveLength(1);
    expect(qbt.calls('/api/v2/torrents/properties')).toHaveLength(1);
  });
});

describe('item actions', () => {
  it('removes with and without data', async () => {
    const c = client();
    await c.removeItem(MAGNET_HASH.toUpperCase(), true);
    await c.removeItem(MAGNET_HASH, false);
    expect(qbt.calls('/api/v2/torrents/delete').map((r) => r.form)).toEqual([
      { hashes: MAGNET_HASH, deleteFiles: 'true' },
      { hashes: MAGNET_HASH, deleteFiles: 'false' },
    ]);
  });

  it('uses stop/start on qBittorrent 5 and pause/resume on 4.x', async () => {
    await client().pause(MAGNET_HASH);
    await client().resume(MAGNET_HASH);
    qbt.on('GET', '/api/v2/app/webapiVersion', { body: '2.9.3' });
    await client().pause(MAGNET_HASH);
    await client().resume(MAGNET_HASH);
    const paths = qbt.requests.filter((r) => r.method === 'POST' && r.path !== '/api/v2/auth/login').map((r) => r.path);
    expect(paths).toEqual([
      '/api/v2/torrents/stop',
      '/api/v2/torrents/start',
      '/api/v2/torrents/pause',
      '/api/v2/torrents/resume',
    ]);
  });

  it('sets a category, creating it first when unknown', async () => {
    await client().setCategory(MAGNET_HASH, 'tv-imported');
    expect(qbt.calls('/api/v2/torrents/createCategory')[0]?.form).toEqual({ category: 'tv-imported' });
    expect(qbt.calls('/api/v2/torrents/setCategory')[0]?.form).toEqual({ hashes: MAGNET_HASH, category: 'tv-imported' });
  });
});

describe('status and test', () => {
  it('resolves the output root from the category save path', async () => {
    await expect(client().getStatus()).resolves.toEqual({
      outputRootDir: '/downloads/tv',
      isLocalhost: false,
      removesCompletedDownloads: false,
    });
    await expect(client({ category: 'rel', host: 'localhost' }).getStatus()).resolves.toMatchObject({
      outputRootDir: '/downloads/sub/rel',
      isLocalhost: true,
    });
    await expect(client({ category: 'movies' }).getStatus()).resolves.toMatchObject({ outputRootDir: '/downloads/' });
  });

  it('reports version and warns about removal at the ratio limit and disabled queueing', async () => {
    qbt.on('GET', '/api/v2/app/preferences', {
      body: { ...prefsFixture, max_ratio_enabled: true, max_ratio: 1, max_ratio_act: 1, queueing_enabled: false },
    });
    const result = await client({ recentPriority: 'first' }).test();
    expect(result.version).toBe('5.0.2');
    expect(result.apiVersion).toBe('2.11.2');
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/removes torrents/);
    expect(result.warnings[1]).toMatch(/queueing is disabled/);
    await expect(client().getStatus()).resolves.toMatchObject({ removesCompletedDownloads: true });
  });

  it('creates the configured category during test when missing', async () => {
    const result = await client({ category: 'anime' }).test();
    expect(result.warnings).toEqual([]);
    expect(qbt.calls('/api/v2/torrents/createCategory')[0]?.form).toEqual({ category: 'anime' });
  });
});

describe('listen port', () => {
  it('sets the listen port through setPreferences with random_port off', async () => {
    qbt.on('POST', '/api/v2/app/setPreferences', { body: '' });
    await client().setListenPort!(51413);
    const call = qbt.calls('/api/v2/app/setPreferences')[0];
    expect(JSON.parse(call?.form['json'] ?? '{}')).toEqual({ listen_port: 51413, random_port: false });
  });

  it('rejects an invalid port without calling qBittorrent', async () => {
    await expectError(client().setListenPort!(70000), 'rejected');
    expect(qbt.calls('/api/v2/app/setPreferences')).toHaveLength(0);
  });

  it('reads the listen port from preferences', async () => {
    qbt.on('GET', '/api/v2/app/preferences', { body: { ...prefsFixture, listen_port: 6881 } });
    await expect(client().getListenPort!()).resolves.toBe(6881);
  });
});
