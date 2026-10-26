import { describe, expect, it } from 'vitest';
import type { CalendarItem } from '@arclight/shared';
import { localIsoDate } from '../../components/media/episode-status.js';
import { makeEpisode } from '../library/test-fixtures.js';
import { buildFeedUrl } from './calendar-page.js';
import { addMonths, gridRange, groupByDay, monthGrid, toEntry, weekdayLabels } from './calendar-math.js';

describe('monthGrid', () => {
  it('covers whole Monday-first weeks around the month', () => {
    // October 2026: the 1st is a Thursday, the 31st a Saturday.
    const days = monthGrid(new Date(2026, 9, 15), 1);
    expect(days.length % 7).toBe(0);
    expect(localIsoDate(days[0]!)).toBe('2026-09-28');
    expect(localIsoDate(days.at(-1)!)).toBe('2026-11-01');
    expect(days[0]!.getDay()).toBe(1);
    expect(days.length).toBe(35);
  });

  it('supports Sunday-first weeks', () => {
    const days = monthGrid(new Date(2026, 9, 1), 0);
    expect(localIsoDate(days[0]!)).toBe('2026-09-27');
    expect(localIsoDate(days.at(-1)!)).toBe('2026-10-31');
  });

  it('needs six rows when the month spills over, four when it fits exactly', () => {
    // August 2026 starts on a Saturday: 5 leading days + 31 = 36 -> 6 weeks.
    expect(monthGrid(new Date(2026, 7, 1), 1).length).toBe(42);
    // February 2027 starts on a Monday and has 28 days.
    expect(monthGrid(new Date(2027, 1, 1), 1).length).toBe(28);
  });

  it('adds months across year boundaries', () => {
    expect(localIsoDate(addMonths(new Date(2026, 11, 31), 1))).toBe('2027-01-01');
    expect(localIsoDate(addMonths(new Date(2026, 0, 31), -1))).toBe('2025-12-01');
  });

  it('labels weekdays in grid order', () => {
    expect(weekdayLabels(1, 'en-US')[0]).toBe('Mon');
    expect(weekdayLabels(0, 'en-US')[0]).toBe('Sun');
  });

  it('requests the whole grid from first-day midnight to last-day end', () => {
    const days = monthGrid(new Date(2026, 9, 1), 1);
    const range = gridRange(days);
    expect(new Date(range.start).getTime()).toBe(new Date(2026, 8, 28).getTime());
    expect(new Date(range.end).getTime()).toBe(new Date(2026, 10, 1, 23, 59, 59, 999).getTime());
  });
});

describe('calendar entries', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const episodeItem = (date: string, over: Parameters<typeof makeEpisode>[0]): CalendarItem => ({
    type: 'episode',
    date,
    seriesId: 4,
    seriesTitle: 'Severance',
    episode: makeEpisode({ seriesId: 4, ...over }),
  });
  const movieItem = (date: string, hasFile: boolean): CalendarItem => ({
    type: 'movie',
    date,
    releaseKind: 'digital',
    movie: {
      id: 9,
      tmdbId: 1,
      title: 'Dune',
      year: 2021,
      overview: '',
      status: 'released',
      monitored: true,
      hasFile,
      images: [],
      tags: [],
      qualityProfileId: 1,
    },
  });

  it('maps an episode to a day, code and status', () => {
    const e = toEntry(episodeItem('2026-10-20', { id: 3, seasonNumber: 2, episodeNumber: 3, airDate: '2026-10-20' }), now)!;
    expect(e).toMatchObject({ day: '2026-10-20', kind: 'episode', status: 'wanted', time: null });
    expect(e.detail).toBe('S02E03 · Episode 3');
    expect(e.link).toEqual({ to: '/library/series/$id', params: { id: '4' } });
  });

  it('maps a future movie release to unaired and an owned one to downloaded', () => {
    expect(toEntry(movieItem('2026-12-01', false), now)!.status).toBe('unaired');
    expect(toEntry(movieItem('2026-01-01', true), now)!).toMatchObject({ status: 'downloaded', detail: 'Digital release' });
  });

  it('groups by local day, all-day items first, then by time', () => {
    const t1 = new Date(2026, 9, 21, 21, 0).toISOString();
    const t2 = new Date(2026, 9, 21, 9, 0).toISOString();
    const groups = groupByDay(
      [
        episodeItem(t1, { id: 1, airDateUtc: t1 }),
        episodeItem(t2, { id: 2, airDateUtc: t2 }),
        movieItem('2026-10-21', false),
        episodeItem('not a date', { id: 5 }),
      ],
      now,
    );
    expect([...groups.keys()]).toEqual(['2026-10-21']);
    expect(groups.get('2026-10-21')!.map((e) => e.key)).toEqual(['m9-digital', 'e2', 'e1']);
  });

  it('builds an absolute iCal URL with the chosen options', () => {
    expect(buildFeedUrl('http://nas:7878', '/calendar/feed.ics?token=abc', { pastDays: 3, futureDays: 60, unmonitored: true })).toBe(
      'http://nas:7878/api/v1/calendar/feed.ics?token=abc&pastDays=3&futureDays=60&unmonitored=true',
    );
    expect(buildFeedUrl('http://nas:7878', '/api/v1/calendar/feed.ics', { pastDays: 7, futureDays: 28, unmonitored: false })).toBe(
      'http://nas:7878/api/v1/calendar/feed.ics?pastDays=7&futureDays=28',
    );
  });
});
