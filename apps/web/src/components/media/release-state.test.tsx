import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { daysAgo, rangePreset } from '../../pages/wanted/release-filter.js';
import { dateReleaseState, episodeReleaseState, movieReleaseState, UnreleasedSearchNotice } from './release-state.js';

const NOW = Date.parse('2026-03-01T12:00:00Z');

describe('release state', () => {
  it('episodes by air time, albums / books by (partial) release date, movies by isAvailable', () => {
    expect(episodeReleaseState({ airDateUtc: '2026-03-01T11:00:00Z' }, NOW)).toEqual({ released: true, date: '2026-03-01T11:00:00.000Z' });
    expect(episodeReleaseState({ airDate: '2026-03-02', airDateUtc: null }, NOW)).toEqual({ released: false, date: '2026-03-02T00:00:00.000Z' });
    expect(episodeReleaseState({ airDate: null, airDateUtc: null }, NOW)).toEqual({ released: false, date: null });
    expect(dateReleaseState({ releaseDate: '2026' }, NOW).released).toBe(true);
    expect(dateReleaseState({ releaseDate: '2026-04' }, NOW)).toEqual({ released: false, date: '2026-04-01T00:00:00.000Z' });
    const movie = { isAvailable: false, status: 'inCinemas', minimumAvailability: 'released', inCinemas: '2026-02-01', digitalRelease: '2026-05-01', physicalRelease: null } as const;
    expect(movieReleaseState(movie)).toEqual({ released: false, date: '2026-05-01T00:00:00.000Z' });
  });

  it('interactive search warns about an unreleased item, and says nothing otherwise', () => {
    const { rerender } = render(<UnreleasedSearchNotice state={{ released: false, date: '2026-05-01T00:00:00.000Z' }} />);
    expect(screen.getByRole('status').textContent).toMatch(/Not released yet \(expected .*2026\)/);
    rerender(<UnreleasedSearchNotice state={{ released: false, date: null }} />);
    expect(screen.getByRole('status').textContent).toMatch(/no release date known/);
    rerender(<UnreleasedSearchNotice state={{ released: true, date: '2020-01-01T00:00:00.000Z' }} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('date range presets', () => {
    expect(daysAgo(7, NOW)).toBe('2026-02-22');
    expect(rangePreset({}, NOW)).toBe('any');
    expect(rangePreset({ releasedAfter: '2026-01-30' }, NOW)).toBe('30d');
    expect(rangePreset({ releasedAfter: '2025-03-01' }, NOW)).toBe('1y');
    expect(rangePreset({ releasedAfter: '2026-01-29' }, NOW)).toBe('custom');
    expect(rangePreset({ releasedAfter: '2026-02-22', releasedBefore: '2026-02-28' }, NOW)).toBe('custom');
  });
});
