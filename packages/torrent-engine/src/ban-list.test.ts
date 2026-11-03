import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAN_BASE_MS, BAN_MAX_MS, BanList } from './ban-list.js';

const H = 60 * 60 * 1000;

describe('BanList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('bans for 1 h, then lets the IP back in', () => {
    const bans = new BanList({ now: () => Date.now() });
    expect(bans.ban('203.0.113.5')).toBe(BAN_BASE_MS);
    expect(BAN_BASE_MS).toBe(H);
    expect(bans.has('203.0.113.5')).toBe(true);
    expect(bans.bannedUntil('203.0.113.5')).toBe(Date.now() + H);
    // already banned: no change
    expect(bans.ban('203.0.113.5')).toBe(0);
    vi.advanceTimersByTime(H - 1);
    expect(bans.has('203.0.113.5')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(bans.has('203.0.113.5')).toBe(false);
    expect(bans.bannedUntil('203.0.113.5')).toBeNull();
  });

  it('doubles each repeat ban up to 24 h', () => {
    const bans = new BanList({ now: () => Date.now() });
    const lengths: number[] = [];
    for (let i = 0; i < 8; i++) {
      const ms = bans.ban('198.51.100.7');
      lengths.push(ms / H);
      vi.advanceTimersByTime(ms);
      expect(bans.has('198.51.100.7')).toBe(false);
    }
    expect(lengths).toEqual([1, 2, 4, 8, 16, 24, 24, 24]);
    expect(BAN_MAX_MS).toBe(24 * H);
  });

  it('forgets the repeat count a day after the last ban ended', () => {
    const bans = new BanList({ now: () => Date.now() });
    bans.ban('192.0.2.1');
    vi.advanceTimersByTime(H);
    expect(bans.ban('192.0.2.1')).toBe(2 * H);
    vi.advanceTimersByTime(2 * H + 24 * H);
    expect(bans.ban('192.0.2.1')).toBe(H);
  });

  it('normalizes IPv4-mapped addresses', () => {
    const bans = new BanList({ now: () => Date.now() });
    bans.ban('::ffff:192.0.2.9');
    expect(bans.has('192.0.2.9')).toBe(true);
  });

  it('stays bounded: forgotten entries first, then the oldest', () => {
    const bans = new BanList({ now: () => Date.now(), maxEntries: 3 });
    bans.ban('192.0.2.1');
    vi.advanceTimersByTime(30 * H); // .1 forgotten
    bans.ban('192.0.2.2');
    bans.ban('192.0.2.3');
    bans.ban('192.0.2.4'); // prunes .1
    expect(bans.size).toBe(3);
    expect(bans.has('192.0.2.2')).toBe(true);
    bans.ban('192.0.2.5'); // evicts the oldest (.2)
    expect(bans.size).toBe(3);
    expect(bans.has('192.0.2.2')).toBe(false);
    expect(['192.0.2.3', '192.0.2.4', '192.0.2.5'].every((ip) => bans.has(ip))).toBe(true);
  });
});
