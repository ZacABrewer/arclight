import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@arclight/shared';
import { EventBus } from '../../events.js';
import { DownloadClientError, item, qbit, setup } from './test-support.js';

// Timeline, stall detection and the per-item state reason, over the fake client.

const MIN = 60_000;
const MAGNET = 'magnet:?xt=urn:btih:abc123';

async function grabbed(options: Parameters<typeof setup>[0] = {}) {
  const bus = new EventBus();
  const published: ServerEvent[] = [];
  bus.subscribe((e) => published.push(e));
  const ctx = await setup({ bus, stallAfterMs: () => 10 * MIN, freeSpace: async () => null, ...options });
  const client = ctx.service.create(qbit('Main'));
  const tracked = await ctx.service.grab(client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, { mediaType: 'series', seriesId: 1, episodeIds: [1] });
  const fake = ctx.fake(client.id);
  const set = (extra: Parameters<typeof item>[0] extends infer T ? Partial<T> : never) => {
    fake.items = [item({ id: 'abc123', title: 'Show.S01E01.1080p', downloadedBytes: 0, remainingBytes: 1000, progress: 0, ...extra })];
  };
  const types = () => ctx.service.getTimeline(tracked.id).events.map((e) => e.type);
  return { ...ctx, bus, published, client, tracked, fake, set, types };
}

describe('download timeline', () => {
  it('records a download from grab to import and publishes each entry', async () => {
    const h = await grabbed();
    expect(h.types()).toEqual(['grabbed']);
    expect(h.service.getTimeline(h.tracked.id).events[0]!.message).toBe('Sent to Main.');

    h.set({ phase: 'metadata', status: 'queued' });
    await h.service.refreshQueue();
    expect(h.service.getQueueItem(h.tracked.id)).toMatchObject({ stateCode: 'metadata', stateSeverity: 'info' });

    h.set({ downloadedBytes: 100, live: { downloadRate: 2048, uploadRate: 0, connectedPeers: 3, connectedSeeds: 2 } });
    await h.service.refreshQueue();
    expect(h.types()).toEqual(['grabbed', 'metadataReceived', 'started']);
    expect(h.service.getQueueItem(h.tracked.id)).toMatchObject({
      stateCode: 'downloading',
      stateReason: 'Downloading from 3 peers (2 seeds).',
      live: { downloadRate: 2048, connectedPeers: 3 },
    });

    h.set({ downloadedBytes: 100, status: 'paused' });
    await h.service.refreshQueue();
    h.set({ downloadedBytes: 300 });
    await h.service.refreshQueue();
    expect(h.types().slice(-2)).toEqual(['paused', 'resumed']);

    h.set({ downloadedBytes: 1000, remainingBytes: 0, progress: 1, status: 'completed' });
    await h.service.refreshQueue();
    expect(h.types().at(-1)).toBe('completed');

    h.service.setState(h.tracked.id, 'importing');
    await h.service.markImported(h.tracked.id);
    expect(h.types().slice(-2)).toEqual(['importStarted', 'imported']);
    const live = h.published.filter((e) => e.type === 'download');
    expect(live.length).toBe(h.types().length);
    expect(h.published.some((e) => e.type === 'queue')).toBe(true);
  });

  it('keeps one import-blocked entry per distinct message and records import failures', async () => {
    const h = await grabbed();
    const blocked = (text: string) =>
      h.service.setState(h.tracked.id, 'importPending', { trackedStatus: 'warning', statusMessages: [{ title: 'x', messages: [text] }] });
    blocked('Sample only');
    blocked('Sample only');
    blocked('Not an upgrade');
    h.service.setState(h.tracked.id, 'failed', { statusMessages: [{ title: 'x', messages: ['Disk full'] }] });
    const events = h.service.getTimeline(h.tracked.id).events;
    expect(events.map((e) => e.type)).toEqual(['grabbed', 'importBlocked', 'importBlocked', 'importFailed']);
    expect(events.at(-1)).toMatchObject({ severity: 'error', message: 'Disk full' });
  });

  it('records removals and keeps the timeline readable afterwards', async () => {
    const h = await grabbed();
    await h.service.removeQueueItems([h.tracked.id], { removeFromClient: true, blocklist: false, skipRedownload: false });
    const timeline = h.service.getTimeline(h.tracked.id);
    expect(timeline.events.at(-1)).toMatchObject({ type: 'removed', message: 'Removed from the queue: deleted from the download client.' });
    expect(() => h.service.getTimeline(999)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));

    h.advance(31 * 24 * 60 * MIN);
    expect(h.service.pruneTimeline()).toBe(2);
    expect(() => h.service.getTimeline(h.tracked.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('records a removal when the client stops reporting a grabbed download', async () => {
    const h = await grabbed({ missingGraceMs: MIN });
    h.set({ downloadedBytes: 10 });
    await h.service.refreshQueue();
    h.fake.items = [];
    await h.service.refreshQueue();
    expect(h.service.getQueueItem(h.tracked.id).stateCode).toBe('missing');
    h.advance(2 * MIN);
    await h.service.refreshQueue();
    expect(h.service.getTimeline(h.tracked.id).events.at(-1)).toMatchObject({ type: 'removed', severity: 'warning' });
  });

  it('writes nothing for downloads Arclight did not grab', async () => {
    const h = await grabbed();
    h.fake.items = [item({ id: 'other', downloadedBytes: 0 })];
    await h.service.refreshQueue();
    h.fake.items = [item({ id: 'other', downloadedBytes: 50, status: 'paused' })];
    await h.service.refreshQueue();
    const other = h.service.listQueue({ includeUnknownMediaItems: true }).records.find((r) => r.downloadId === 'other')!;
    expect(other.stateCode).toBe('paused');
    expect(h.service.timeline.has(other.id)).toBe(false);
  });
});

describe('stall detection', () => {
  it('flags a download without new data after the threshold and records the recovery', async () => {
    const h = await grabbed();
    h.set({ downloadedBytes: 100 });
    await h.service.refreshQueue();
    const startedAt = h.service.getQueueItem(h.tracked.id).added;
    h.advance(5 * MIN);
    await h.service.refreshQueue();
    expect(h.service.getQueueItem(h.tracked.id).stateCode).toBe('downloading');

    h.advance(6 * MIN);
    h.set({ downloadedBytes: 100, live: { downloadRate: 0, uploadRate: 0, connectedPeers: 1, connectedSeeds: 0 } });
    await h.service.refreshQueue();
    const stalled = h.service.getQueueItem(h.tracked.id);
    expect(stalled).toMatchObject({ stateCode: 'stalled', stateSeverity: 'warning', trackedStatus: 'warning', stalledSince: startedAt });
    expect(stalled.statusMessages.flatMap((m) => m.messages)).toContain('No new data received for 10 minutes.');
    // Stall recovery asks for fresh peers right after the stall is flagged.
    expect(h.types().slice(-2)).toEqual(['stalled', 'reannounced']);
    const entry = h.service.getTimeline(h.tracked.id).events.at(-2)!;
    expect(entry).toMatchObject({ type: 'stalled', severity: 'warning' });
    expect(entry.message).toBe('No new data for 10 minutes at 0%. 1 peer(s) connected, 0 seed(s).');

    // Still stalled: no second entry.
    h.advance(5 * MIN);
    await h.service.refreshQueue();
    expect(h.types().filter((t) => t === 'stalled')).toHaveLength(1);
    expect(h.service.activeDownloads()[0]).toMatchObject({ stalledSince: startedAt, stateCode: 'stalled' });

    h.set({ downloadedBytes: 400 });
    await h.service.refreshQueue();
    expect(h.types().at(-1)).toBe('recovered');
    expect(h.service.getQueueItem(h.tracked.id)).toMatchObject({ stateCode: 'downloading', trackedStatus: 'ok' });
    expect(h.service.getQueueItem(h.tracked.id).stalledSince).toBeUndefined();
  });

  it('does not count paused or queued time, and can be turned off', async () => {
    const h = await grabbed();
    h.set({ downloadedBytes: 100, status: 'paused' });
    await h.service.refreshQueue();
    h.advance(30 * MIN);
    h.set({ downloadedBytes: 100, status: 'queued' });
    await h.service.refreshQueue();
    h.advance(30 * MIN);
    h.set({ downloadedBytes: 100 });
    await h.service.refreshQueue();
    h.advance(5 * MIN);
    await h.service.refreshQueue();
    expect(h.types()).not.toContain('stalled');

    const off = await grabbed({ stallAfterMs: () => 0 });
    off.set({ downloadedBytes: 100 });
    await off.service.refreshQueue();
    off.advance(120 * MIN);
    await off.service.refreshQueue();
    expect(off.types()).not.toContain('stalled');
  });
});

describe('state reasons from the queue poll', () => {
  it('reports downloads that will not fit on the download volume', async () => {
    const h = await grabbed({ freeSpace: async () => 300, minimumFreeSpaceBytes: () => 0 });
    h.set({ downloadedBytes: 100, remainingBytes: 900 });
    await h.service.refreshQueue();
    const queued = h.service.getQueueItem(h.tracked.id);
    expect(queued).toMatchObject({ stateCode: 'diskSpace', stateSeverity: 'error' });
    expect(queued.stateReason).toContain('600 B short');
  });

  it('reports an unreachable client', async () => {
    const h = await grabbed();
    h.fake.failGetItems = new DownloadClientError('unreachable', 'connect ECONNREFUSED');
    await h.service.refreshQueue();
    expect(h.service.getQueueItem(h.tracked.id)).toMatchObject({
      stateCode: 'clientUnavailable',
      stateReason: 'Main is unreachable: connect ECONNREFUSED',
    });
  });

  it('overlays live engine numbers and kill-switch state for built-in downloads', async () => {
    const h = await grabbed();
    const builtin = h.service.create({ name: 'Built-in', implementation: 'builtin', settings: {} });
    const t = await h.service.grab(builtin.id, { title: 'Movie.2024', magnet: MAGNET }, { mediaType: 'movie', movieId: 3 });
    h.service.setEngineInsights({
      lockdown: () => ({ reason: 'VPN disconnected: health check timed out.' }),
      killSwitchPaused: () => ['abc123'],
      live: () => ({ live: { downloadRate: 0, uploadRate: 0, connectedPeers: 0 }, progress: 0.06, sizeLeft: 940, etaMs: 5000 }),
    });
    const item = h.service.getQueueItem(t.id);
    expect(item).toMatchObject({ stateCode: 'killSwitch', progress: 0.06, sizeLeftBytes: 940, eta: 5000 });
    expect(item.stateReason).toBe(
      'Paused by the VPN kill switch (VPN disconnected: health check timed out). It resumes on its own when the VPN reconnects.',
    );
    // The qBittorrent download with the same hash is not affected.
    expect(h.service.getQueueItem(h.tracked.id).stateCode).not.toBe('killSwitch');
  });
});
