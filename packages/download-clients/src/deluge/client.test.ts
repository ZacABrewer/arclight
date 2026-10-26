import { beforeEach, describe, expect, it } from 'vitest';
import configFixture from '../../fixtures/deluge/config-values.json' with { type: 'json' };
import torrentsFixture from '../../fixtures/deluge/torrents-status.json' with { type: 'json' };
import { fromBase64 } from '../http.js';
import { V1_TORRENT, V1_TORRENT_HASH } from '../test-support.js';
import { DownloadClientError, type ClientRuntime } from '../types.js';
import { DelugeClient } from './client.js';
import { FakeDeluge } from './fake-deluge.js';
import { DelugeSettings, type DelugeSettingsInput } from './settings.js';

const FIXED = 1_761_400_000_000;
const MAGNET_HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const MAGNET = `magnet:?xt=urn:btih:${MAGNET_HASH.toUpperCase()}&dn=Show.S01E01&tr=udp%3A%2F%2Ftracker.test%3A1337`;

let fake: FakeDeluge;

function runtime(): ClientRuntime {
  return { fetch: fake.fetch, now: () => FIXED, sleep: async () => {}, requestTimeoutMs: 1000 };
}

function client(overrides: Partial<DelugeSettingsInput> = {}): DelugeClient {
  return new DelugeClient(
    DelugeSettings.parse({ host: '192.168.1.30', password: 'deluge', category: 'tv', ...overrides }),
    runtime(),
  );
}

function loadFixtureTorrents(): void {
  for (const [hash, status] of Object.entries(torrentsFixture)) fake.addTorrent(hash, status);
  fake.labels = ['tv', 'movies'];
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
  fake = new FakeDeluge();
});

describe('settings', () => {
  it('applies defaults and validates labels', () => {
    expect(DelugeSettings.parse({ host: 'nas' })).toEqual({
      host: 'nas',
      port: 8112,
      useSsl: false,
      password: '',
      category: 'media-tron',
      recentPriority: 'last',
      olderPriority: 'last',
      addPaused: false,
    });
    expect(DelugeSettings.safeParse({ host: 'nas', category: 'TV-Shows' }).success).toBe(true);
    expect(DelugeSettings.safeParse({ host: 'nas', category: 'tv shows' }).success).toBe(false);
    expect(DelugeSettings.shape.password.description).toMatch(/deluge/);
  });
});

describe('session and daemon connection', () => {
  it('logs in once, keeps the session cookie and connects to the first online host', async () => {
    fake.hosts = [
      { id: 'down', host: '10.0.0.9', port: 58846, status: 'Offline', version: '' },
      { id: 'up', host: '127.0.0.1', port: 58846, status: 'Online', version: '2.1.1' },
    ];
    const c = client();
    await c.getItems('tv');
    await c.getItems('tv');
    expect(fake.methods('auth.login')).toHaveLength(1);
    expect(fake.methods('auth.login')[0]?.params).toEqual(['deluge']);
    expect(fake.methods('web.connect').map((r) => r.params)).toEqual([['up']]);
    const listCalls = fake.methods('core.get_torrents_status');
    expect(listCalls).toHaveLength(2);
    expect(listCalls.every((r) => r.cookie === '_session_id=sess-1')).toBe(true);
    expect(fake.calls('/json').every((r) => r.method === 'POST')).toBe(true);
  });

  it('uses the urlBase in the endpoint', async () => {
    fake.stripPrefix = '/deluge';
    await client({ urlBase: 'deluge/', useSsl: true, port: 443 }).getItems('');
    expect(fake.urls[0]).toBe('https://192.168.1.30:443/deluge/json');
  });

  it('logs in again and retries when the session expires (code 1)', async () => {
    const c = client();
    await c.getItems('tv');
    fake.expireSession();
    await c.getItems('tv');
    expect(fake.methods('auth.login')).toHaveLength(2);
    const lastList = fake.methods('core.get_torrents_status').at(-1);
    expect(lastList?.cookie).toBe('_session_id=sess-2');
  });

  it('reconnects when the Web UI lost its daemon', async () => {
    const c = client();
    await c.getItems('tv');
    fake.disconnect();
    await expect(c.getItems('tv')).resolves.toEqual([]);
    expect(fake.methods('web.connect')).toHaveLength(2);
  });

  it('maps a wrong password to auth', async () => {
    const error = await expectError(client({ password: 'nope' }).getItems('tv'), 'auth');
    expect(error.message).toMatch(/password/);
  });

  it('reports a Web UI without daemon hosts as unreachable', async () => {
    fake.hosts = [];
    const error = await expectError(client().getItems('tv'), 'unreachable');
    expect(error.message).toMatch(/Connection Manager/);
  });

  it('reports an offline daemon as unreachable', async () => {
    fake.hosts = [{ id: 'down', host: '10.0.0.9', port: 58846, status: 'Offline', version: '' }];
    const error = await expectError(client().getItems('tv'), 'unreachable');
    expect(error.message).toMatch(/10\.0\.0\.9:58846/);
  });

  it('maps network failures, HTTP errors and garbage bodies', async () => {
    fake.networkError = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    await expectError(client().getItems('tv'), 'unreachable');
    fake.networkError = undefined;

    fake.once('POST', '/json', { status: 502, body: 'Bad Gateway' });
    await expectError(client().getItems('tv'), 'bad-response');

    fake.once('POST', '/json', { body: '<html>not deluge</html>' });
    await expectError(client().getItems('tv'), 'bad-response');

    fake.stripPrefix = '/wrong';
    await expectError(client({ urlBase: '/other' }).getItems('tv'), 'not-found');
  });
});

describe('addTorrent', () => {
  it('uploads a torrent file as base64 with options and labels it', async () => {
    const result = await client().addTorrent({
      torrentFile: V1_TORRENT,
      title: 'Show S01E01',
      category: 'TV',
      savePath: '/data/tv',
      seedRatioLimit: 1.5,
    });
    expect(result).toEqual({ id: V1_TORRENT_HASH, warnings: [] });
    const add = fake.methods('core.add_torrent_file')[0];
    expect(add?.params[0]).toBe('Show S01E01.torrent');
    expect(fromBase64(String(add?.params[1]))).toEqual(V1_TORRENT);
    expect(add?.params[2]).toEqual({
      add_paused: false,
      download_location: '/data/tv',
      stop_at_ratio: true,
      stop_ratio: 1.5,
      remove_at_ratio: false,
    });
    expect(fake.labels).toEqual(['tv']);
    expect(fake.torrents.get(V1_TORRENT_HASH)?.['label']).toBe('tv');
    expect(fake.methods('core.queue_top')).toHaveLength(0);
  });

  it('adds a magnet, moves recent content to the top and warns about seed time', async () => {
    fake.labels = ['tv'];
    fake.override('core.add_torrent_magnet', () => MAGNET_HASH.toUpperCase());
    fake.addTorrent(MAGNET_HASH, { name: 'Show.S01E01', state: 'Downloading' });
    const result = await client({ recentPriority: 'first', addPaused: true }).addTorrent({
      magnet: MAGNET,
      title: 'Show.S01E01',
      category: 'tv',
      isRecent: true,
      seedTimeLimitMinutes: 60,
    });
    expect(result.id).toBe(MAGNET_HASH);
    expect(result.warnings).toEqual([expect.stringMatching(/seeding time/)]);
    expect(fake.methods('core.add_torrent_magnet')[0]?.params).toEqual([MAGNET, { add_paused: true }]);
    expect(fake.methods('core.queue_top')[0]?.params).toEqual([[MAGNET_HASH]]);
    expect(fake.methods('label.add')).toHaveLength(0);
  });

  it('rejects duplicates, null results and invalid input', async () => {
    fake.labels = ['tv'];
    fake.addTorrent(MAGNET_HASH, { name: 'dup', state: 'Seeding' });
    const dup = await expectError(client().addTorrent({ magnet: MAGNET, title: 'x', category: 'tv' }), 'rejected');
    expect(dup.message).toMatch(/already in session/);

    fake.override('core.add_torrent_file', () => null);
    await expectError(client().addTorrent({ torrentFile: V1_TORRENT, title: 'x', category: 'tv' }), 'rejected');

    await expectError(client().addTorrent({ magnet: 'magnet:?dn=nohash', title: 'x', category: 'tv' }), 'rejected');
    await expectError(client().addTorrent({ title: 'x', category: 'tv' }), 'rejected');
  });

  it('enables the Label plugin when it is off', async () => {
    fake.enabledPlugins = [];
    const result = await client().addTorrent({ torrentFile: V1_TORRENT, title: 'x', category: 'tv' });
    expect(result.warnings).toEqual([]);
    expect(fake.methods('core.enable_plugin')[0]?.params).toEqual(['Label']);
    expect(fake.torrents.get(V1_TORRENT_HASH)?.['label']).toBe('tv');
  });
});

describe('getItems', () => {
  it('filters by label and maps states', async () => {
    loadFixtureTorrents();
    fake.config = { ...configFixture };
    const items = await client().getItems('TV');
    const listCall = fake.methods('core.get_torrents_status')[0];
    expect(listCall?.params[0]).toEqual({ label: 'tv' });
    expect(listCall?.params[1]).toContain('download_location');
    const byId = Object.fromEntries(items.map((i) => [i.id.slice(0, 1), i.status]));
    expect(byId).toEqual({ '1': 'downloading', '2': 'seeding', '3': 'completed', '4': 'warning', '5': 'queued' });
    expect(items.find((i) => i.id.startsWith('4'))?.statusMessage).toMatch(/No space left/);
  });

  it('lists everything with an empty category', async () => {
    loadFixtureTorrents();
    const items = await client().getItems('');
    expect(fake.methods('core.get_torrents_status')[0]?.params[0]).toEqual({});
    expect(items).toHaveLength(6);
  });
});

describe('item operations', () => {
  beforeEach(loadFixtureTorrents);
  const HASH = '3333333333333333333333333333333333333333';

  it('removes with and without data, and maps a missing torrent to not-found', async () => {
    const c = client();
    await c.removeItem(HASH.toUpperCase(), true);
    await c.removeItem('2222222222222222222222222222222222222222', false);
    expect(fake.methods('core.remove_torrent').map((r) => r.params)).toEqual([
      [HASH, true],
      ['2222222222222222222222222222222222222222', false],
    ]);
    await expectError(c.removeItem(HASH, false), 'not-found');
  });

  it('sets the label, creating it lowercase when missing', async () => {
    const c = client();
    await c.setCategory(HASH, 'TV-Imported');
    expect(fake.methods('label.add')[0]?.params).toEqual(['tv-imported']);
    expect(fake.torrents.get(HASH)?.['label']).toBe('tv-imported');
    await c.setCategory(HASH, '');
    expect(fake.torrents.get(HASH)?.['label']).toBe('');
  });

  it('pauses and resumes with a list of hashes', async () => {
    const c = client();
    await c.pause('1111111111111111111111111111111111111111');
    expect(fake.torrents.get('1111111111111111111111111111111111111111')?.['state']).toBe('Paused');
    await c.resume('1111111111111111111111111111111111111111');
    expect(fake.methods('core.pause_torrent')[0]?.params).toEqual([['1111111111111111111111111111111111111111']]);
    expect(fake.methods('core.resume_torrent')[0]?.params).toEqual([['1111111111111111111111111111111111111111']]);
    expect(fake.torrents.get('1111111111111111111111111111111111111111')?.['state']).toBe('Downloading');
  });

  it('sets and reads the listen port', async () => {
    const c = client();
    await c.setListenPort(51413);
    expect(fake.listenPorts).toEqual([51413, 51413]);
    expect(fake.randomPort).toBe(false);
    await expect(c.getListenPort()).resolves.toBe(51413);
    await expectError(c.setListenPort(70000), 'rejected');
  });
});

describe('getStatus', () => {
  it('reports the download location, or the move-completed path', async () => {
    fake.labels = ['tv'];
    await expect(client().getStatus()).resolves.toEqual({
      outputRootDir: '/downloads',
      isLocalhost: false,
      removesCompletedDownloads: false,
    });
    fake.config = { ...configFixture };
    expect((await client({ host: 'localhost' }).getStatus())).toMatchObject({
      outputRootDir: '/downloads/completed',
      isLocalhost: true,
    });
  });

  it('prefers the label\'s move-completed path and detects removal at ratio', async () => {
    fake.labels = ['tv'];
    fake.labelOptions.set('tv', { apply_move_completed: true, move_completed: true, move_completed_path: '/data/tv' });
    fake.addTorrent('7777777777777777777777777777777777777777', { label: 'tv', stop_at_ratio: true, remove_at_ratio: true });
    expect(await client().getStatus()).toMatchObject({ outputRootDir: '/data/tv', removesCompletedDownloads: true });

    fake.torrents.clear();
    fake.config = { ...fake.config, stop_seed_at_ratio: true, remove_seed_at_ratio: true };
    expect((await client({ category: '' }).getStatus()).removesCompletedDownloads).toBe(true);
  });
});

describe('test()', () => {
  it('returns the version and creates the label', async () => {
    const result = await client().test();
    expect(result).toEqual({ version: '2.1.1', apiVersion: 'json-rpc', warnings: [] });
    expect(fake.labels).toEqual(['tv']);
  });

  it('warns about a missing label, uppercase labels, enabling the plugin and removal at ratio', async () => {
    fake.config = { ...fake.config, stop_seed_at_ratio: true, remove_seed_at_ratio: true };
    expect((await client({ category: '' }).test()).warnings).toEqual([
      expect.stringMatching(/No label/),
      expect.stringMatching(/Remove at ratio/),
    ]);

    fake.enabledPlugins = [];
    fake.disconnect();
    const result = await client({ category: 'TV' }).test();
    expect(result.warnings).toEqual([
      expect.stringMatching(/lowercase.*"tv"/),
      expect.stringMatching(/Enabled the Label plugin/),
      expect.stringMatching(/Remove at ratio/),
    ]);
    expect(fake.enabledPlugins).toContain('Label');
  });

  it('fails when the Label plugin cannot be enabled', async () => {
    fake.enabledPlugins = [];
    fake.availablePlugins = [];
    const error = await expectError(client().test(), 'bad-response');
    expect(error.message).toMatch(/Label plugin/);
  });
});

it('refuses NZBs', async () => {
  await expectError(client().addNzb(), 'not-supported');
  expect(client().protocol).toBe('torrent');
});
