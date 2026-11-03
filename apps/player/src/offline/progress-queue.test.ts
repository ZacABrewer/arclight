import { afterEach, describe, expect, it } from 'vitest';
import type { ProgressBeacon } from '@arclight/shared';
import { setFetch } from '../core/api';
import { memoryStore } from '../core/kv';
import { fakeFetch } from '../test/fetch';
import { ProgressQueue } from './progress-queue';

const SERVER = 'http://10.0.0.2:7878';
const target = { serverUrl: SERVER, token: 'alt_x' };

function report(itemKey: string, event: ProgressBeacon['event'], positionMs: number): ProgressBeacon {
  return { itemKey, event, positionMs, durationMs: 200_000, deviceId: 'app-1', clientTime: new Date(1_800_000_000_000 + positionMs).toISOString() } as ProgressBeacon;
}

const progressRow = (itemKey: string) => ({ itemKey, positionMs: 0, durationMs: 0, played: false, playCount: 0, lastPlayedAt: null, updatedAt: '2026-01-01T00:00:00Z', favorite: false, prefs: {}, source: 'arclight' });

afterEach(() => setFetch(null));

describe('ProgressQueue', () => {
  it('coalesces progress ticks but keeps pauses and stops', async () => {
    const q = new ProgressQueue(memoryStore());
    await q.enqueue('a', report('track:1', 'progress', 1000));
    await q.enqueue('a', report('track:1', 'progress', 2000));
    await q.enqueue('a', report('track:1', 'pause', 2500));
    await q.enqueue('a', report('track:1', 'progress', 3000));
    const list = await q.pending('a');
    expect(list.map((r) => [r.event, r.positionMs])).toEqual([
      ['progress', 2000],
      ['pause', 2500],
      ['progress', 3000],
    ]);
  });

  it('survives a restart', async () => {
    const kv = memoryStore();
    await new ProgressQueue(kv).enqueue('a', report('track:1', 'stop', 10));
    expect(await new ProgressQueue(kv).size()).toBe(1);
  });

  it('flushes in one batch with the account token', async () => {
    const { impl, calls } = fakeFetch({
      'POST /playback/progress/batch': (c) => ({
        json: { results: (c.body as { reports: ProgressBeacon[] }).reports.map((r) => ({ itemKey: r.itemKey, accepted: true, progress: progressRow(r.itemKey) })) },
      }),
    });
    setFetch(impl);
    const q = new ProgressQueue(memoryStore());
    await q.enqueue('a', report('track:1', 'pause', 10));
    await q.enqueue('a', report('track:2', 'stop', 20));
    const res = await q.flush(async () => target);
    expect(res).toEqual({ sent: 2, kept: 0, dropped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer alt_x');
    expect(await q.size()).toBe(0);
  });

  it('keeps reports when the server is down or the token was refused', async () => {
    for (const status of [503, 401]) {
      setFetch(fakeFetch({ 'POST /playback/progress/batch': { status, json: { error: 'x' } } }).impl);
      const q = new ProgressQueue(memoryStore());
      await q.enqueue('a', report('track:1', 'pause', 10));
      expect(await q.flush(async () => target)).toEqual({ sent: 0, kept: 1, dropped: 0 });
      expect(await q.size()).toBe(1);
    }
  });

  it('falls back to single reports on servers without the batch endpoint', async () => {
    const { impl, calls } = fakeFetch({
      'POST /playback/progress/batch': { status: 404, json: { error: 'Not found' } },
      'PUT /playback/progress/track:1': { status: 204 },
    });
    setFetch(impl);
    const q = new ProgressQueue(memoryStore());
    await q.enqueue('a', report('track:1', 'pause', 10));
    const res = await q.flush(async () => target);
    expect(res.sent).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT']);
  });

  it('drops reports of accounts that are gone, and ones the server refuses', async () => {
    setFetch(fakeFetch({ 'POST /playback/progress/batch': { status: 400, json: { error: 'bad' } } }).impl);
    const q = new ProgressQueue(memoryStore());
    await q.enqueue('gone', report('track:1', 'pause', 10));
    await q.enqueue('a', report('track:2', 'pause', 10));
    const res = await q.flush(async (id) => (id === 'gone' ? null : target));
    expect(res).toEqual({ sent: 0, kept: 0, dropped: 2 });
    expect(await q.size()).toBe(0);
  });
});
