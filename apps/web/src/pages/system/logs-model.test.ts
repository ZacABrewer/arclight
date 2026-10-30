import { describe, expect, it } from 'vitest';
import type { LogRecord } from '@arclight/shared';
import { formatCountdown } from '../activity/pending-page.js';
import { matchesLogFilter, mergeLive, visibleRecords } from './logs-model.js';

const rec = (id: number, over: Partial<LogRecord> = {}): LogRecord => ({
  id,
  time: '2026-10-25T10:00:00.000Z',
  level: 'info',
  message: `message ${id}`,
  ...over,
});

describe('log filtering', () => {
  it('filters by minimum level and searches message, component and context', () => {
    expect(matchesLogFilter(rec(1, { level: 'debug' }), { level: 'info' })).toBe(false);
    expect(matchesLogFilter(rec(1, { level: 'fatal' }), { level: 'warn' })).toBe(true);
    expect(matchesLogFilter(rec(1, { component: 'Scheduler' }), { search: 'sched' })).toBe(true);
    expect(matchesLogFilter(rec(1, { context: { url: '/api/v1/Queue' } }), { search: 'queue' })).toBe(true);
    expect(matchesLogFilter(rec(1), { search: 'nope' })).toBe(false);
    expect(matchesLogFilter(rec(1), {})).toBe(true);
  });

  it('applies the forgiving list-search rule to live records', () => {
    const r = rec(7, { level: 'warn', component: 'download_client', message: 'Grab failed for Show.Name.S01E02' });
    expect(matchesLogFilter(r, { search: 'show name s01e02' })).toBe(true);
    expect(matchesLogFilter(r, { search: 'download-client grab' })).toBe(true);
    expect(matchesLogFilter(r, { search: 'warn failed' })).toBe(true);
    expect(matchesLogFilter(r, { search: 'grab missing' })).toBe(false);
  });

  it('merges streamed records newest first without duplicates, capped', () => {
    const merged = mergeLive([rec(3), rec(2)], [rec(4), rec(5), rec(3)], 4);
    expect(merged.map((r) => r.id)).toEqual([5, 4, 3, 2]);
  });

  it('puts matching live records above the fetched page while following', () => {
    const fetched = [rec(10), rec(9), rec(8)];
    const live = [rec(12, { level: 'error' }), rec(11), rec(9)];
    expect(visibleRecords(fetched, live, {}, 4).map((r) => r.id)).toEqual([12, 11, 10, 9]);
    expect(visibleRecords(fetched, live, { level: 'error' }, 10).map((r) => r.id)).toEqual([12, 10, 9, 8]);
  });
});

describe('pending countdown', () => {
  it('counts down to the eligible time and says due afterwards', () => {
    const now = Date.parse('2026-10-25T10:00:00Z');
    expect(formatCountdown('2026-10-25T10:01:05Z', now)).toBe('00:01:05');
    expect(formatCountdown('2026-10-26T12:00:00Z', now)).toBe('1d 02:00:00');
    expect(formatCountdown('2026-10-25T09:00:00Z', now)).toBe('due');
  });
});
