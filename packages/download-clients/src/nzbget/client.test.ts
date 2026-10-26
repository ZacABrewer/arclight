import { beforeEach, describe, expect, it } from 'vitest';
import configFixture from '../../fixtures/nzbget/config.json' with { type: 'json' };
import historyFixture from '../../fixtures/nzbget/history.json' with { type: 'json' };
import groupsFixture from '../../fixtures/nzbget/listgroups.json' with { type: 'json' };
import statusFixture from '../../fixtures/nzbget/status.json' with { type: 'json' };
import { fromBase64 } from '../http.js';
import { DownloadClientError, type ClientRuntime } from '../types.js';
import { NzbgetClient } from './client.js';
import { FakeNzbget } from './fake-nzbget.js';
import { NzbgetSettings, type NzbgetSettingsInput } from './settings.js';

const FIXED = 1_761_400_000_000;
const NZB = new TextEncoder().encode('<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"></nzb>');

let fake: FakeNzbget;

function client(overrides: Partial<NzbgetSettingsInput> = {}): NzbgetClient {
  const runtime: ClientRuntime = { fetch: fake.fetch, now: () => FIXED, sleep: async () => {}, requestTimeoutMs: 1000 };
  return new NzbgetClient(NzbgetSettings.parse({ host: '192.168.1.30', password: 'tegbzn6789', ...overrides }), runtime);
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
  fake = new FakeNzbget({ config: configFixture, groups: groupsFixture, history: historyFixture, status: statusFixture });
});

describe('settings', () => {
  it('applies defaults', () => {
    expect(NzbgetSettings.parse({ host: 'nas' })).toEqual({
      host: 'nas',
      port: 6789,
      useSsl: false,
      username: 'nzbget',
      password: '',
      category: 'media-tron',
      recentPriority: 'normal',
      olderPriority: 'normal',
      addPaused: false,
    });
    expect(() => NzbgetSettings.parse({ host: 'nas', recentPriority: 'urgent' })).toThrow();
  });
});

describe('transport and auth', () => {
  it('posts JSON-RPC to <base>/jsonrpc with Basic auth, honouring urlBase and SSL', async () => {
    fake.stripPrefix = '/nzbget';
    const c = client({ urlBase: '/nzbget/', useSsl: true, port: 443 });
    await c.getStatus();
    expect(fake.urls[0]).toBe('https://192.168.1.30:443/nzbget/jsonrpc');
    const request = fake.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe(`Basic ${btoa('nzbget:tegbzn6789')}`);
    expect(JSON.parse(request.bodyText)).toMatchObject({ method: 'config', params: [] });
  });

  it('maps HTTP 401 to an auth error', async () => {
    const error = await expectError(client({ password: 'wrong' }).test(), 'auth');
    expect(error.httpStatus).toBe(401);
  });

  it('maps network failures to unreachable', async () => {
    fake.networkError = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 192.168.1.30:6789') });
    const error = await expectError(client().getItems('media-tron'), 'unreachable');
    expect(error.message).toContain('ECONNREFUSED');
  });

  it('maps garbage, bad shapes and unknown procedures', async () => {
    fake.once('POST', '/jsonrpc', { body: '<html>proxy error</html>' });
    await expectError(client().getStatus(), 'bad-response');
    fake.onceRpc('config', () => ({ not: 'an array' }));
    await expectError(client().getStatus(), 'bad-response');
    fake.onceRpc('config', () => {
      throw new Error('Invalid procedure');
    });
    await expectError(client().getStatus(), 'not-found');
    fake.once('POST', '/jsonrpc', { status: 500, body: 'Internal error' });
    await expectError(client().getStatus(), 'bad-response');
  });
});

describe('test()', () => {
  it('returns the version with no warnings for a healthy setup', async () => {
    expect(await client().test()).toEqual({ version: '24.3', apiVersion: 'jsonrpc', warnings: [] });
  });

  it('warns about a missing category and KeepHistory = 0', async () => {
    fake.setOption('KeepHistory', '0');
    const result = await client({ category: 'tv', postImportCategory: 'nope' }).test();
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toContain('Category "tv" does not exist');
    expect(result.warnings[1]).toContain('Post-import category "nope"');
    expect(result.warnings[2]).toContain('KeepHistory');
  });

  it('rejects NZBGet versions older than 16', async () => {
    fake.version = '15.0';
    const error = await expectError(client().test(), 'bad-response');
    expect(error.message).toContain('16 or newer');
  });
});

describe('addNzb', () => {
  it('appends with the v16+ signature, base64 content and the recent priority', async () => {
    const result = await client({ recentPriority: 'veryHigh', addPaused: true }).addNzb({
      nzb: NZB,
      title: 'Show.S01E09.1080p.WEB.h264-GRP',
      category: 'media-tron',
      isRecent: true,
    });
    expect(result).toEqual({ id: '100', warnings: [] });
    const call = fake.callsTo('append')[0]!;
    expect(call.params).toHaveLength(10);
    const appended = fake.appended[0]!;
    expect(appended).toMatchObject({
      filename: 'Show.S01E09.1080p.WEB.h264-GRP.nzb',
      category: 'media-tron',
      priority: 100,
      addToTop: false,
      addPaused: true,
      dupeKey: '',
      dupeScore: 0,
      dupeMode: 'SCORE',
      ppParameters: [],
    });
    expect(fromBase64(appended.content)).toEqual(NZB);
  });

  it('uses an explicit priority over the configured ones and the older priority by default', async () => {
    await client({ olderPriority: 'low' }).addNzb({ nzb: NZB, title: 'a', category: 'media-tron' });
    await client().addNzb({ nzb: NZB, title: 'b', category: 'media-tron', priority: 'force' });
    expect(fake.appended.map((a) => a.priority)).toEqual([-50, 900]);
  });

  it('treats a non-positive NZBID as rejected and refuses torrents', async () => {
    fake.nextId = 0;
    await expectError(client().addNzb({ nzb: NZB, title: 'x', category: 'media-tron' }), 'rejected');
    await expectError(client().addTorrent(), 'not-supported');
    expect(client().protocol).toBe('usenet');
  });
});

describe('getItems', () => {
  it('lists queue and history for the category, skipping hidden duplicates', async () => {
    const items = await client().getItems('media-tron');
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(items.map((i) => i.id)).toEqual(['11', '12', '13', '14', '16', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30']);
    expect(byId.get('11')).toMatchObject({ status: 'downloading', etaSeconds: 204 });
    expect(byId.get('12')).toMatchObject({ status: 'queued', etaSeconds: 307 });
    expect(byId.get('13')?.status).toBe('paused');
    expect(byId.get('14')).toMatchObject({ status: 'downloading', statusMessage: 'Post-processing: unpacking', canBeRemoved: false });
    expect(byId.get('16')).toMatchObject({ status: 'queued', statusMessage: 'Fetching the NZB file' });
    expect(byId.get('21')).toMatchObject({ status: 'completed', canBeRemoved: true, canMoveFiles: true });
    expect(byId.get('22')?.outputPath).toBe('/mnt/tv-staging/Show.S01E02');
    expect(byId.get('23')?.status).toBe('warning');
    expect(byId.get('24')).toMatchObject({ status: 'failed', statusMessage: 'Par check/repair failed' });
    expect(byId.get('25')).toMatchObject({ status: 'failed', statusMessage: 'Unpacking failed' });
    expect(byId.get('26')?.status).toBe('failed');
    expect(byId.get('27')?.status).toBe('warning');
    expect(byId.get('28')?.status).toBe('warning');
    expect(byId.get('29')?.status).toBe('failed');
    expect(byId.get('30')?.status).toBe('failed');
    expect(fake.callsTo('listgroups')[0]?.params).toEqual([0]);
    expect(fake.callsTo('history')[0]?.params).toEqual([false]);
  });

  it('matches categories case-insensitively, returns all for empty, and honours global pause', async () => {
    expect((await client().getItems('MOVIES')).map((i) => i.id)).toEqual(['15', '32']);
    expect(await client().getItems('')).toHaveLength(17);
    fake.status['DownloadPaused'] = true;
    const items = await client().getItems('media-tron');
    expect(items.find((i) => i.id === '11')).toMatchObject({ status: 'paused', statusMessage: 'NZBGet downloading is paused' });
    expect(items.find((i) => i.id === '11')?.etaSeconds).toBeUndefined();
  });
});

describe('removeItem', () => {
  it('deletes queue items with GroupFinalDelete or GroupDelete', async () => {
    await client().removeItem('12', true);
    await client().removeItem('13', false);
    expect(fake.callsTo('editqueue').map((c) => c.params)).toEqual([
      ['GroupFinalDelete', '', [12]],
      ['GroupDelete', '', [13]],
    ]);
    expect(fake.groups.some((g) => g.NZBID === 12 || g.NZBID === 13)).toBe(false);
    expect(fake.history[0]).toMatchObject({ NZBID: 13, Status: 'DELETED/MANUAL' });
  });

  it('deletes history items with HistoryFinalDelete or HistoryDelete', async () => {
    await client().removeItem('21', true);
    await client().removeItem('22', false);
    expect(fake.callsTo('editqueue').map((c) => c.params)).toEqual([
      ['HistoryFinalDelete', '', [21]],
      ['HistoryDelete', '', [22]],
    ]);
  });

  it('reports unknown ids as not-found and a false result as rejected', async () => {
    await expectError(client().removeItem('999', true), 'not-found');
    await expectError(client().removeItem('abc', true), 'not-found');
    fake.onceRpc('editqueue', () => false);
    await expectError(client().removeItem('21', true), 'rejected');
  });
});

describe('category, pause and resume', () => {
  it('applies a category to queue items and sets it on history items', async () => {
    await client().setCategory('12', 'tv-imported');
    await client().setCategory('21', 'tv-imported');
    expect(fake.callsTo('editqueue').map((c) => c.params)).toEqual([
      ['GroupApplyCategory', 'tv-imported', [12]],
      ['HistorySetCategory', 'tv-imported', [21]],
    ]);
    expect(fake.history.find((h) => h.NZBID === 21)?.['Category']).toBe('tv-imported');
  });

  it('pauses and resumes groups', async () => {
    const c = client();
    await c.pause('12');
    expect(fake.groups.find((g) => g.NZBID === 12)?.['Status']).toBe('PAUSED');
    await c.resume('12');
    expect(fake.groups.find((g) => g.NZBID === 12)?.['Status']).toBe('QUEUED');
    await expectError(c.pause('999'), 'rejected');
    // version is looked up once and cached
    expect(fake.callsTo('version')).toHaveLength(1);
  });

  it('uses the pre-18 editqueue signature with an Offset on older NZBGet', async () => {
    fake.version = '17.1';
    await client().pause('12');
    expect(fake.callsTo('editqueue')[0]?.params).toEqual(['GroupPause', 0, '', [12]]);
  });
});

describe('getStatus', () => {
  it('resolves the category directory through AppendCategoryDir and ${MainDir}', async () => {
    expect(await client().getStatus()).toEqual({
      outputRootDir: '/downloads/completed/media-tron',
      isLocalhost: false,
      removesCompletedDownloads: false,
    });
    expect((await client({ category: 'tv-imported' }).getStatus()).outputRootDir).toBe('/downloads/imported');
    expect((await client({ category: 'Movies', host: 'localhost' }).getStatus())).toEqual({
      outputRootDir: '/mnt/movies-dl',
      isLocalhost: true,
      removesCompletedDownloads: false,
    });
  });

  it('reports removesCompletedDownloads when KeepHistory is 0', async () => {
    fake.setOption('KeepHistory', '0');
    expect((await client().getStatus()).removesCompletedDownloads).toBe(true);
  });
});
