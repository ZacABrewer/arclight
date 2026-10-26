import { describe, expect, it } from 'vitest';
import type { CalendarItem } from '@arclight/shared';
import { localIsoDate } from '../../components/media/episode-status.js';
import { makeEpisode } from '../library/test-fixtures.js';
import { buildFeedUrl } from './calendar-page.js';
import { addMonths, barTone, gridRange, groupByDay, monthGrid, stepAnchor, toEntry, viewDays, weekDays, weekdayLabels } from './calendar-math.js';

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

  it('tones bars: downloaded solid, unaired/tba upcoming, everything else missing', () => {
    expect(barTone('downloaded')).toBe('downloaded');
    expect(barTone('unaired')).toBe('upcoming');
    expect(barTone('tba')).toBe('upcoming');
    expect(barTone('wanted')).toBe('missing');
    expect(barTone('missing')).toBe('missing');
  });

  it('keeps a 24h mono time, the hour and a search body on timed entries', () => {
    const t = new Date(2026, 9, 21, 21, 30).toISOString();
    const e = toEntry(episodeItem(t, { id: 7, seasonNumber: 1, episodeNumber: 2, airDateUtc: t }), now)!;
    expect(e).toMatchObject({ time: '21:30', hour: 21.5, code: 'S01E02', search: { episodeIds: [7] } });
    expect(toEntry(movieItem('2026-12-01', false), now)!).toMatchObject({ hour: null, search: { movieId: 9 }, code: 'Digital release' });
  });
});

describe('view ranges', () => {
  it('week starts on Monday and day is a single date', () => {
    const days = weekDays(new Date(2026, 9, 15));
    expect(days.map(localIsoDate)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
    expect(viewDays('day', new Date(2026, 9, 15, 13)).map(localIsoDate)).toEqual(['2026-10-15']);
    expect(viewDays('month', new Date(2026, 9, 15))).toHaveLength(35);
  });

  it('steps by a week, a day or a month', () => {
    const a = new Date(2026, 9, 15);
    expect(localIsoDate(stepAnchor('week', a, 1))).toBe('2026-10-22');
    expect(localIsoDate(stepAnchor('day', a, -1))).toBe('2026-10-14');
    expect(localIsoDate(stepAnchor('month', a, 1))).toBe('2026-11-01');
  });
});
