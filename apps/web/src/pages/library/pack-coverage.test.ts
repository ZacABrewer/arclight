import { describe, expect, it } from 'vitest';
import { packCoverageLabel, seasonRuns } from './pack-coverage.js';

describe('pack coverage', () => {
  it('writes seasons as compact runs', () => {
    expect(seasonRuns([1, 2, 3])).toBe('S01-S03');
    expect(seasonRuns([3, 1, 2, 5])).toBe('S01-S03, S05');
    expect(seasonRuns([2])).toBe('S02');
    expect(seasonRuns([])).toBe('');
  });

  it('labels packs with episodes and wanted counts', () => {
    expect(packCoverageLabel({ kind: 'multiSeason', seasons: [1, 2, 3], episodeCount: 36, wantedCount: 24 })).toBe('S01-S03, 36 episodes, 24 wanted');
    expect(packCoverageLabel({ kind: 'episodeRange', seasons: [1], episodeCount: 1, wantedCount: 1 })).toBe('S01, 1 episode, 1 wanted');
    expect(packCoverageLabel({ kind: 'partialSeason', seasons: [3], episodeCount: 10, wantedCount: 10, part: 2 })).toBe('S03 part 2, 10 episodes, 10 wanted');
    expect(packCoverageLabel({ kind: 'completeSeries', seasons: [1, 2], episodeCount: 20, wantedCount: 0 })).toBe('Complete series (S01-S02), 20 episodes, 0 wanted');
    expect(packCoverageLabel(undefined)).toBeNull();
  });
});
