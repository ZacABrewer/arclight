import { describe, expect, it } from 'vitest';
import { combineLimit, GUARD_MIN_DOWN, GUARD_MIN_UP, TunnelGuard } from './tunnel-guard.js';

const MiB = 1024 * 1024;

describe('TunnelGuard', () => {
  it('stays out of the way while the tunnel is healthy', () => {
    const g = new TunnelGuard();
    for (let i = 0; i < 10; i++) expect(g.observe(120 + (i % 3) * 10, { down: 20 * MiB, up: MiB })).toBe(false);
    expect(g.active).toBe(false);
  });

  it('halves the rates on a latency spike or failed probe, then eases back and lets go', () => {
    const g = new TunnelGuard();
    for (let i = 0; i < 5; i++) g.observe(100, { down: 20 * MiB, up: 2 * MiB });
    expect(g.observe(2000, { down: 20 * MiB, up: 2 * MiB })).toBe(true);
    expect(g.downloadLimit).toBe(10 * MiB);
    expect(g.uploadLimit).toBe(MiB);
    g.observe(-1, { down: 10 * MiB, up: MiB });
    expect(g.downloadLimit).toBe(5 * MiB);
    // three healthy probes per step up; released once well above what the engine uses
    let steps = 0;
    while (g.active && steps < 200) {
      g.observe(110, { down: 4 * MiB, up: 0.5 * MiB });
      steps++;
    }
    expect(g.active).toBe(false);
    expect(steps).toBeLessThan(30);
  });

  it('never limits below the floor', () => {
    const g = new TunnelGuard();
    for (let i = 0; i < 30; i++) g.observe(-1, { down: 0, up: 0 });
    expect(g.downloadLimit).toBe(GUARD_MIN_DOWN);
    expect(g.uploadLimit).toBe(GUARD_MIN_UP);
  });

  it('combines with the user limit (0 = unlimited)', () => {
    expect(combineLimit(0, null)).toBe(0);
    expect(combineLimit(0, 5)).toBe(5);
    expect(combineLimit(3, 5)).toBe(3);
    expect(combineLimit(9, 5)).toBe(5);
  });
});
