import { describe, expect, it } from 'vitest';
import { DISK_GUARD_MIN_DOWN, DiskGuard, type DiskSample } from './disk-guard.js';
import { combineLimit } from './tunnel-guard.js';

const MiB = 1024 * 1024;

/** Feeds samples 5 s apart; the disk writes `writeRate` bytes/s in each. */
function feeder(g: DiskGuard) {
  let at = 0;
  let written = 0;
  return (writeRate: number, s: Partial<Omit<DiskSample, 'at' | 'writtenBytes'>> = {}): boolean => {
    at += 5000;
    written += writeRate * 5;
    return g.observe({ at, writtenBytes: written, backlogBytes: 0, backlogLimitBytes: 64 * MiB, backpressured: 0, downloadRate: writeRate, ...s });
  };
}

describe('DiskGuard', () => {
  it('stays out of the way while the disk keeps up', () => {
    const g = new DiskGuard();
    const feed = feeder(g);
    for (let i = 0; i < 10; i++) expect(feed(25 * MiB, { backlogBytes: 2 * MiB, downloadRate: 25 * MiB })).toBe(false);
    expect(g.active).toBe(false);
    expect(g.writeRate).toBeCloseTo(25 * MiB, -3);
  });

  it('limits downloads to a little under what the disk writes once the backlog builds up', () => {
    const g = new DiskGuard();
    const feed = feeder(g);
    feed(15 * MiB);
    // The network delivers 30 MiB/s, the disk completes 15 MiB/s and the backlog fills.
    expect(feed(15 * MiB, { backlogBytes: 40 * MiB, downloadRate: 30 * MiB })).toBe(true);
    expect(g.downloadLimit).toBe(Math.round(15 * MiB * 0.9));
    // Backpressure alone counts as behind too; a slower disk lowers the limit further.
    expect(feed(9 * MiB, { backpressured: 1, downloadRate: 13 * MiB })).toBe(true);
    expect(g.downloadLimit).toBeLessThan(Math.round(15 * MiB * 0.9));
    expect(combineLimit(0, g.downloadLimit)).toBe(g.downloadLimit);
    expect(combineLimit(5 * MiB, g.downloadLimit)).toBe(5 * MiB);
  });

  it('raises the limit step by step while healthy and lets go well above what downloads use', () => {
    const g = new DiskGuard();
    const feed = feeder(g);
    feed(12 * MiB);
    feed(12 * MiB, { backlogBytes: 50 * MiB, downloadRate: 30 * MiB });
    const start = g.downloadLimit!;
    // Half-full backlog: hold.
    for (let i = 0; i < 5; i++) expect(feed(12 * MiB, { backlogBytes: 20 * MiB, downloadRate: start })).toBe(false);
    expect(g.downloadLimit).toBe(start);
    // Healthy: up by a step every three samples.
    feed(12 * MiB, { downloadRate: start });
    feed(12 * MiB, { downloadRate: start });
    expect(feed(12 * MiB, { downloadRate: start })).toBe(true);
    expect(g.downloadLimit).toBe(Math.round(start * 1.25));
    // The swarm only delivers 2 MiB/s now: released once the limit is far above that.
    let steps = 0;
    while (g.active && steps < 100) {
      feed(2 * MiB, { downloadRate: 2 * MiB });
      steps++;
    }
    expect(g.active).toBe(false);
  });

  it('never limits below the floor, even when the disk stalls', () => {
    const g = new DiskGuard();
    const feed = feeder(g);
    feed(0);
    feed(0, { backpressured: 3, backlogBytes: 64 * MiB });
    expect(g.downloadLimit).toBe(DISK_GUARD_MIN_DOWN);
  });

  it('ignores a counter that went backwards (engine restarted) and resets cleanly', () => {
    const g = new DiskGuard();
    expect(g.observe({ at: 1000, writtenBytes: 100 * MiB, backlogBytes: 0, backlogLimitBytes: 0, backpressured: 0, downloadRate: 0 })).toBe(false);
    expect(g.observe({ at: 6000, writtenBytes: MiB, backlogBytes: 64 * MiB, backlogLimitBytes: 64 * MiB, backpressured: 1, downloadRate: 0 })).toBe(false);
    g.reset();
    expect(g.active).toBe(false);
    expect(g.writeRate).toBe(0);
  });
});
