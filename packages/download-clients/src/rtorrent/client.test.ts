import { beforeEach, describe, expect, it } from 'vitest';
import torrentsFixture from '../../fixtures/rtorrent/torrents.json' with { type: 'json' };
import responses from '../../fixtures/rtorrent/responses.json' with { type: 'json' };
import { V1_TORRENT, V1_TORRENT_HASH } from '../test-support.js';
import { DownloadClientError, type ClientRuntime } from '../types.js';
import { quoteCommandArg, RTorrentClient } from './client.js';
import { FakeRTorrent, parseLoadCommand } from './fake-rtorrent.js';
import { RTorrentSettings, type RTorrentSettingsInput } from './settings.js';

const FIXED = 1_761_400_000_000;
const MAGNET_HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const MAGNET = `magnet:?xt=urn:btih:${MAGNET_HASH.toUpperCase()}&dn=Show.S01E01&tr=udp%3A%2F%2Ftracker.test%3A1337`;

let fake: FakeRTorrent;
let sleeps: number[];

function runtime(): ClientRuntime {
  return {
    fetch: fake.fetch,
    now: () => FIXED,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    requestTimeoutMs: 1000,
  };
}

function client(overrides: Partial<RTorrentSettingsInput> = {}): RTorrentClient {
  return new RTorrentClient(RTorrentSettings.parse({ host: '192.168.1.20', category: 'tv', ...overrides }), runtime());
}

async function expectError(promise: Promise<unknown>, code: DownloadClientError['code']): Promise<DownloadClientError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DownloadClientError);
  expect((error as DownloadClientError).code).toBe(code);
  return error as DownloadClientError;
}

beforeEach(() => {
  fake = new FakeRTorrent(torrentsFixture);
  sleeps = [];
});

describe('settings', () => {
  it('applies defaults', () => {
    expect(RTorrentSettings.parse({ host: 'nas' })).toEqual({
      host: 'nas',
      port: 8080,
      useSsl: false,
      urlBase: 'RPC2',
      username: '',
      password: '',
      category: 'media-tron',
      addPaused: false,
      recentPriority: 'normal',
      olderPriority: 'normal',
    });
    expect(() => RTorrentSettings.parse({ host: 'nas', recentPriority: 'urgent' })).toThrow();
  });
});

describe('transport', () => {
  it('POSTs text/xml to <base>/RPC2 with Basic auth when credentials are set', async () => {
    fake.credentials = { username: 'admin', password: 'secret' };
    const result = await client({ username: 'admin', password: 'secret' }).test();
    expect(result.version).toBe('0.9.8');
    expect(fake.urls[0]).toBe('http://192.168.1.20:8080/RPC2');
    const request = fake.requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('content-type')).toContain('text/xml');
    expect(request?.headers.get('authorization')).toBe(`Basic ${btoa('admin:secret')}`);
  });

  it('maps a 401 to auth and omits Authorization without credentials', async () => {
    fake.credentials = { username: 'admin', password: 'secret' };
    await expectError(client().test(), 'auth');
    expect(fake.requests[0]?.headers.get('authorization')).toBeNull();
    await expectError(client({ username: 'admin', password: 'wrong' }).test(), 'auth');
  });

  it('uses a custom url base such as the ruTorrent rpc plugin', async () => {
    fake = new FakeRTorrent(torrentsFixture, '/plugins/rpc/rpc.php');
    await client({ urlBase: '/plugins/rpc/rpc.php', useSsl: true, port: 443 }).getStatus();
    expect(fake.urls[0]).toBe('https://192.168.1.20:443/plugins/rpc/rpc.php');
  });

  it('maps network failures, wrong endpoints and non-XML replies', async () => {
    fake.networkError = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    const unreachable = await expectError(client().test(), 'unreachable');
    expect(unreachable.message).toContain('ECONNREFUSED');
    fake.networkError = undefined;

    await expectError(client({ urlBase: 'wrong' }).test(), 'not-found');

    fake.once('POST', '/RPC2', { body: responses.htmlLoginPage, headers: { 'content-type': 'text/html' } });
    const bad = await expectError(client().test(), 'bad-response');
    expect(bad.message).toContain('XML-RPC');
  });

  it('maps faults: unknown hash to not-found, missing method to bad-response, others to rejected', async () => {
    await expectError(client().pause('0'.repeat(40)), 'not-found');
    fake.once('POST', '/RPC2', { body: responses.faultNoMethod });
    const missing = await expectError(client().getItems('tv'), 'bad-response');
    expect(missing.message).toContain('0.9.6');
    fake.once('POST', '/RPC2', { body: '<methodResponse><fault><value><struct><member><name>faultCode</name><value><i4>-503</i4></value></member><member><name>faultString</name><value>Wrong object type.</value></member></struct></value></fault></methodResponse>' });
    const rejected = await expectError(client().getItems('tv'), 'rejected');
    expect(rejected.message).toContain('Wrong object type.');
  });

  it('rejects a multicall row of the wrong shape as bad-response', async () => {
    fake.once('POST', '/RPC2', { body: '<methodResponse><params><param><value><array><data><value><array><data><value>x</value></data></array></value></data></array></value></param></params></methodResponse>' });
    await expectError(client().getItems(''), 'bad-response');
  });
});

describe('test()', () => {
  it('reports client and library versions and warns without a label', async () => {
    expect(await client().test()).toEqual({ version: '0.9.8', apiVersion: '0.13.8', warnings: [] });
    const result = await client({ category: '' }).test();
    expect(result.warnings.join(' ')).toMatch(/No label/);
    expect(fake.callsTo('directory.default')).toHaveLength(2);
    expect(fake.callsTo('d.multicall2')).toHaveLength(2);
  });

  it('warns about rTorrent older than 0.9.6 without calling d.multicall2', async () => {
    fake.clientVersion = '0.9.4';
    fake.libraryVersion = '0.13.4';
    const result = await client().test();
    expect(result.version).toBe('0.9.4');
    expect(result.warnings.join(' ')).toMatch(/0\.9\.6/);
    expect(fake.callsTo('d.multicall2')).toHaveLength(0);
  });
});

describe('addTorrent', () => {
  it('loads a torrent file with load.raw_start, label, directory and priority commands', async () => {
    const result = await client({ recentPriority: 'high' }).addTorrent({
      torrentFile: V1_TORRENT,
      title: 'Show.S01E01',
      category: 'TV Shows',
      savePath: '/data/my downloads, tv',
      isRecent: true,
    });
    expect(result).toEqual({ id: V1_TORRENT_HASH, warnings: [] });
    const load = fake.callsTo('load.raw_start')[0];
    expect(load?.params[0]).toBe('');
    expect(load?.params[1]).toEqual(V1_TORRENT);
    expect(load?.params.slice(2)).toEqual([
      'd.custom1.set="TV%20Shows"',
      'd.directory.set="/data/my downloads, tv"',
      'd.priority.set=3',
    ]);
    const stored = fake.torrents.get(V1_TORRENT_HASH.toUpperCase());
    expect(stored?.['d.custom1']).toBe('TV%20Shows');
    expect(stored?.['d.directory']).toBe('/data/my downloads, tv');
  });

  it('loads a magnet with load.start, or load.normal when paused, and falls back to the settings directory', async () => {
    const result = await client({ directory: '/data/tv', addPaused: true }).addTorrent({ magnet: MAGNET, title: 't', category: 'tv' });
    expect(result.id).toBe(MAGNET_HASH);
    const load = fake.callsTo('load.normal')[0];
    expect(load?.params).toEqual(['', MAGNET, 'd.custom1.set="tv"', 'd.directory.set="/data/tv"']);
    fake.torrents.clear();
    await client().addTorrent({ magnet: MAGNET, title: 't', category: '', paused: false });
    expect(fake.callsTo('load.start')[0]?.params).toEqual(['', MAGNET]);
  });

  it('uses load.raw for a paused torrent file and warns that seed limits are not supported', async () => {
    const result = await client().addTorrent({
      torrentFile: V1_TORRENT,
      title: 't',
      category: 'tv',
      paused: true,
      seedRatioLimit: 1,
    });
    expect(fake.callsTo('load.raw')).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/seed limits/);
  });

  it('polls d.hash until the torrent appears', async () => {
    fake.appearAfterPolls = 3;
    const result = await client().addTorrent({ magnet: MAGNET, title: 't', category: 'tv' });
    expect(result.id).toBe(MAGNET_HASH);
    expect(fake.callsTo('d.hash')).toHaveLength(4);
    expect(sleeps).toEqual([250, 250, 250]);
  });

  it('reports rejected when rTorrent silently drops the torrent, or the input is invalid', async () => {
    fake.dropLoads = true;
    const dropped = await expectError(client().addTorrent({ torrentFile: V1_TORRENT, title: 't', category: 'tv' }), 'rejected');
    expect(dropped.message).toContain(V1_TORRENT_HASH);
    expect(fake.callsTo('d.hash')).toHaveLength(10);
    await expectError(client().addTorrent({ title: 't', category: 'tv' }), 'rejected');
    await expectError(client().addTorrent({ magnet: 'magnet:?dn=nohash', title: 't', category: 'tv' }), 'rejected');
    await expectError(client().addTorrent({ torrentFile: new TextEncoder().encode('garbage'), title: 't', category: 'tv' }), 'rejected');
  });

  it('does not support NZBs', async () => {
    await expectError(client().addNzb(), 'not-supported');
  });
});

describe('getItems', () => {
  it('lists only the requested label (decoding ruTorrent URI-encoded labels) with lowercase ids', async () => {
    const tv = await client().getItems('tv');
    expect(tv).toHaveLength(8);
    expect(tv.every((i) => i.category === 'tv' && i.id === i.id.toLowerCase())).toBe(true);
    const uhd = await client().getItems('Movies UHD');
    expect(uhd.map((i) => i.id)).toEqual(['9'.repeat(40)]);
    expect(await client().getItems('')).toHaveLength(10);
    const call = fake.callsTo('d.multicall2')[0];
    expect(call?.params.slice(0, 3)).toEqual(['', 'main', 'd.hash=']);
  });

  it('maps the fixture states', async () => {
    const items = await client().getItems('tv');
    const byId = new Map(items.map((i) => [i.id.charAt(0), i]));
    expect(byId.get('1')).toMatchObject({ status: 'downloading', progress: 0.6, etaSeconds: 4, outputPath: '/downloads/Show.S01E01.1080p.WEB-DL' });
    expect(byId.get('2')?.status).toBe('paused');
    expect(byId.get('3')).toMatchObject({ status: 'paused', outputPath: '/downloads/Show.S01E03.720p.HDTV.mkv' });
    expect(byId.get('4')).toMatchObject({ status: 'seeding', isReadOnly: true, canBeRemoved: false, etaSeconds: 0 });
    expect(byId.get('5')).toMatchObject({
      status: 'completed',
      isReadOnly: false,
      canBeRemoved: true,
      canMoveFiles: true,
      outputPath: '/downloads/Show.S02E01.1080p.WEB-DL',
    });
    expect(byId.get('6')).toMatchObject({ status: 'queued', statusMessage: 'rTorrent is checking the data' });
    expect(byId.get('7')).toMatchObject({ status: 'warning' });
    expect(byId.get('7')?.statusMessage).toContain('not registered');
    expect(byId.get('8')).toMatchObject({ status: 'queued', statusMessage: 'Downloading metadata' });
  });
});

describe('remove, label, pause and resume', () => {
  const ID = '5'.repeat(40);

  it('removes with d.erase only, or flags d.custom5 for erasedata first', async () => {
    await client().removeItem(ID, false);
    expect(fake.callsTo('d.custom5.set')).toHaveLength(0);
    expect(fake.callsTo('d.erase')[0]?.params).toEqual([ID]);
    expect(fake.torrents.has(ID)).toBe(false);

    const other = '4'.repeat(40);
    await client().removeItem(other, true);
    expect(fake.callsTo('d.custom5.set')[0]?.params).toEqual([other, '1']);
    expect(fake.rpcCalls.map((c) => c.method).slice(-2)).toEqual(['d.custom5.set', 'd.erase']);
    await expectError(client().removeItem(other, false), 'not-found');
  });

  it('sets the label with d.custom1.set, URI-encoded', async () => {
    await client().setCategory('a'.repeat(40), 'tv imported');
    expect(fake.callsTo('d.custom1.set')[0]?.params).toEqual(['A'.repeat(40), 'tv%20imported']);
    expect(fake.torrents.get('A'.repeat(40))?.['d.custom1']).toBe('tv%20imported');
  });

  it('pauses with d.pause and resumes with d.start + d.resume', async () => {
    const id = '1'.repeat(40);
    await client().pause(id);
    expect((await client().getItems('tv')).find((i) => i.id === id)?.status).toBe('paused');
    await client().resume(id);
    expect(fake.rpcCalls.map((c) => c.method).filter((m) => m.startsWith('d.') && m !== 'd.multicall2')).toEqual([
      'd.pause',
      'd.start',
      'd.resume',
    ]);
    expect((await client().getItems('tv')).find((i) => i.id === id)?.status).toBe('downloading');
  });
});

describe('getStatus', () => {
  it('uses directory.default unless a directory is configured', async () => {
    expect(await client().getStatus()).toEqual({ outputRootDir: '/downloads', isLocalhost: false, removesCompletedDownloads: false });
    const local = await client({ host: '127.0.0.1', directory: '/data/tv' }).getStatus();
    expect(local).toEqual({ outputRootDir: '/data/tv', isLocalhost: true, removesCompletedDownloads: false });
  });
});

describe('helpers', () => {
  it('quotes command arguments and the fake parses them back', () => {
    expect(quoteCommandArg('C:\\dl\\"x"')).toBe('"C:\\\\dl\\\\\\"x\\""');
    expect(parseLoadCommand(`d.directory.set=${quoteCommandArg('C:\\dl\\"x"')}`)).toEqual({ field: 'd.directory', value: 'C:\\dl\\"x"' });
  });
});
