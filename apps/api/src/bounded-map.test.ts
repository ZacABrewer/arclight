import { describe, expect, it } from 'vitest';
import { pruneMap } from './bounded-map.js';

describe('pruneMap', () => {
  it('drops expired entries, then the oldest until the cap holds', () => {
    const m = new Map<string, number>([['a', 1], ['b', 50], ['c', 60], ['d', 70]]);
    pruneMap(m, 10, (v) => v < 10);
    expect([...m.keys()]).toEqual(['b', 'c', 'd']);
    pruneMap(m, 2, () => false);
    expect([...m.keys()]).toEqual(['c', 'd']);
    pruneMap(m, 0, () => false);
    expect(m.size).toBe(0);
  });
});
