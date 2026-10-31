import { describe, expect, it } from 'vitest';
import { combineLimit, GUARD_FORGET_MS, GUARD_MIN_CONNECTIONS, GUARD_MIN_DOWN, TunnelGuard, type GuardRates } from './tunnel-guard.js';

const MiB = 1024 * 1024;
const rates = (down: number, up = 0, extra: Partial<GuardRates> = {}): GuardRates => ({ down, up, connections: 100, maxConnections: 200, at: 0, ...extra });

describe('TunnelGuard', () => {
  it('stays out of the way while the tunnel is healthy', () => {
    const g = new TunnelGuard();
    for (let i = 0; i < 10; i++) expect(g.observe(120 + (i % 3) * 10, rates(20 * MiB, MiB))).toBe(false);
    expect(g.active).toBe(false);
  });

  it('cuts to 60% of what flows on a choke and remembers the rate it choked at', () => {
    const g = new TunnelGuard();
    for (let i = 0; i < 5; i++) g.observe(100, rates(20 * MiB, 2 * MiB));
    expect(g.observe(700, rates(20 * MiB, 2 * MiB))).toBe(true); // 600 ms of queuing
    expect(g.downloadLimit).toBe(12 * MiB);
    expect(g.downloadCeiling).toBe(17 * MiB);
    expect(g.uploadLimit).toBe(Math.round(2 * MiB * 0.6));
  });

  it('holds between target and choke delay, and skips one probe after a cut so the queue drains', () => {
    const g = new TunnelGuard();
    for (let i = 0; i < 5; i++) g.observe(100, rates(20 * MiB));
    g.observe(-1, rates(20 * MiB));
    const cut = g.downloadLimit;
    expect(g.observe(-1, rates(12 * MiB))).toBe(false); // cooldown
    expect(g.downloadLimit).toBe(cut);
    expect(g.observe(350, rates(12 * MiB))).toBe(false); // 250 ms: hold
    expect(g.downloadLimit).toBe(cut);
  });

  it('climbs back to the ceiling quickly, then creeps above it only while the room is used', () => {
    const g = new TunnelGuard();
    for (let i = 0; i < 5; i++) g.observe(100, rates(20 * MiB));
    g.observe(-1, rates(20 * MiB));
    const ceiling = g.downloadCeiling!;
    for (let i = 0; i < 5; i++) g.observe(110, rates(10 * MiB));
    expect(g.downloadLimit).toBe(ceiling);
    // the swarm delivers less than the limit: no evidence the tunnel takes more
    for (let i = 0; i < 50; i++) g.observe(110, rates(5 * MiB));
    expect(g.downloadLimit).toBe(ceiling);
    // used to the full: +5% every ten healthy probes
    for (let i = 0; i < 10; i++) g.observe(110, rates(ceiling));
    expect(g.downloadLimit).toBe(Math.round(ceiling * 1.05));
    expect(g.downloadCeiling).toBe(ceiling);
  });

  it('does not let go after recovering (the old sawtooth); forgets only after hours without a choke', () => {
    const g = new TunnelGuard();
    for (let i = 0; i < 5; i++) g.observe(100, rates(20 * MiB));
    g.observe(-1, rates(20 * MiB));
    for (let i = 0; i < 200; i++) g.observe(110, rates(MiB, 0, { at: i * 3000 }));
    expect(g.active).toBe(true);
    expect(g.observe(110, rates(MiB, 0, { at: GUARD_FORGET_MS + 1 }))).toBe(true);
    expect(g.active).toBe(false);
  });

  it('a repeat choke lowers the ceiling, never raises it', () => {
    const g = new TunnelGuard();
    for (let i = 0; i < 5; i++) g.observe(100, rates(20 * MiB));
    g.observe(-1, rates(20 * MiB));
    g.observe(110, rates(12 * MiB));
    g.observe(-1, rates(30 * MiB));
    expect(g.downloadCeiling).toBe(17 * MiB);
    g.observe(110, rates(8 * MiB));
    g.observe(-1, rates(8 * MiB));
    expect(g.downloadCeiling).toBeLessThan(17 * MiB);
  });

  it('treats a slow tunnel as choking even when it was slow from the first probe', () => {
    const g = new TunnelGuard();
    expect(g.observe(1500, rates(5 * MiB, MiB))).toBe(true);
    expect(g.active).toBe(true);
  });

  it('leaves a direction that carries next to nothing alone, and never limits below the floor', () => {
    const g = new TunnelGuard();
    g.observe(-1, rates(5 * MiB, 0));
    expect(g.uploadLimit).toBe(null);
    for (let i = 0; i < 30; i++) g.observe(-1, rates(0, 0));
    expect(g.downloadLimit).toBe(GUARD_MIN_DOWN);
  });

  it('halves the connection cap with the rates, floors it, and gives it back step by step', () => {
    const g = new TunnelGuard();
    g.observe(-1, rates(5 * MiB, MiB, { connections: 286, maxConnections: 300 }));
    expect(g.connectionLimit).toBe(143);
    for (let i = 0; i < 20; i++) g.observe(-1, rates(0, 0, { connections: 40, maxConnections: 300 }));
    expect(g.connectionLimit).toBe(GUARD_MIN_CONNECTIONS);
    let steps = 0;
    while (g.connectionLimit !== null && steps < 200) {
      g.observe(100, rates(0, 0, { connections: 40, maxConnections: 300 }));
      steps++;
    }
    expect(g.connectionLimit).toBe(null);
    expect(steps).toBeLessThan(30);
  });

  it('never raises the connection cap above a user cap that is already low', () => {
    const g = new TunnelGuard();
    g.observe(-1, rates(MiB, MiB, { connections: 30, maxConnections: 30 }));
    expect(g.connectionLimit).toBe(null);
    expect(g.active).toBe(true);
  });

  it('combines with the user limit (0 = unlimited)', () => {
    expect(combineLimit(0, null)).toBe(0);
    expect(combineLimit(0, 5)).toBe(5);
    expect(combineLimit(3, 5)).toBe(3);
    expect(combineLimit(9, 5)).toBe(5);
  });
});
