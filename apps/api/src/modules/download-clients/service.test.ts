import { describe, expect, it } from 'vitest';
import { PASSWORD_MASK } from '@arclight/shared';
import { mapRemoteToLocal, toDirectoryForm } from './remote-paths.js';
import { DownloadClientsError, STATUS_TEXT, type TrackedDownload } from './service.js';
import { DownloadClientError, item, qbit, setup } from './test-support.js';

/** Every client in these tests is qBittorrent; `builtin` settings have no password. */
const pw = (settings: object): unknown => (settings as { password?: unknown }).password;

describe('download client CRUD', () => {
  it('creates a client with defaults and derives the protocol', async () => {
    const { service } = await setup();
    const created = service.create(qbit('Main'));
    expect(created).toMatchObject({
      id: 1,
      name: 'Main',
      protocol: 'torrent',
      enable: true,
      priority: 1,
      tags: [],
      settings: { host: 'seedbox', port: 8080, category: 'arclight', initialState: 'start' },
    });
    expect(service.list()).toHaveLength(1);
  });

  it('masks the password on every read', async () => {
    const { service } = await setup();
    const created = service.create(qbit('Main'));
    expect(pw(created.settings)).toBe(PASSWORD_MASK);
    expect(pw(service.get(created.id).settings)).toBe(PASSWORD_MASK);
    expect(pw(service.list()[0]!.settings)).toBe(PASSWORD_MASK);
  });

  it('returns an empty password (not the mask) when none is stored', async () => {
    const { service } = await setup();
    const created = service.create(qbit('Main', {}, { password: '' }));
    expect(pw(created.settings)).toBe('');
  });

  it('keeps the stored password when the mask is sent back', async () => {
    const { service, fake } = await setup();
    const created = service.create(qbit('Main'));
    service.update(created.id, qbit('Main', { priority: 3 }, { password: PASSWORD_MASK }));
    expect(pw(fake(created.id).config.settings)).toBe('secret');
    expect(service.get(created.id).priority).toBe(3);
  });

  it('replaces the password when a new one is sent', async () => {
    const { service, fake } = await setup();
    const created = service.create(qbit('Main'));
    service.update(created.id, qbit('Main', {}, { password: 'changed' }));
    expect(pw(fake(created.id).config.settings)).toBe('changed');
  });

  it('rejects duplicate names case-insensitively', async () => {
    const { service } = await setup();
    service.create(qbit('Main'));
    expect(() => service.create(qbit('main'))).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('rejects a protocol the implementation does not support', async () => {
    const { service } = await setup();
    expect(() => service.create(qbit('Main', { protocol: 'usenet' }))).toThrow(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });

  it('rejects out-of-range priority and missing host', async () => {
    const { service } = await setup();
    expect(() => service.create(qbit('A', { priority: 51 }))).toThrow(DownloadClientsError);
    expect(() => service.create(qbit('B', {}, { host: '' }))).toThrow(DownloadClientsError);
  });

  it('throws NOT_FOUND for unknown ids and deletes rows', async () => {
    const { service } = await setup();
    const created = service.create(qbit('Main'));
    service.delete(created.id);
    expect(() => service.get(created.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => service.delete(99)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('caches client instances and rebuilds them when the row changes', async () => {
    const { service, builds } = await setup();
    const created = service.create(qbit('Main'));
    const a = service.clientById(created.id);
    expect(service.clientById(created.id)).toBe(a);
    service.update(created.id, qbit('Main', {}, { port: 9090 }));
    const b = service.clientById(created.id);
    expect(b).not.toBe(a);
    expect(builds()).toBe(2);
  });

  it('tests a candidate config using the stored password when masked', async () => {
    const { service } = await setup();
    const created = service.create(qbit('Main'));
    const result = await service.test({ ...qbit('Main', {}, { password: PASSWORD_MASK }), id: created.id });
    expect(result).toEqual({ ok: true, version: '5.0.2', apiVersion: '2.11.2', warnings: [] });
  });

  it('reports client errors from test as a failed result', async () => {
    const { service } = await setup({
      clientFactory: () => {
        throw new DownloadClientError('auth', 'Invalid username or password');
      },
    });
    const result = await service.test(qbit('Main'));
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'auth', message: 'Invalid username or password' });
  });

  it('exposes implementation schemas with described fields', async () => {
    const { service } = await setup();
    const [qb] = service.schemas();
    expect(qb!.implementation).toBe('qbittorrent');
    expect(qb!.fields.every((f) => f.helpText.length > 0)).toBe(true);
    expect(qb!.fields.map((f) => f.name)).toContain('settings.contentLayout');
  });
});

describe('pickClient', () => {
  it('prefers the lowest priority number', async () => {
    const { service } = await setup();
    service.create(qbit('Low', { priority: 10 }));
    const high = service.create(qbit('High', { priority: 2 }));
    expect(service.pickClient('torrent')?.id).toBe(high.id);
  });

  it('skips disabled clients and other protocols', async () => {
    const { service } = await setup();
    service.create(qbit('Off', { enable: false }));
    expect(service.pickClient('torrent')).toBeNull();
    service.create(qbit('On', { priority: 5 }));
    expect(service.pickClient('usenet')).toBeNull();
    expect(service.pickClient('torrent')?.name).toBe('On');
  });

  it('rotates between clients of equal priority', async () => {
    const { service } = await setup();
    service.create(qbit('A'));
    service.create(qbit('B'));
    const picks = [1, 2, 3].map(() => service.pickClient('torrent')?.name);
    expect(picks).toEqual(['A', 'B', 'A']);
  });

  it('uses tag-matching clients first, untagged clients otherwise', async () => {
    const { service } = await setup();
    service.create(qbit('Anime', { tags: [7], priority: 20 }));
    service.create(qbit('General', { priority: 1 }));
    expect(service.pickClient('torrent', [7])?.name).toBe('Anime');
    expect(service.pickClient('torrent', [3])?.name).toBe('General');
    expect(service.pickClient('torrent')?.name).toBe('General');
  });
});

describe('remote path mappings', () => {
  it('normalises paths to directory form and maps remote to local', async () => {
    const { service } = await setup({ platform: 'win32' });
    const m = await service.createMapping({ host: 'seedbox', remotePath: '/data/complete', localPath: 'D:\\Downloads' });
    expect(m).toMatchObject({ remotePath: '/data/complete/', localPath: 'D:\\Downloads\\' });
    expect(service.remotePathToLocal('SEEDBOX', '/data/complete/Show.S01E01/')).toBe('D:\\Downloads\\Show.S01E01\\');
    expect(service.remotePathToLocal('other', '/data/complete/Show.S01E01/')).toBe('/data/complete/Show.S01E01/');
    expect(service.localPathToRemote('seedbox', 'D:\\Downloads\\Movie\\a.mkv')).toBe('/data/complete/Movie/a.mkv');
  });

  it('validates local paths and uniqueness', async () => {
    let exists = true;
    const { service } = await setup({ directoryExists: async () => exists });
    await expect(service.createMapping({ host: 'h', remotePath: '/r', localPath: 'relative' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(service.createMapping({ host: 'h', remotePath: ' /r', localPath: '/l' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    exists = false;
    await expect(service.createMapping({ host: 'h', remotePath: '/r', localPath: '/l' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    exists = true;
    await service.createMapping({ host: 'h', remotePath: '/r', localPath: '/l' });
    await expect(service.createMapping({ host: 'H', remotePath: '/r/', localPath: '/x' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('updates and deletes mappings; first matching mapping wins', async () => {
    const { service } = await setup();
    const a = await service.createMapping({ host: 'h', remotePath: '/data/', localPath: '/mnt/a' });
    await service.createMapping({ host: 'h', remotePath: '/data/tv/', localPath: '/mnt/tv' });
    expect(service.remotePathToLocal('h', '/data/tv/x')).toBe('/mnt/a/tv/x');
    await service.updateMapping(a.id, { host: 'h', remotePath: '/elsewhere', localPath: '/mnt/a' });
    expect(service.remotePathToLocal('h', '/data/tv/x')).toBe('/mnt/tv/x');
    service.deleteMapping(a.id);
    expect(service.listMappings()).toHaveLength(1);
  });

  it('pure helpers handle the bare directory and Windows remote paths', () => {
    expect(toDirectoryForm('C:/dl')).toBe('C:\\dl\\');
    const mappings = [{ host: 'nas', remotePath: 'C:\\Torrents\\', localPath: '/mnt/torrents/' }];
    expect(mapRemoteToLocal(mappings, 'nas', 'c:\\torrents\\Show\\e1.mkv')).toBe('/mnt/torrents/Show/e1.mkv');
    expect(mapRemoteToLocal(mappings, 'nas', 'C:\\Torrents')).toBe('/mnt/torrents');
  });
});

describe('refreshQueue', () => {
  it('tracks a new item as downloading and maps the output path', async () => {
    const { service, fake } = await setup();
    const c = service.create(qbit('Main'));
    await service.createMapping({ host: 'seedbox', remotePath: '/downloads/', localPath: '/mnt/dl/' });
    fake(c.id).items = [item({ id: 'h1' })];
    const summary = await service.refreshQueue();
    expect(summary).toMatchObject({ clients: 1, items: 1, completed: 0 });
    const page = service.listQueue({ includeUnknownMediaItems: true });
    expect(page.records[0]).toMatchObject({
      downloadId: 'h1',
      downloadClientName: 'Main',
      trackedState: 'downloading',
      status: 'downloading',
      outputPath: '/mnt/dl/Release.h1',
      eta: 60_000,
      sizeBytes: 1000,
      sizeLeftBytes: 500,
    });
  });

  it('moves downloading → importPending on completion and fires the hook once', async () => {
    const { service, fake } = await setup();
    const c = service.create(qbit('Main'));
    const completed: TrackedDownload[] = [];
    service.onItemCompleted((i) => {
      completed.push(i);
    });
    fake(c.id).items = [item({ id: 'h1' })];
    await service.refreshQueue();
    expect(completed).toHaveLength(0);
    fake(c.id).items = [item({ id: 'h1', status: 'seeding', progress: 1, remainingBytes: 0, canMoveFiles: false })];
    await service.refreshQueue();
    await service.refreshQueue();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ downloadId: 'h1', trackedState: 'importPending', remoteOutputPath: '/downloads/Release.h1' });
  });

  it('tracks an item that is already complete as importPending immediately', async () => {
    const { service, fake } = await setup();
    const c = service.create(qbit('Main'));
    let fired = 0;
    service.onItemCompleted(() => {
      fired++;
    });
    fake(c.id).items = [item({ id: 'done', status: 'completed', progress: 1, remainingBytes: 0 })];
    await service.refreshQueue();
    expect(service.listTracked()[0]!.trackedState).toBe('importPending');
    expect(fired).toBe(1);
  });

  it('holds a completed item with an unmappable path and warns about remote path mappings', async () => {
    const { service, fake } = await setup({ platform: 'win32' });
    const c = service.create(qbit('Main'));
    let fired = 0;
    service.onItemCompleted(() => {
      fired++;
    });
    fake(c.id).items = [item({ id: 'h1', status: 'completed' })];
    await service.refreshQueue();
    const [tracked] = service.listTracked();
    expect(fired).toBe(0);
    expect(tracked).toMatchObject({ trackedState: 'downloading', trackedStatus: 'warning' });
    expect(tracked!.statusMessages[0]!.messages[0]).toBe(STATUS_TEXT.invalidLocalPath('/downloads/Release.h1'));

    await service.createMapping({ host: 'seedbox', remotePath: '/downloads', localPath: 'D:\\dl' });
    await service.refreshQueue();
    expect(fired).toBe(1);
    expect(service.listTracked()[0]).toMatchObject({ trackedState: 'importPending', outputPath: 'D:\\dl\\Release.h1' });
  });

  it('surfaces the download client warning text', async () => {
    const { service, fake } = await setup();
    const c = service.create(qbit('Main'));
    fake(c.id).items = [item({ id: 'h1', status: 'warning', statusMessage: 'Tracker unreachable' })];
    await service.refreshQueue();
    const status = service.queueStatus();
    expect(status).toMatchObject({ totalCount: 0, unknownCount: 1, errors: 0, warnings: 1 });
    expect(service.listTracked()[0]!.statusMessages[0]!.messages).toEqual(['Tracker unreachable']);
  });

  it('marks grabbed failed items failedPending and fires onItemFailed', async () => {
    const { service, fake } = await setup();
    const c = service.create(qbit('Main'));
    const failed: TrackedDownload[] = [];
    service.onItemFailed((i) => {
      failed.push(i);
    });
    fake(c.id).nextId = 'grabbed';
    await service.grab(c.id, { title: 'Show.S01E01', magnet: 'magnet:?xt=urn:btih:x' }, { mediaType: 'series', seriesId: 1, episodeIds: [5] });
    fake(c.id).items = [item({ id: 'grabbed', status: 'failed', statusMessage: 'Disk full' }), item({ id: 'stranger', status: 'failed' })];
    await service.refreshQueue();
    expect(failed.map((f) => f.downloadId)).toEqual(['grabbed']);
    expect(failed[0]).toMatchObject({ trackedState: 'failedPending', trackedStatus: 'error', seriesId: 1, episodeIds: [5] });
    const stranger = service.listTracked().find((t) => t.downloadId === 'stranger')!;
    expect(stranger.trackedState).toBe('downloading');
    expect(stranger.statusMessages.flatMap((m) => m.messages)).toContain(STATUS_TEXT.failedNotGrabbed);
  });

  it('flags vanished items and removes them after the grace period', async () => {
    const { service, fake, advance } = await setup({ missingGraceMs: 5 * 60_000 });
    const c = service.create(qbit('Main'));
    fake(c.id).items = [item({ id: 'h1' })];
    await service.refreshQueue();
    fake(c.id).items = [];
    advance(60_000);
    await service.refreshQueue();
    expect(service.listTracked()[0]).toMatchObject({ status: 'unknown', trackedStatus: 'warning' });
    advance(5 * 60_000);
    const summary = await service.refreshQueue();
    expect(summary.removed).toBe(1);
    expect(service.listTracked()).toHaveLength(0);
  });

  it('keeps vanished terminal items until the retention period', async () => {
    const { service, fake, advance } = await setup({ missingGraceMs: 60_000, terminalRetentionMs: 24 * 3600_000 });
    const c = service.create(qbit('Main'));
    fake(c.id).items = [item({ id: 'h1', status: 'completed' })];
    await service.refreshQueue();
    service.setState(service.listTracked()[0]!.id, 'imported');
    fake(c.id).items = [];
    advance(10 * 60_000);
    await service.refreshQueue();
    expect(service.listTracked()).toHaveLength(1);
    advance(24 * 3600_000);
    await service.refreshQueue();
    expect(service.listTracked()).toHaveLength(0);
  });

  it('does not re-process an imported item the client still reports', async () => {
    const { service, fake } = await setup();
    const c = service.create(qbit('Main'));
    let fired = 0;
    service.onItemCompleted(() => {
      fired++;
    });
    fake(c.id).items = [item({ id: 'h1', status: 'seeding' })];
    await service.refreshQueue();
    await service.markImported(service.listTracked()[0]!.id);
    await service.refreshQueue();
    expect(fired).toBe(1);
    expect(service.listTracked()[0]!.trackedState).toBe('imported');
    expect(service.listQueue({ includeUnknownMediaItems: true }).totalRecords).toBe(0);
  });

  it('keeps items of an unreachable client and warns instead of removing them', async () => {
    const { service, fake, advance } = await setup({ missingGraceMs: 1 });
    const c = service.create(qbit('Main'));
    fake(c.id).items = [item({ id: 'h1' })];
    await service.refreshQueue();
    fake(c.id).failGetItems = new DownloadClientError('unreachable', 'connection refused');
    advance(60_000);
    const summary = await service.refreshQueue();
    expect(summary.failedClients).toBe(1);
    const [tracked] = service.listTracked();
    expect(tracked!.statusMessages[0]!.messages[0]).toContain('connection refused');
    expect(service.clientStatuses().get(c.id)).toMatchObject({ ok: false });
  });

  it('a throwing hook does not break the refresh', async () => {
    const { service, fake } = await setup();
    const c = service.create(qbit('Main'));
    const seen: string[] = [];
    service.onItemCompleted(() => {
      throw new Error('boom');
    });
    service.onItemCompleted((i) => {
      seen.push(i.downloadId);
    });
    fake(c.id).items = [item({ id: 'h1', status: 'completed' })];
    await expect(service.refreshQueue()).resolves.toMatchObject({ completed: 1 });
    expect(seen).toEqual(['h1']);
  });

  it('shouldRefresh is cheap-idle: active items or 5 idle minutes', async () => {
    const { service, fake, advance } = await setup();
    const c = service.create(qbit('Main'));
    expect(service.shouldRefresh()).toBe(true);
    await service.refreshQueue();
    expect(service.shouldRefresh()).toBe(false);
    advance(5 * 60_000);
    expect(service.shouldRefresh()).toBe(true);
    fake(c.id).items = [item({ id: 'h1' })];
    await service.refreshQueue();
    advance(60_000);
    expect(service.shouldRefresh()).toBe(true);
  });
});

describe('grab', () => {
  it('adds to the picked client and tracks the download with media info', async () => {
    const { service, fake } = await setup();
    const c = service.create(qbit('Main', {}, { category: 'tv' }));
    const tracked = await service.grab(
      null,
      { title: 'Movie.2024', magnet: 'magnet:?xt=urn:btih:m', isRecent: true, seedConfig: { ratioLimit: 2 } },
      { mediaType: 'movie', movieId: 9, grabbedRelease: { indexer: 'x' } },
    );
    expect(fake(c.id).added[0]).toMatchObject({ category: 'tv', isRecent: true, seedRatioLimit: 2 });
    expect(tracked).toMatchObject({ downloadId: 'abc123', trackedState: 'downloading', movieId: 9, grabbedRelease: { indexer: 'x' } });
    expect(service.queueStatus().totalCount).toBe(1);
  });

  it('fails with NO_CLIENT when nothing can take the release', async () => {
    const { service } = await setup();
    await expect(service.grab(null, { title: 'x', magnet: 'magnet:?' })).rejects.toMatchObject({ code: 'NO_CLIENT' });
  });

  it('records pending grabs and retries them', async () => {
    const { service, fake } = await setup();
    const c = service.create(qbit('Main'));
    const pending = service.addPending({ title: 'Show.S02', magnet: 'magnet:?xt=urn:btih:p' }, { mediaType: 'series', seriesId: 3 }, 'Delayed');
    expect(pending).toMatchObject({ trackedState: 'pending', downloadClientId: null });
    fake(c.id).nextId = 'p1';
    const sent = await service.retryPending(pending.id);
    expect(sent).toMatchObject({ id: pending.id, downloadId: 'p1', trackedState: 'downloading', seriesId: 3, downloadClientId: c.id });
    await expect(service.retryPending(pending.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('removeQueueItems', () => {
  async function seeded() {
    const ctx = await setup();
    const c = ctx.service.create(qbit('Main'));
    ctx.fake(c.id).items = [item({ id: 'h1' }), item({ id: 'h2' })];
    await ctx.service.refreshQueue();
    const ids = ctx.service.listTracked().map((t) => t.id);
    return { ...ctx, clientId: c.id, ids };
  }

  it('removes from the client and stops tracking', async () => {
    const { service, fake, clientId, ids } = await seeded();
    const result = await service.removeQueueItems([ids[0]!], { removeFromClient: true, blocklist: false, skipRedownload: false });
    expect(result).toEqual({ removed: [ids[0]], failed: [] });
    expect(fake(clientId).removed).toEqual([{ id: 'h1', deleteData: true }]);
    expect(service.listTracked().map((t) => t.downloadId)).toEqual(['h2']);
  });

  it('without client removal marks the item ignored so it leaves the queue', async () => {
    const { service, fake, clientId, ids } = await seeded();
    await service.removeQueueItems([ids[0]!], { removeFromClient: false, blocklist: false, skipRedownload: false });
    expect(fake(clientId).removed).toEqual([]);
    await service.refreshQueue();
    expect(service.getTracked(ids[0]!).trackedState).toBe('ignored');
    expect(service.listQueue({ includeUnknownMediaItems: true }).records.map((r) => r.downloadId)).toEqual(['h2']);
  });

  it('calls blocklist hooks with skipRedownload and reports failures per item', async () => {
    const { service, fake, clientId, ids } = await seeded();
    const blocked: Array<[string, boolean]> = [];
    service.onBlocklist((i, o) => {
      blocked.push([i.downloadId, o.skipRedownload]);
    });
    fake(clientId).failRemove = new DownloadClientError('unreachable', 'down');
    const r1 = await service.removeQueueItems([ids[0]!, 999], { removeFromClient: true, blocklist: true, skipRedownload: true });
    expect(r1.removed).toEqual([]);
    expect(r1.failed.map((f) => f.id)).toEqual([ids[0], 999]);
    fake(clientId).failRemove = new DownloadClientError('not-found', 'gone');
    const r2 = await service.removeQueueItems([ids[0]!], { removeFromClient: true, blocklist: true, skipRedownload: true });
    expect(r2.removed).toEqual([ids[0]]);
    expect(blocked).toEqual([['h1', true]]);
  });
});

describe('queue listing', () => {
  it('filters unknown media items, sorts and pages', async () => {
    const { service, fake } = await setup();
    const c = service.create(qbit('Main'));
    fake(c.id).nextId = 'known';
    await service.grab(c.id, { title: 'B.Known', magnet: 'magnet:?' }, { mediaType: 'series', seriesId: 1 });
    fake(c.id).items = [
      item({ id: 'known', title: 'B.Known', progress: 0.9 }),
      item({ id: 'u1', title: 'A.Unknown', progress: 0.1 }),
      item({ id: 'u2', title: 'C.Unknown', progress: 0.5 }),
    ];
    await service.refreshQueue();
    expect(service.listQueue().records.map((r) => r.downloadId)).toEqual(['known']);
    const all = service.listQueue({ includeUnknownMediaItems: 'true', sortKey: 'title', sortDirection: 'asc' });
    expect(all.records.map((r) => r.title)).toEqual(['A.Unknown', 'B.Known', 'C.Unknown']);
    const paged = service.listQueue({ includeUnknownMediaItems: true, sortKey: 'progress', pageSize: 2, page: 2 });
    expect(paged).toMatchObject({ totalRecords: 3, page: 2 });
    expect(paged.records.map((r) => r.downloadId)).toEqual(['u1']);
    expect(service.queueStatus()).toMatchObject({ totalCount: 1, unknownCount: 2 });
  });
});
