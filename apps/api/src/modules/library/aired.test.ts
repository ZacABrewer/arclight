import { episodeAiredMs } from '@arclight/shared';
import { describe, expect, it } from 'vitest';
import { computeSeasonStatistics } from './service.js';

const NOW = '2026-06-01T12:00:00.000Z';

describe('aired episodes without an exact air time', () => {
  it('falls back to the air date', () => {
    expect(episodeAiredMs({ airDateUtc: '2026-05-01T01:00:00Z', airDate: '2026-04-30' })).toBe(Date.parse('2026-05-01T01:00:00Z'));
    expect(episodeAiredMs({ airDateUtc: null, airDate: '2026-05-01' })).toBe(Date.parse('2026-05-01T00:00:00Z'));
    expect(episodeAiredMs({ airDateUtc: null, airDate: null })).toBeNull();
    expect(episodeAiredMs({ airDate: 'soon' })).toBeNull();
  });

  it('counts a monitored, dated, fileless episode against the total (it used to read 44/44)', () => {
    const stats = computeSeasonStatistics(
      [
        { seasonNumber: 1, monitored: true, hasFile: true, airDateUtc: '2026-01-01T00:00:00Z' },
        { seasonNumber: 1, monitored: true, hasFile: false, airDateUtc: null, airDate: '2026-02-01' },
        { seasonNumber: 1, monitored: true, hasFile: false, airDateUtc: null, airDate: '2026-09-01' },
      ],
      [],
      NOW,
    );
    expect(stats.episodeFileCount).toBe(1);
    expect(stats.episodeCount).toBe(2);
    expect(stats.percentOfEpisodes).toBe(50);
  });
});
