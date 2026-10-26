import { describe, expect, it } from 'vitest';
import { barLayout, failureRate, linePath, seriesMax } from './stats-model.js';

const days = [
  { date: '2026-10-01', queries: 0, grabs: 0, failures: 0 },
  { date: '2026-10-02', queries: 10, grabs: 2, failures: 1 },
  { date: '2026-10-03', queries: 5, grabs: 1, failures: 0 },
];

describe('indexer stats charts', () => {
  it('scales bars to the largest value', () => {
    const bars = barLayout(
      [
        { label: 'A', value: 10 },
        { label: 'B', value: 5 },
        { label: 'C', value: 0 },
      ],
      300,
      100,
      0,
    );
    expect(bars.map((b) => b.height)).toEqual([100, 50, 0]);
    expect(bars.map((b) => b.x)).toEqual([0, 100, 200]);
    expect(bars[1]!.y).toBe(50);
    expect(barLayout([], 300, 100)).toEqual([]);
  });

  it('draws a line path across the width on a shared scale', () => {
    expect(linePath(days, 'queries', 200, 100)).toBe('M0 100 L100 0 L200 50');
    const max = seriesMax(days, ['queries', 'grabs']);
    expect(max).toBe(10);
    expect(linePath(days, 'grabs', 200, 100, max)).toBe('M0 100 L100 80 L200 90');
    expect(linePath([], 'grabs', 200, 100)).toBe('');
  });

  it('formats failure rates', () => {
    expect(failureRate({ queries: 0, grabs: 0, failures: 0 })).toBe('—');
    expect(failureRate({ queries: 40, grabs: 8, failures: 2 })).toBe('4.2%');
  });
});
