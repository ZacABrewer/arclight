import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECOVERY_SETTINGS,
  DISK_RESUME_MARGIN_BYTES,
  diskGuardAction,
  grabHoldReason,
  planStallRecovery,
  type RecoverySettings,
} from './recovery.js';
import { downloadClientsRoutes } from './routes.js';
import type { TrackedDownload } from './service.js';
import { item, qbit, setup } from './test-support.js';

// Self-healing downloads: the stall-recovery ladder, the "Try another release" and Re-announce
// actions, and the disk-space guard (held grabs, paused downloads), over the fake client.

const MIN = 60_000;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MAGNET = 'magnet:?xt=urn:btih:abc123';
const T0 = '2026-01-01T00:00:00.000Z';

describe('planStallRecovery', () => {
  const at = (minutes: number) => new Date(Date.parse(T0) + minutes * MIN);
  const stalled = { stalledSince: T0, reannouncedAt: null, progress: 0.4 };

  it('re-announces first, then replaces once the replace time after the stall flag passed', () => {
    // Flagged at 10 min (stall threshold), replaced 30 min later.
    expect(planStallRecovery(stalled, DEFAULT_RECOVERY_SETTINGS, at(10), 10 * MIN)).toMatchObject({
      reannounce: true,
      replace: false,
      info: { replaceInMinutes: 30 },
    });
    const later = { ...stalled, reannouncedAt: at(10).toISOString() };
    expect(planStallRecovery(later, DEFAULT_RECOVERY_SETTINGS, at(25), 10 * MIN)).toMatchObject({
      reannounce: false,
      replace: false,
      info: { reannouncedMinutesAgo: 15, replaceInMinutes: 15 },
    });
    expect(planStallRecovery(later, DEFAULT_RECOVERY_SETTINGS, at(40), 10 * MIN)).toMatchObject({ replace: true, stalledMinutes: 40 });
  });

  it('keeps downloads past the progress limit, never replaces with 0, and is off with the master switch', () => {
    const far = { ...stalled, progress: 0.95 };
    expect(planStallRecovery(far, DEFAULT_RECOVERY_SETTINGS, at(600), 10 * MIN)).toMatchObject({
      reannounce: true,
      replace: false,
      info: { keptAtProgress: 90 },
    });
    const never: RecoverySettings = { ...DEFAULT_RECOVERY_SETTINGS, replaceAfterMs: 0 };
    expect(planStallRecovery(stalled, never, at(600), 10 * MIN)).toMatchObject({ reannounce: true, replace: false, info: {} });
    expect(planStallRecovery(stalled, { ...DEFAULT_RECOVERY_SETTINGS, stallRecovery: false }, at(600), 10 * MIN)).toBeNull();
  });
});

describe('disk-space guard decisions', () => {
  it('pauses below the minimum and resumes only above the minimum plus the margin', () => {
    expect(diskGuardAction(50 * MIB, 100 * MIB, true)).toBe('pause');
    expect(diskGuardAction(200 * MIB, 100 * MIB, true)).toBe('none');
    expect(diskGuardAction(100 * MIB + DISK_RESUME_MARGIN_BYTES, 100 * MIB, true)).toBe('resume');
    expect(diskGuardAction(null, 100 * MIB, true)).toBe('none');
    expect(diskGuardAction(0, 100 * MIB, false)).toBe('resume');
  });

  it('holds grabs that would not fit or would cross the minimum', () => {
    const base = { minimumBytes: 100 * MIB, dir: '/downloads' };
    expect(grabHoldReason({ ...base, sizeBytes: GIB, free: 10 * GIB, committed: 0 })).toBeNull();
    expect(grabHoldReason({ ...base, sizeBytes: 2 * GIB, free: GIB, committed: 0 })).toContain('needs 2.0 GiB but only 1.0 GiB is free in /downloads');
    expect(grabHoldReason({ ...base, sizeBytes: GIB, free: GIB + 50 * MIB, committed: 0 })).toContain('below the 100.0 MiB minimum');
    expect(grabHoldReason({ ...base, sizeBytes: GIB, free: 2 * GIB, committed: GIB })).toContain('other downloads there still need');
  });
});

/** A grabbed download on a fake qBittorrent, with a switchable free-space reading. */
async function grabbed(options: { settings?: Partial<RecoverySettings>; free?: number | null } = {}) {
  let free: number | null = options.free ?? 100 * GIB;
  let recovery: RecoverySettings = { ...DEFAULT_RECOVERY_SETTINGS, ...options.settings };
  const ctx = await setup({
    stallAfterMs: () => 10 * MIN,
    minimumFreeSpaceBytes: () => 100 * MIB,
    freeSpace: async () => free,
    recoverySettings: () => recovery,
  });
  const client = ctx.service.create(qbit('Main'));
  const blocklisted: Array<{ id: number; message?: string | undefined; skipRedownload: boolean }> = [];
  ctx.service.onBlocklist((tracked, opts) => {
    blocklisted.push({ id: tracked.id, message: opts.message, skipRedownload: opts.skipRedownload });
  });
  const searches: TrackedDownload[] = [];
  ctx.service.setReplacementSearch((tracked) => {
    searches.push(tracked);
    return true;
  });
  const tracked = await ctx.service.grab(client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, { mediaType: 'series', seriesId: 1, episodeIds: [1] });
  const fake = ctx.fake(client.id);
  const set = (extra: Partial<Parameters<typeof item>[0]> = {}) => {
    fake.items = [item({ id: 'abc123', title: 'Show.S01E01.1080p', downloadedBytes: 100, remainingBytes: 900, progress: 0.1, ...extra })];
  };
  set();
  const types = (id = tracked.id) => ctx.service.getTimeline(id).events.map((e) => e.type);
  return {
    ...ctx,
    client,
    tracked,
    fake,
    set,
    types,
    blocklisted,
    searches,
    setFree: (bytes: number | null) => {
      free = bytes;
    },
    setRecovery: (patch: Partial<RecoverySettings>) => {
      recovery = { ...recovery, ...patch };
    },
  };
}

/** Polls until the download counts as stalled (flagged at +10 min). */
async function stall(h: Awaited<ReturnType<typeof grabbed>>) {
  await h.service.refreshQueue();
  h.advance(10 * MIN);
  await h.service.refreshQueue();
}

describe('stall recovery', () => {
  it('re-announces once, then removes, blocklists and searches for another release', async () => {
    const h = await grabbed();
    await stall(h);
    expect(h.types()).toEqual(['grabbed', 'started', 'stalled', 'reannounced']);
    expect(h.fake.reannounced).toEqual(['abc123']);
    const waiting = h.service.getQueueItem(h.tracked.id);
    expect(waiting.stateReason).toContain('Asked for fresh peers just now.');
    expect(waiting.stateReason).toContain('replaced with another release in about 30 minutes');

    h.advance(15 * MIN);
    await h.service.refreshQueue();
    expect(h.fake.reannounced).toHaveLength(1);
    expect(h.service.getQueueItem(h.tracked.id).stateReason).toContain('in about 15 minutes');

    h.advance(15 * MIN);
    await h.service.refreshQueue();
    expect(h.fake.removed).toEqual([{ id: 'abc123', deleteData: true }]);
    expect(h.blocklisted).toEqual([{ id: h.tracked.id, message: 'Stalled: no data for 40 min', skipRedownload: true }]);
    expect(h.searches.map((s) => s.episodeIds)).toEqual([[1]]);
    expect(() => h.service.getQueueItem(h.tracked.id)).toThrow(/not found/);
    const last = h.service.getTimeline(h.tracked.id).events.at(-1)!;
    expect(last).toMatchObject({ type: 'replaced', severity: 'warning' });
    expect(last.message).toBe(
      'Gave up on this release (stalled: no data for 40 min): removed from Main with its data, release blocklisted, searching for another release.',
    );
  });

  it('replaces a magnet whose metadata never arrives (private torrents never share it)', async () => {
    const h = await grabbed();
    h.set({ phase: 'metadata', downloadedBytes: 0, remainingBytes: 0, progress: 0 });
    await stall(h);
    expect(h.types()).toEqual(['grabbed', 'stalled', 'reannounced']);
    const waiting = h.service.getQueueItem(h.tracked.id);
    expect(waiting.stateCode).toBe('stalled');
    expect(waiting.stateReason).toContain('Waiting for the torrent metadata from peers');
    expect(waiting.stateReason).toContain('private torrent');
    h.advance(30 * MIN);
    await h.service.refreshQueue();
    expect(h.fake.removed).toEqual([{ id: 'abc123', deleteData: true }]);
    expect(h.searches.map((s) => s.episodeIds)).toEqual([[1]]);
  });

  it('starts over with a new stall after data arrived', async () => {
    const h = await grabbed();
    await stall(h);
    h.set({ downloadedBytes: 200 });
    await h.service.refreshQueue();
    expect(h.types().at(-1)).toBe('recovered');
    h.advance(10 * MIN);
    await h.service.refreshQueue();
    expect(h.fake.reannounced).toHaveLength(2);
  });

  it('only re-announces downloads past the progress limit', async () => {
    const h = await grabbed();
    h.set({ progress: 0.95, remainingBytes: 50 });
    await stall(h);
    h.advance(120 * MIN);
    await h.service.refreshQueue();
    expect(h.fake.removed).toEqual([]);
    expect(h.service.getQueueItem(h.tracked.id).stateReason).toContain('Not replaced automatically: it is past 90%.');
  });

  it('waits while the replace guard (VPN) says no, and does nothing when switched off', async () => {
    const h = await grabbed();
    let safe = false;
    h.service.setReplaceGuard(() => safe);
    await stall(h);
    h.advance(60 * MIN);
    await h.service.refreshQueue();
    expect(h.fake.removed).toEqual([]);
    safe = true;
    await h.service.refreshQueue();
    expect(h.fake.removed).toHaveLength(1);

    const off = await grabbed({ settings: { stallRecovery: false } });
    await stall(off);
    off.advance(120 * MIN);
    await off.service.refreshQueue();
    expect(off.fake.reannounced).toEqual([]);
    expect(off.fake.removed).toEqual([]);
  });

  it('never replaces a download Arclight did not grab', async () => {
    const h = await grabbed();
    h.fake.items.push(item({ id: 'other', downloadedBytes: 10, remainingBytes: 990, progress: 0.01 }));
    await stall(h);
    h.advance(60 * MIN);
    await h.service.refreshQueue();
    expect(h.fake.removed.map((r) => r.id)).toEqual(['abc123']);
    expect(h.fake.reannounced).toContain('other');
  });
});

describe('Try another release / Re-announce', () => {
  async function app() {
    const h = await grabbed();
    const a = Fastify().withTypeProvider<ZodTypeProvider>();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    await a.register(downloadClientsRoutes(h.service), { prefix: '/api/v1' });
    await h.service.refreshQueue();
    return { ...h, app: a };
  }

  it('POST /queue/:id/replace honours the blocklist and remove-data options', async () => {
    const h = await app();
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/queue/${h.tracked.id}/replace`, payload: { blocklist: false, removeData: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: h.tracked.id, blocklisted: false, searchStarted: true });
    expect(h.fake.removed).toEqual([{ id: 'abc123', deleteData: false }]);
    expect(h.blocklisted).toEqual([]);
    expect(h.searches).toHaveLength(1);
    expect(h.types().at(-1)).toBe('replaced');
    const gone = await h.app.inject({ method: 'POST', url: `/api/v1/queue/${h.tracked.id}/replace`, payload: {} });
    expect(gone.statusCode).toBe(404);
  });

  it('POST /queue/:id/replace defaults to blocklisting and deleting the data', async () => {
    const h = await app();
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/queue/${h.tracked.id}/replace`, payload: {} });
    expect(res.json()).toMatchObject({ blocklisted: true });
    expect(h.fake.removed).toEqual([{ id: 'abc123', deleteData: true }]);
    expect(h.blocklisted).toEqual([{ id: h.tracked.id, message: 'Replaced by the user', skipRedownload: true }]);
  });

  it('POST /queue/:id/reannounce asks the client for peers and records it', async () => {
    const h = await app();
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/queue/${h.tracked.id}/reannounce` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: h.tracked.id, message: 'Asked Main for fresh peers.' });
    expect(h.fake.reannounced).toEqual(['abc123']);
    expect(h.types().at(-1)).toBe('reannounced');
    const missing = await h.app.inject({ method: 'POST', url: '/api/v1/queue/999/reannounce' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('disk-space guard', () => {
  it('pauses downloads while the volume is below the minimum and resumes them with a margin', async () => {
    const h = await grabbed();
    await h.service.refreshQueue();
    h.setFree(50 * MIB);
    await h.service.refreshQueue();
    expect(h.fake.paused).toEqual(['abc123']);
    const paused = h.service.getTimeline(h.tracked.id).events.at(-1)!;
    expect(paused).toMatchObject({ type: 'paused', severity: 'warning', data: { reason: 'diskSpace' } });
    expect(paused.message).toContain('only 50.0 MiB is free');
    expect(h.service.getQueueItem(h.tracked.id)).toMatchObject({ stateCode: 'diskPaused', stateSeverity: 'warning' });
    expect(h.service.queueStatus().diskGuard).toMatchObject({ paused: 1, held: 0, volumes: [{ path: '/downloads', freeBytes: 50 * MIB }] });

    // Next poll: the client reports it paused; still guarded, no second entry, no client "paused".
    await h.service.refreshQueue();
    expect(h.types().filter((t) => t === 'paused')).toHaveLength(1);
    expect(h.service.getQueueItem(h.tracked.id).stateCode).toBe('diskPaused');

    // Above the minimum but inside the margin: stays paused.
    h.setFree(500 * MIB);
    await h.service.refreshQueue();
    expect(h.fake.resumed).toEqual([]);

    h.setFree(2 * GIB);
    await h.service.refreshQueue();
    expect(h.fake.resumed).toEqual(['abc123']);
    expect(h.service.getTimeline(h.tracked.id).events.at(-1)).toMatchObject({ type: 'resumed', data: { reason: 'diskSpace' } });
    await h.service.refreshQueue();
    expect(h.service.getQueueItem(h.tracked.id).stateCode).toBe('downloading');
    expect(h.types().filter((t) => t === 'paused' || t === 'resumed')).toEqual(['paused', 'resumed']);
    expect(h.service.queueStatus().diskGuard).toMatchObject({ paused: 0, volumes: [] });
  });

  it('resumes what it paused when the guard is switched off', async () => {
    const h = await grabbed({ free: 10 * MIB });
    await h.service.refreshQueue();
    expect(h.fake.paused).toEqual(['abc123']);
    h.setRecovery({ diskGuard: false });
    await h.service.refreshQueue();
    expect(h.fake.resumed).toEqual(['abc123']);
  });

  it('holds a grab that would not fit, sends it when there is room, and re-keys its id', async () => {
    const h = await grabbed({ free: GIB });
    const sent: Array<{ from: string; to: string }> = [];
    h.service.onPendingSent((tracked, from) => {
      sent.push({ from, to: tracked.downloadId });
    });
    h.fake.nextId = 'def456';
    const held = await h.service.grab(h.client.id, { title: 'Show.S01E02.2160p', magnet: 'magnet:?xt=urn:btih:def456', sizeBytes: 4 * GIB }, { mediaType: 'series', seriesId: 1, episodeIds: [2] });
    expect(held.trackedState).toBe('pending');
    expect(held.downloadId).toMatch(/^pending:/);
    expect(held).toMatchObject({ stateCode: 'diskHeld', stateSeverity: 'warning' });
    expect(held.stateReason).toContain('needs 4.0 GiB but only');
    expect(h.fake.added).toHaveLength(1);
    expect(h.types(held.id)).toEqual(['held']);
    expect(h.service.queueStatus().diskGuard).toMatchObject({ held: 1 });

    // Still no room: stays held, no new timeline entry.
    expect(await h.service.retryHeldGrabs()).toEqual({ held: 1, sent: 0 });
    expect(h.types(held.id)).toEqual(['held']);

    h.setFree(20 * GIB);
    expect(await h.service.retryHeldGrabs()).toEqual({ held: 0, sent: 1 });
    expect(h.fake.added).toHaveLength(2);
    const now = h.service.getTracked(held.id);
    expect(now).toMatchObject({ trackedState: 'downloading', downloadId: 'def456', downloadClientId: h.client.id });
    expect(h.types(held.id)).toEqual(['held', 'grabbed']);
    expect(sent).toEqual([{ from: held.downloadId, to: 'def456' }]);
  });

  it('"Send now" overrides the hold; grabs without a size or with the guard off go straight through', async () => {
    const h = await grabbed({ free: GIB });
    h.fake.nextId = 'def456';
    const held = await h.service.grab(h.client.id, { title: 'Big', magnet: 'magnet:?xt=urn:btih:def456', sizeBytes: 4 * GIB }, { movieId: 7 });
    const forced = await h.service.retryPending(held.id, { force: true });
    expect(forced.trackedState).toBe('downloading');

    h.fake.nextId = 'aaa111';
    const unsized = await h.service.grab(h.client.id, { title: 'Unsized', magnet: 'magnet:?xt=urn:btih:aaa111' }, { movieId: 8 });
    expect(unsized.trackedState).toBe('downloading');

    h.setRecovery({ diskGuard: false });
    h.fake.nextId = 'bbb222';
    const off = await h.service.grab(h.client.id, { title: 'Off', magnet: 'magnet:?xt=urn:btih:bbb222', sizeBytes: 40 * GIB }, { movieId: 9 });
    expect(off.trackedState).toBe('downloading');
  });
});
