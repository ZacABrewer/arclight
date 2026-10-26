import { beforeEach, describe, expect, it } from 'vitest';
import configFixture from '../../fixtures/sabnzbd/get-config.json' with { type: 'json' };
import historyFixture from '../../fixtures/sabnzbd/history.json' with { type: 'json' };
import queueFixture from '../../fixtures/sabnzbd/queue.json' with { type: 'json' };
import versionFixture from '../../fixtures/sabnzbd/version.json' with { type: 'json' };
import { DownloadClientError, type ClientRuntime } from '../types.js';
import { SabnzbdClient } from './client.js';
import { FakeSabnzbd, type FakeConfig, type FakeHistorySlot, type FakeQueueSlot } from './fake-sabnzbd.js';
import { SabnzbdSettings, type SabnzbdSettingsInput } from './settings.js';

const FIXED = 1_761_400_000_000;
const NZB = new TextEncoder().encode(
  '<?xml version="1.0" encoding="UTF-8"?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file subject="x"></file></nzb>',
);

let sab: FakeSabnzbd;

function runtime(): ClientRuntime {
  return { fetch: sab.fetch, now: () => FIXED, sleep: async () => {}, requestTimeoutMs: 1000 };
}

function client(overrides: Partial<SabnzbdSettingsInput> = {}): SabnzbdClient {
  return new SabnzbdClient(
    SabnzbdSettings.parse({ host: '192.168.1.30', apiKey: 'abc123apikey', ...overrides }),
    runtime(),
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
  sab = new FakeSabnzbd();
  sab.version = versionFixture.version;
  sab.loadQueue(queueFixture as { queue: { paused: boolean; slots: FakeQueueSlot[] } });
  sab.loadHistory(historyFixture as unknown as { history: { slots: FakeHistorySlot[] } });
  sab.loadConfig(configFixture as { config: FakeConfig });
});

describe('settings', () => {
  it('applies defaults', () => {
    expect(SabnzbdSettings.parse({ host: 'nas' })).toEqual({
      host: 'nas',
      port: 8080,
      useSsl: false,
      apiKey: '',
      username: '',
      password: '',
      category: 'arclight',
      recentPriority: 'default',
      olderPriority: 'default',
    });
    expect(() => SabnzbdSettings.parse({ host: 'nas', recentPriority: 'urgent' })).toThrow();
  });
});

describe('authentication and transport', () => {
  it('sends apikey and output=json on every call, honouring https and urlBase', async () => {
    sab.stripPrefix = '/sabnzbd';
    await client({ useSsl: true, urlBase: '/sabnzbd/' }).getItems('arclight');
    expect(sab.urls.length).toBe(2);
    for (const href of sab.urls) {
      const url = new URL(href);
      expect(url.origin + url.pathname).toBe('https://192.168.1.30:8080/sabnzbd/api');
      expect(url.searchParams.get('apikey')).toBe('abc123apikey');
      expect(url.searchParams.get('output')).toBe('json');
    }
    const history = sab.modeCalls('history')[0];
    expect(history?.query.get('category')).toBe('arclight');
    expect(history?.query.get('limit')).toBe('60');
  });

  it('maps "API Key Incorrect", "API Key Required" and the NZB-only key to auth', async () => {
    const wrong = await expectError(client({ apiKey: 'nope' }).getItems(''), 'auth');
    expect(wrong.message).toMatch(/API Key Incorrect/);
    await expectError(client({ apiKey: '', username: 'x', password: 'y' }).getItems(''), 'auth');
    // The NZB key may add files but not read the queue.
    await expectError(client({ apiKey: 'nzbkey456' }).getItems(''), 'auth');
    // Plain-text error form.
    sab.onceMode('queue', { body: 'error: API Key Required\n' });
    await expectError(client().getItems(''), 'auth');
  });

  it('falls back to legacy ma_username/ma_password when no API key is set', async () => {
    sab.username = 'admin';
    sab.password = 'secret';
    const items = await client({ apiKey: '', username: 'admin', password: 'secret' }).getItems('arclight');
    expect(items.length).toBeGreaterThan(0);
    const call = sab.modeCalls('queue')[0];
    expect(call?.query.get('ma_username')).toBe('admin');
    expect(call?.query.get('ma_password')).toBe('secret');
    expect(call?.query.has('apikey')).toBe(false);
  });

  it('is stateless: a key fixed between calls works immediately (no session to renew)', async () => {
    sab.apiKey = 'rotated';
    await expectError(client().getItems(''), 'auth');
    sab.apiKey = 'abc123apikey';
    await expect(client().getItems('')).resolves.toBeInstanceOf(Array);
  });
});

describe('error mapping', () => {
  it('maps network failures and timeouts to unreachable', async () => {
    sab.networkError = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 192.168.1.30:8080') });
    const refused = await expectError(client().getStatus(), 'unreachable');
    expect(refused.message).toMatch(/ECONNREFUSED/);
    sab.networkError = new DOMException('timeout', 'TimeoutError');
    expect((await expectError(client().getStatus(), 'unreachable')).message).toMatch(/timed out/);
  });

  it('maps invalid JSON, wrong shapes and HTTP errors to bad-response / not-found / auth', async () => {
    sab.onceMode('queue', { body: '<html>login</html>' });
    await expectError(client().getItems(''), 'bad-response');
    sab.onceMode('queue', { body: { queue: { slots: [{ nzo_id: 1 }] } } });
    await expectError(client().getItems(''), 'bad-response');
    sab.onceMode('get_config', { status: 500, body: 'Internal error' });
    expect((await expectError(client().getStatus(), 'bad-response')).httpStatus).toBe(500);
    sab.onceMode('get_config', { status: 404, body: '' });
    await expectError(client().getStatus(), 'not-found');
    sab.onceMode('get_config', { status: 403, body: 'Access denied' });
    await expectError(client().getStatus(), 'auth');
  });

  it('maps other SAB errors to rejected', async () => {
    sab.onceMode('change_cat', { body: { status: false, error: 'Unknown category' } });
    const e = await expectError(client().setCategory('SABnzbd_nzo_q1w2e3', 'nope'), 'rejected');
    expect(e.message).toMatch(/Unknown category/);
  });
});

describe('addNzb', () => {
  it('uploads the NZB as multipart field "name" with cat, priority and nzbname', async () => {
    const result = await client().addNzb({ nzb: NZB, title: 'Show: Name S01E01', category: 'arclight' });
    expect(result).toEqual({ id: 'SABnzbd_nzo_fake1', warnings: [] });
    const call = sab.modeCalls('addfile')[0];
    expect(call?.method).toBe('POST');
    expect(call?.files[0]?.field).toBe('name');
    expect(call?.files[0]?.filename).toBe('Show_ Name S01E01.nzb');
    expect(sab.uploads[0]).toMatchObject({ cat: 'arclight', priority: '-100', nzbname: 'Show: Name S01E01' });
    expect(sab.uploads[0]?.text).toContain('<nzb');
    const items = await client().getItems('arclight');
    expect(items.find((i) => i.id === 'SABnzbd_nzo_fake1')?.status).toBe('queued');
  });

  it('picks recent/older priority settings, and an explicit UsenetPriority overrides them', async () => {
    const c = client({ recentPriority: 'force', olderPriority: 'low' });
    await c.addNzb({ nzb: NZB, title: 'a', category: 'arclight', isRecent: true });
    await c.addNzb({ nzb: NZB, title: 'b', category: 'arclight' });
    await c.addNzb({ nzb: NZB, title: 'c', category: '', priority: 'veryHigh' });
    await c.addNzb({ nzb: NZB, title: 'd', category: '', priority: 'veryLow' });
    expect(sab.uploads.map((u) => u.priority)).toEqual(['2', '-1', '1', '-1']);
    expect(sab.uploads[2]?.cat).toBeUndefined();
  });

  it('works with the NZB-only key, rejects an empty nzo_ids, and refuses torrents', async () => {
    await expect(client({ apiKey: 'nzbkey456' }).addNzb({ nzb: NZB, title: 'x', category: '' })).resolves.toMatchObject({
      id: 'SABnzbd_nzo_fake1',
    });
    sab.onceMode('addfile', { body: { status: true, nzo_ids: [] } });
    await expectError(client().addNzb({ nzb: NZB, title: 'x', category: '' }), 'rejected');
    await expectError(
      client().addNzb({ nzb: new TextEncoder().encode('garbage'), title: 'x', category: '' }),
      'rejected',
    );
    await expectError(client().addTorrent(), 'not-supported');
  });
});

describe('getItems', () => {
  it('merges queue and history for the category with the documented state mapping', async () => {
    const items = await client().getItems('arclight');
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(Object.keys(byId)).not.toContain('SABnzbd_nzo_other1');
    expect(Object.keys(byId)).not.toContain('SABnzbd_nzo_other2');
    expect(
      Object.fromEntries(items.map((i) => [i.id, i.status])),
    ).toEqual({
      SABnzbd_nzo_p86tgx: 'downloading',
      SABnzbd_nzo_q1w2e3: 'queued',
      SABnzbd_nzo_paused1: 'paused',
      SABnzbd_nzo_grab01: 'queued',
      SABnzbd_nzo_prop01: 'queued',
      SABnzbd_nzo_done01: 'completed',
      SABnzbd_nzo_fail01: 'failed',
      SABnzbd_nzo_script1: 'warning',
      SABnzbd_nzo_repair1: 'downloading',
      SABnzbd_nzo_unpack1: 'downloading',
      SABnzbd_nzo_disk01: 'warning',
    });
    expect(byId['SABnzbd_nzo_p86tgx']).toMatchObject({
      title: 'Show.Name.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP',
      totalBytes: Math.round(1277.65 * 1024 * 1024),
      remainingBytes: Math.round(830.47 * 1024 * 1024),
      etaSeconds: 65,
      outputPath: '',
      canBeRemoved: false,
    });
    expect(byId['SABnzbd_nzo_done01']).toMatchObject({
      outputPath: '/downloads/complete/arclight/Show.Name.S00E01.1080p.WEB-DL-GRP',
      totalBytes: 2254857830,
      canMoveFiles: true,
      canBeRemoved: true,
      isReadOnly: false,
    });
    expect(byId['SABnzbd_nzo_fail01']?.statusMessage).toMatch(/not-complete/);
    expect(byId['SABnzbd_nzo_repair1']?.statusMessage).toBe('Post-processing (Repairing)');
  });

  it('reports every queue item as paused while the whole queue is paused, and lists all with ""', async () => {
    sab.queuePaused = true;
    const items = await client().getItems('');
    expect(items).toHaveLength(13);
    const queued = items.filter((i) => i.id.startsWith('SABnzbd_nzo_') && i.outputPath === '' && i.progress < 1);
    expect(queued.every((i) => i.status === 'paused')).toBe(true);
    expect(sab.modeCalls('history')[0]?.query.has('category')).toBe(false);
  });
});

describe('remove, category, pause/resume', () => {
  it('removes a queued job via the queue, without deleting data', async () => {
    await client().removeItem('SABnzbd_nzo_q1w2e3', false);
    const del = sab.modeCalls('queue', 'delete');
    expect(del).toHaveLength(1);
    expect(del[0]?.query.get('del_files')).toBe('0');
    expect(sab.modeCalls('history', 'delete')).toHaveLength(0);
    expect(sab.queue.some((s) => s.nzo_id === 'SABnzbd_nzo_q1w2e3')).toBe(false);
  });

  it('falls back to history delete (with data) when the job is not queued', async () => {
    await client().removeItem('SABnzbd_nzo_done01', true);
    const del = sab.modeCalls('history', 'delete');
    expect(del).toHaveLength(1);
    expect(del[0]?.query.get('value')).toBe('SABnzbd_nzo_done01');
    expect(del[0]?.query.get('del_files')).toBe('1');
    expect(del[0]?.query.get('archive')).toBe('0');
    expect(sab.history.some((s) => s.nzo_id === 'SABnzbd_nzo_done01')).toBe(false);
  });

  it('changes the category with change_cat ("" becomes "*")', async () => {
    await client().setCategory('SABnzbd_nzo_q1w2e3', 'imported');
    expect(sab.queue.find((s) => s.nzo_id === 'SABnzbd_nzo_q1w2e3')?.cat).toBe('imported');
    await client().setCategory('SABnzbd_nzo_q1w2e3', '');
    expect(sab.modeCalls('change_cat')[1]?.query.get('value2')).toBe('*');
  });

  it('pauses and resumes a single job', async () => {
    await client().pause('SABnzbd_nzo_q1w2e3');
    expect(sab.queue.find((s) => s.nzo_id === 'SABnzbd_nzo_q1w2e3')?.status).toBe('Paused');
    expect(sab.modeCalls('queue', 'pause')[0]?.query.get('value')).toBe('SABnzbd_nzo_q1w2e3');
    await client().resume('SABnzbd_nzo_q1w2e3');
    expect(sab.queue.find((s) => s.nzo_id === 'SABnzbd_nzo_q1w2e3')?.status).toBe('Queued');
  });
});

describe('getStatus', () => {
  it('resolves the category folder against complete_dir and reports retention', async () => {
    expect(await client().getStatus()).toEqual({
      outputRootDir: '/downloads/complete/arclight',
      isLocalhost: false,
      removesCompletedDownloads: false,
    });
    expect((await client({ category: 'software', host: '127.0.0.1' }).getStatus())).toEqual({
      outputRootDir: '/mnt/software',
      isLocalhost: true,
      removesCompletedDownloads: false,
    });
    expect((await client({ category: 'uhd' }).getStatus()).outputRootDir).toBe('D:\\Media\\UHD');
    expect((await client({ category: '' }).getStatus()).outputRootDir).toBe('/downloads/complete');
    sab.config.misc['history_retention_option'] = 'days-delete';
    expect((await client().getStatus()).removesCompletedDownloads).toBe(true);
  });
});

describe('test()', () => {
  it('returns the version with no warnings for a healthy setup', async () => {
    expect(await client().test()).toEqual({ version: '4.3.3', apiVersion: 'api', warnings: [] });
  });

  it('warns about an old version, a missing category, no complete_dir and history removal', async () => {
    sab.version = '2.3.9';
    sab.config.categories = sab.config.categories.filter((c) => c.name !== 'arclight');
    sab.config.misc['complete_dir'] = '';
    sab.config.misc['history_retention_option'] = 'number-delete';
    const result = await client().test();
    expect(result.warnings).toHaveLength(4);
    expect(result.warnings.join('\n')).toMatch(/2\.3\.9 is old/);
    expect(result.warnings.join('\n')).toMatch(/no category "arclight"/);
    expect(result.warnings.join('\n')).toMatch(/completed download folder/);
    expect(result.warnings.join('\n')).toMatch(/History Retention/);
  });

  it('rejects ancient versions, a missing key and a wrong key', async () => {
    sab.version = '0.7.20';
    await expectError(client().test(), 'bad-response');
    sab.version = '4.3.3';
    await expectError(client({ apiKey: '' }).test(), 'auth');
    await expectError(client({ apiKey: 'wrong' }).test(), 'auth');
    // Unparseable development versions are accepted.
    sab.version = 'develop';
    expect((await client().test()).version).toBe('develop');
  });
});
