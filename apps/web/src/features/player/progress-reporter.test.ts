import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressReport } from '@arclight/shared';
import { HEARTBEAT_MS, ProgressReporter, type ReporterSnapshot } from './progress-reporter.js';

function setup(initial: ReporterSnapshot | null) {
  let snap = initial;
  const send = vi.fn(async (_key: string, _report: ProgressReport) => undefined);
  const beacon = vi.fn(() => true);
  const reporter = new ProgressReporter({
    read: () => snap,
    send,
    beacon,
    deviceId: 'device-test',
    deviceName: 'Test browser',
    now: () => new Date('2026-01-01T12:00:00Z'),
  });
  return { reporter, send, beacon, set: (s: Partial<ReporterSnapshot>) => (snap = { ...snap!, ...s }) };
}

const playing: ReporterSnapshot = { itemKey: 'audiobook:7', positionMs: 1000.7, durationMs: 60_000, speed: 1.25, playing: true, playMethod: 'DirectPlay' };

describe('ProgressReporter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends start with the device and time, then heartbeats while playing', () => {
    const { reporter, send, set } = setup(playing);
    reporter.report('start');
    expect(send).toHaveBeenLastCalledWith('audiobook:7', {
      event: 'start',
      positionMs: 1000,
      durationMs: 60_000,
      speed: 1.25,
      deviceId: 'device-test',
      deviceName: 'Test browser',
      clientTime: '2026-01-01T12:00:00.000Z',
      playMethod: 'DirectPlay',
    });
    reporter.startHeartbeat();
    set({ positionMs: 16_000 });
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toMatchObject({ event: 'progress', positionMs: 16_000 });
  });

  it('skips stale heartbeats and heartbeats while paused', () => {
    const { reporter, send, set } = setup(playing);
    reporter.report('start');
    reporter.startHeartbeat();
    vi.advanceTimersByTime(HEARTBEAT_MS); // nothing moved
    expect(send).toHaveBeenCalledTimes(1);
    set({ positionMs: 20_000, playing: false });
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(1);
    reporter.stopHeartbeat();
    set({ positionMs: 40_000, playing: true });
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('closes the started item with stop, once', () => {
    const { reporter, send } = setup(playing);
    reporter.report('start');
    expect(reporter.startedKey).toBe('audiobook:7');
    reporter.stop();
    expect(send).toHaveBeenLastCalledWith('audiobook:7', expect.objectContaining({ event: 'stop' }));
    expect(reporter.startedKey).toBeNull();
    reporter.stop();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends a beacon with the item key when the page goes away', () => {
    const { reporter, beacon, send } = setup(playing);
    expect(reporter.beacon('stop')).toBe(true);
    expect(beacon).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'audiobook:7', event: 'stop', positionMs: 1000, deviceId: 'device-test' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing without an item, and swallows send failures', async () => {
    const empty = setup(null);
    empty.reporter.report('progress');
    expect(empty.reporter.beacon('stop')).toBe(false);
    expect(empty.send).not.toHaveBeenCalled();

    const failing = setup({ ...playing, speed: 9 });
    failing.send.mockRejectedValueOnce(new Error('offline'));
    failing.reporter.report('pause');
    expect(failing.send.mock.calls[0]![1]).toMatchObject({ speed: 3.5 });
    await Promise.resolve();
  });
});
