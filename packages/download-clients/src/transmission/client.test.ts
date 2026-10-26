import { beforeEach, describe, expect, it } from 'vitest';
import legacySessionFixture from '../../fixtures/transmission/session-get-legacy.json' with { type: 'json' };
import sessionFixture from '../../fixtures/transmission/session-get.json' with { type: 'json' };
import legacyTorrentsFixture from '../../fixtures/transmission/torrent-get-legacy.json' with { type: 'json' };
import torrentsFixture from '../../fixtures/transmission/torrent-get.json' with { type: 'json' };
import { fromBase64 } from '../http.js';
import { V1_TORRENT, V1_TORRENT_HASH } from '../test-support.js';
import { DownloadClientError, type ClientRuntime } from '../types.js';
import { TransmissionClient } from './client.js';
import { FakeTransmission, RPC_PATH, type RawTorrent } from './fake-transmission.js';
import { TransmissionSettings, type TransmissionSettingsInput } from './settings.js';

const MAGNET_HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const MAGNET = `magnet:?xt=urn:btih:${MAGNET_HASH.toUpperCase()}&dn=Show.S01E01&tr=udp%3A%2F%2Ftracker.test%3A1337`;
const FIXED = 1_761_400_000_000;

let fake: FakeTransmission;

function newFake(
  session: Record<string, unknown> = sessionFixture.arguments,
  torrents: unknown[] = torrentsFixture.arguments.torrents,
): FakeTransmission {
  return new FakeTransmission(session, torrents as RawTorrent[]);
}

function client(overrides: Partial<TransmissionSettingsInput> = {}): TransmissionClient {
  const runtime: ClientRuntime = { fetch: fake.fetch, now: () => FIXED, sleep: async () => {}, requestTimeoutMs: 1000 };
  return new TransmissionClient(
    TransmissionSettings.parse({ host: '192.168.1.20', username: 'admin', password: 'secret', ...overrides }),
    runtime,
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
  fake = newFake();
});

describe('settings', () => {
  it('applies defaults', () => {
    expect(TransmissionSettings.parse({ host: 'nas' })).toEqual({
      host: 'nas',
      port: 9091,
      useSsl: false,
      urlBase: '/transmission/',
      username: '',
      password: '',
      category: 'arclight',
      recentPriority: 'last',
      olderPriority: 'last',
      addPaused: false,
    });
    expect(() => TransmissionSettings.parse({ host: '' })).toThrow();
  });
});

describe('transport', () => {
  it('performs the session-id handshake once and sends Basic auth to /transmission/rpc', async () => {
    const c = client();
    await c.getItems('arclight');
    await c.getItems('arclight');
    const conflicts = fake.requests.length - fake.rpcCalls.length;
    expect(conflicts).toBe(1);
    expect(fake.urls[0]).toBe(`http://192.168.1.20:9091${RPC_PATH}`);
    expect(fake.rpcCalls.every((call) => call.sessionId === 'session-1')).toBe(true);
    expect(fake.requests[0]?.headers.get('authorization')).toBe(`Basic ${btoa('admin:secret')}`);
  });

  it('picks up a new session id after a daemon restart', async () => {
    const c = client();
    await c.getStatus();
    fake.sessionId = 'session-2';
    await c.getStatus();
    expect(fake.rpcCalls.at(-1)?.sessionId).toBe('session-2');
    expect(fake.requests.length - fake.rpcCalls.length).toBe(2);
  });

  it('maps 401 to an auth error and omits Authorization without credentials', async () => {
    await expectError(client({ password: 'wrong' }).getStatus(), 'auth');
    await expectError(client({ username: '', password: '' }).getStatus(), 'auth');
    expect(fake.requests.at(-1)?.headers.get('authorization')).toBeNull();
  });

  it('maps network failures, bad urlBase, invalid JSON and missing session headers', async () => {
    fake.networkError = new TypeError('fetch failed');
    await expectError(client().test(), 'unreachable');
    fake.networkError = undefined;
    await expectError(client({ urlBase: '/other/' }).test(), 'not-found');
    fake.once('POST', RPC_PATH, { body: 'not json' });
    await expectError(client().getStatus(), 'bad-response');
    fake.once('POST', RPC_PATH, { body: { result: 'success', arguments: { version: 4 } } });
    await expectError(client().getStatus(), 'bad-response');
    // A 409 without the session header cannot be satisfied.
    const headerless = new TransmissionClient(TransmissionSettings.parse({ host: 'h' }), {
      fetch: async () => new Response('', { status: 409 }),
      now: () => FIXED,
      sleep: async () => {},
      requestTimeoutMs: 1000,
    });
    await expectError(headerless.getStatus(), 'bad-response');
  });

  it('maps a non-success result to rejected', async () => {
    fake.failures.set('torrent-stop', 'invalid or corrupt torrent file');
    const error = await expectError(client().pause('abc'), 'rejected');
    expect(error.message).toContain('invalid or corrupt torrent file');
  });
});

describe('test()', () => {
  it('returns version and rpc version without warnings on a modern daemon', async () => {
    expect(await client().test()).toEqual({ version: '4.0.5', apiVersion: '17', warnings: [] });
  });

  it('warns about missing labels on Transmission 2.9x and rejects anything before 2.80', async () => {
    fake = newFake(legacySessionFixture.arguments, legacyTorrentsFixture.arguments.torrents as RawTorrent[]);
    const result = await client({ category: '' , recentPriority: 'first' }).test();
    expect(result.version).toBe('2.94');
    expect(result.warnings).toEqual([expect.stringMatching(/No label is set/)]);
    const legacy = await client().test();
    expect(legacy.warnings).toEqual([expect.stringMatching(/has no labels.*sub-directory/)]);

    fake.session['rpc-version'] = 13;
    fake.session['version'] = '2.52 (13304)';
    const error = await expectError(client().test(), 'bad-response');
    expect(error.message).toMatch(/2\.80 or newer/);
  });
});

describe('addTorrent', () => {
  it('adds a .torrent file as base64 metainfo with a label and returns the hash', async () => {
    const result = await client().addTorrent({ torrentFile: V1_TORRENT, title: 'Test', category: 'arclight' });
    expect(result).toEqual({ id: V1_TORRENT_HASH, warnings: [] });
    const add = fake.rpc('torrent-add')[0]?.arguments ?? {};
    expect(fromBase64(String(add['metainfo']))).toEqual(V1_TORRENT);
    expect(add['labels']).toEqual(['arclight']);
    expect(add['paused']).toBe(false);
    expect(add['download-dir']).toBeUndefined();
  });

  it('adds a magnet, applies seed limits and queue priority, honours paused and savePath', async () => {
    const result = await client({ recentPriority: 'first' }).addTorrent({
      magnet: MAGNET,
      title: 'Show',
      category: 'arclight',
      savePath: '/data/tv',
      paused: true,
      isRecent: true,
      seedRatioLimit: 1.5,
      seedTimeLimitMinutes: 90,
    });
    expect(result).toEqual({ id: MAGNET_HASH, warnings: [] });
    expect(fake.rpc('torrent-add')[0]?.arguments).toMatchObject({ filename: MAGNET, paused: true, 'download-dir': '/data/tv' });
    expect(fake.rpc('torrent-set')[0]?.arguments).toEqual({
      ids: [MAGNET_HASH],
      seedRatioLimit: 1.5,
      seedRatioMode: 1,
      seedIdleLimit: 90,
      seedIdleMode: 1,
    });
    expect(fake.rpc('queue-move-top')[0]?.arguments).toEqual({ ids: [MAGNET_HASH] });
  });

  it('records failed follow-up steps as warnings', async () => {
    fake.failures.set('torrent-set', 'invalid argument');
    const result = await client().addTorrent({ magnet: MAGNET, title: 'Show', category: '', seedRatioLimit: 2 });
    expect(result.id).toBe(MAGNET_HASH);
    expect(result.warnings).toEqual([expect.stringMatching(/Could not set seed limits: .*invalid argument/)]);
  });

  it('rejects duplicates and invalid input', async () => {
    await client().addTorrent({ magnet: MAGNET, title: 'Show', category: 'arclight' });
    await expectError(client().addTorrent({ magnet: MAGNET, title: 'Show', category: 'arclight' }), 'rejected');
    await expectError(client().addTorrent({ magnet: 'magnet:?dn=nothing', title: 'x', category: '' }), 'rejected');
    await expectError(client().addTorrent({ title: 'x', category: '' }), 'rejected');
  });

  it('uses a category sub-directory instead of labels on old daemons', async () => {
    fake = newFake(legacySessionFixture.arguments, []);
    await client().addTorrent({ magnet: MAGNET, title: 'Show', category: 'arclight' });
    const add = fake.rpc('torrent-add')[0]?.arguments ?? {};
    expect(add['download-dir']).toBe('/downloads/complete/arclight');
    expect(add['labels']).toBeUndefined();
  });

  it('sets the label with torrent-set on rpc-version 16', async () => {
    fake = newFake({ ...sessionFixture.arguments, 'rpc-version': 16, version: '3.00 (bb6b5a062e)' }, []);
    await client().addTorrent({ magnet: MAGNET, title: 'Show', category: 'arclight' });
    expect(fake.rpc('torrent-add')[0]?.arguments['labels']).toBeUndefined();
    expect(fake.rpc('torrent-set')[0]?.arguments).toEqual({ ids: [MAGNET_HASH], labels: ['arclight'] });
  });

  it('refuses NZBs', async () => {
    await expectError(client().addNzb(), 'not-supported');
  });
});

describe('listing and management', () => {
  it('filters by label and returns all with an empty category', async () => {
    const c = client();
    const mine = await c.getItems('arclight');
    expect(mine).toHaveLength(13);
    expect(mine.every((i) => i.category === 'arclight')).toBe(true);
    expect(await c.getItems('')).toHaveLength(14);
    expect((await c.getItems('other')).map((i) => i.title)).toEqual(['Other.Thing.2020']);
    expect(fake.rpc('torrent-get')[0]?.arguments['fields']).toContain('hashString');
  });

  it('filters by download directory on old daemons', async () => {
    fake = newFake(legacySessionFixture.arguments, legacyTorrentsFixture.arguments.torrents as RawTorrent[]);
    const items = await client().getItems('arclight');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: '1111111111111111111111111111111111111111',
      category: 'arclight',
      status: 'downloading',
      outputPath: '/downloads/complete/arclight/Legacy.Show.S02E03.720p.HDTV.x264-GRP',
    });
  });

  it('removes with and without data', async () => {
    const c = client();
    const hash = 'a000000000000000000000000000000000000007';
    await c.removeItem(hash.toUpperCase(), true);
    await c.removeItem('a000000000000000000000000000000000000008', false);
    expect(fake.rpc('torrent-remove').map((r) => r.arguments)).toEqual([
      { ids: [hash], 'delete-local-data': true },
      { ids: ['a000000000000000000000000000000000000008'], 'delete-local-data': false },
    ]);
    expect(fake.torrents).toHaveLength(12);
  });

  it('sets the category label, and refuses on daemons without labels', async () => {
    const hash = 'a000000000000000000000000000000000000006';
    await client().setCategory(hash, 'imported');
    expect(fake.rpc('torrent-set')[0]?.arguments).toEqual({ ids: [hash], labels: ['imported'] });
    expect((await client().getItems('imported')).map((i) => i.id)).toEqual([hash]);
    fake = newFake(legacySessionFixture.arguments, []);
    await expectError(client().setCategory(hash, 'imported'), 'not-supported');
  });

  it('pauses and resumes with torrent-stop / torrent-start', async () => {
    const hash = 'a000000000000000000000000000000000000001';
    await client().pause(hash);
    await client().resume(hash);
    expect(fake.rpcCalls.filter((c) => c.method.startsWith('torrent-s')).map((c) => [c.method, c.arguments])).toEqual([
      ['torrent-stop', { ids: [hash] }],
      ['torrent-start', { ids: [hash] }],
    ]);
  });

  it('reports the output directory for labels, directory override and legacy sub-directories', async () => {
    expect(await client().getStatus()).toEqual({
      outputRootDir: '/downloads/complete',
      isLocalhost: false,
      removesCompletedDownloads: false,
    });
    expect((await client({ directory: '/data/arclight', host: 'localhost' }).getStatus())).toMatchObject({
      outputRootDir: '/data/arclight',
      isLocalhost: true,
    });
    fake = newFake(legacySessionFixture.arguments, []);
    expect((await client().getStatus()).outputRootDir).toBe('/downloads/complete/arclight');
  });

  it('reads and sets the peer port', async () => {
    const c = client();
    expect(await c.getListenPort()).toBe(51413);
    await c.setListenPort(60000);
    expect(fake.rpc('session-set')[0]?.arguments).toEqual({ 'peer-port': 60000, 'peer-port-random-on-start': false });
    expect(await c.getListenPort()).toBe(60000);
    await expectError(c.setListenPort(0), 'rejected');
  });
});
