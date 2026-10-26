import { describe, expect, it } from 'vitest';
import { countStatuses, episodeStatus, hasAired } from './episode-status.js';
import { destinationPath, folderName, sanitizeFolderName } from './path-preview.js';
import { formatBytes } from './format.js';

const now = new Date('2026-10-25T12:00:00Z');
const ep = (over: Partial<{ hasFile: boolean; monitored: boolean; airDate: string | null; airDateUtc: string | null }>) => ({
  hasFile: false,
  monitored: true,
  airDate: null,
  airDateUtc: null,
  ...over,
});

describe('episodeStatus', () => {
  it('is downloaded whenever there is a file, even if unaired or unmonitored', () => {
    expect(episodeStatus(ep({ hasFile: true, monitored: false, airDateUtc: '2027-01-01T00:00:00Z' }), { now })).toBe('downloaded');
  });

  it('is wanted when aired, monitored and missing a file', () => {
    expect(episodeStatus(ep({ airDateUtc: '2026-10-01T01:00:00Z' }), { now })).toBe('wanted');
  });

  it('is missing (not wanted) when aired but unmonitored', () => {
    expect(episodeStatus(ep({ monitored: false, airDateUtc: '2026-10-01T01:00:00Z' }), { now })).toBe('missing');
  });

  it('is missing when the series itself is unmonitored', () => {
    expect(episodeStatus(ep({ airDateUtc: '2026-10-01T01:00:00Z' }), { now, seriesMonitored: false })).toBe('missing');
  });

  it('is unaired for a future air time and tba without any date', () => {
    expect(episodeStatus(ep({ airDateUtc: '2026-10-25T13:00:00Z' }), { now })).toBe('unaired');
    expect(episodeStatus(ep({}), { now })).toBe('tba');
  });

  it('falls back to the date-only air date', () => {
    const local = new Date(2026, 9, 25, 12);
    expect(hasAired({ airDate: '2026-10-25', airDateUtc: null }, local)).toBe(true);
    expect(hasAired({ airDate: '2026-10-26', airDateUtc: null }, local)).toBe(false);
    expect(hasAired({ airDate: null, airDateUtc: null }, local)).toBeNull();
  });

  it('counts statuses for a season header', () => {
    const counts = countStatuses(
      [ep({ hasFile: true }), ep({ airDateUtc: '2026-01-01T00:00:00Z' }), ep({ airDateUtc: '2027-01-01T00:00:00Z' })],
      { now },
    );
    expect(counts).toEqual({ downloaded: 1, wanted: 1, missing: 0, unaired: 1, tba: 0 });
  });
});

describe('path preview', () => {
  it('turns colons into dashes and drops illegal characters', () => {
    expect(sanitizeFolderName('Star Wars: Andor?')).toBe('Star Wars - Andor');
    expect(sanitizeFolderName('What If...?')).toBe('What If');
    expect(sanitizeFolderName('???')).toBe('Untitled');
  });

  it('appends the year when known', () => {
    expect(folderName('Dune', 2021)).toBe('Dune (2021)');
    expect(folderName('Dune', undefined)).toBe('Dune');
  });

  it("joins with the root folder's separator", () => {
    expect(destinationPath('/data/tv/', 'The Expanse', 2015)).toBe('/data/tv/The Expanse (2015)');
    expect(destinationPath('D:\\Media\\TV', 'Severance', 2022)).toBe('D:\\Media\\TV\\Severance (2022)');
    expect(destinationPath('', 'X', 1)).toBe('');
  });
});

describe('formatBytes', () => {
  it('uses binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(null)).toBe('—');
  });
});
