import { describe, expect, it } from 'vitest';
import type { ItemSpeedLimits, QueueMove } from '@arclight/download-clients';
import { clientOf, item, qbit, setup } from './test-support.js';

// Per-download limits, queue order, force start and the slow-mode mirror over fake clients.

const MAGNET = 'magnet:?xt=urn:btih:abc123';

async function grabbed() {
  const ctx = await setup();
  const client = ctx.service.create(qbit('Main'));
  const tracked = await ctx.service.grab(client.id, { title: 'Show.S01E01.1080p', magnet: MAGNET }, { mediaType: 'series', seriesId: 1, episodeIds: [1] });
  const fake = ctx.fake(client.id);
  fake.items = [item({ id: 'abc123', title: 'Show.S01E01.1080p', live: { downloadRate: 0, uploadRate: 0, queuePosition: 2, downloadLimit: 0 } })];
  await ctx.service.refreshQueue();
  const calls: unknown[][] = [];
  const controls = {
    setItemLimits: async (id: string, limits: ItemSpeedLimits) => void calls.push(['limits', id, limits]),
    moveInQueue: async (id: string, move: QueueMove) => void calls.push(['move', id, move]),
    setForceStart: async (id: string, enabled: boolean) => void calls.push(['force', id, enabled]),
    setAlternativeSpeed: async (enabled: boolean) => void calls.push(['alt', enabled]),
  };
  return { ...ctx, fakeOf: ctx.fake, client, tracked, fake, calls, controls };
}

describe('queue engine control', () => {
  it('passes limits, moves and force start to the client of the queue item', async () => {
    const h = await grabbed();
    Object.assign(h.fake, h.controls);
    const res = await h.service.setItemLimits(h.tracked.id, { downloadLimit: 51_200 });
    expect(res.live).toMatchObject({ queuePosition: 2 });
    await h.service.moveInQueue(h.tracked.id, 'top');
    await h.service.setForceStart(h.tracked.id, true);
    expect(h.calls).toEqual([
      ['limits', 'abc123', { downloadLimit: 51_200 }],
      ['move', 'abc123', 'top'],
      ['force', 'abc123', true],
    ]);
  });

  it('refuses clients without the capability and items not sent yet', async () => {
    const h = await grabbed();
    await expect(h.service.moveInQueue(h.tracked.id, 'up')).rejects.toMatchObject({ code: 'CONFLICT' });
    const pending = h.service.addPending({ title: 'Other', magnet: 'magnet:?xt=urn:btih:def456' }, {}, 'no client');
    await expect(h.service.setForceStart(pending.id, true)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(h.service.setForceStart(999, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps client failures to CLIENT_ERROR', async () => {
    const h = await grabbed();
    Object.assign(h.fake, { moveInQueue: async () => Promise.reject(new Error('queueing is disabled')) });
    await expect(h.service.moveInQueue(h.tracked.id, 'down')).rejects.toMatchObject({ code: 'CLIENT_ERROR', message: 'Main: queueing is disabled' });
  });

  it('mirrors slow mode to clients with alternative limits and reports failures', async () => {
    const h = await grabbed();
    Object.assign(h.fake, h.controls);
    const other = h.service.create(qbit('Second'));
    Object.assign(h.fakeOf(other.id), { setAlternativeSpeed: async () => Promise.reject(new Error('offline')) });
    h.service.create(clientOf('sabnzbd', 'Usenet'));
    const results = await h.service.setAlternativeSpeedOnAll(true);
    expect(results).toEqual([
      { id: h.client.id, name: 'Main', ok: true },
      { id: other.id, name: 'Second', ok: false, message: 'offline' },
    ]);
    expect(h.calls).toEqual([['alt', true]]);
  });
});

describe('engine timeline entries', () => {
  it('records on the tracked download of a built-in client whatever its state', async () => {
    const ctx = await setup();
    const client = ctx.service.create(clientOf('builtin', 'Built-in'));
    const fake = ctx.fake(client.id);
    fake.nextId = 'aa'.repeat(20);
    const tracked = await ctx.service.grab(client.id, { title: 'Movie.2020', magnet: `magnet:?xt=urn:btih:${'aa'.repeat(20)}` }, { mediaType: 'movie', movieId: 1 });
    ctx.service.setState(tracked.id, 'imported');
    ctx.service.recordEngineEvent('AA'.repeat(20), 'removed', { message: 'Removed by seeding rule "Movies".', data: { reason: 'seedingRule' } });
    ctx.service.recordEngineEvent('bb'.repeat(20), 'removed', { message: 'unknown torrent' });
    expect(ctx.service.getTimeline(tracked.id).events.at(-1)).toMatchObject({ type: 'removed', data: { reason: 'seedingRule' } });
  });
});
