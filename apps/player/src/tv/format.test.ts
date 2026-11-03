import { describe, expect, it } from 'vitest';
import { clock, fraction, kickerLabel, left, leftLabel, metaItems, pct, playLabel, typeInto, weekdayName } from './format';

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(',')}` : key);
const prog = (positionMs: number, durationMs: number, played = false) => ({ positionMs, durationMs, played, updatedAt: '2026-01-01T00:00:00Z' });

describe('TV text', () => {
  it('formats time left like the design', () => {
    expect(left(45 * 60)).toBe('45m');
    expect(left(112 * 60)).toBe('1h 52m');
    expect(left(5)).toBe('1m');
  });

  it('labels progress only when there is a place to resume', () => {
    expect(leftLabel(prog(30 * 60_000, 57 * 60_000) as never, t)).toBe('app.tv.left:27m');
    expect(leftLabel(prog(0, 57 * 60_000) as never, t)).toBeNull();
    expect(leftLabel(prog(10, 57 * 60_000, true) as never, t)).toBeNull();
    expect(leftLabel(null, t)).toBeNull();
  });

  it('fraction and pct', () => {
    expect(fraction(prog(25, 100) as never)).toBe(0.25);
    expect(fraction(prog(0, 100, true) as never)).toBe(1);
    expect(fraction(prog(0, 100) as never)).toBeNull();
    expect(pct(0.256)).toBe('25.6%');
    expect(pct(2)).toBe('100%');
    expect(pct(null)).toBe('0%');
  });

  it('play labels: Play, Resume, and the episode forms', () => {
    expect(playLabel('movie', null, t)).toBe('app.tv.play');
    expect(playLabel('movie', { seasonNumber: null, episodeNumber: null, progress: prog(10, 100) as never }, t)).toBe('app.tv.resume');
    expect(playLabel('series', { seasonNumber: 1, episodeNumber: 1, progress: null }, t)).toBe('app.tv.playEpisode:1,1');
    expect(playLabel('series', { seasonNumber: 2, episodeNumber: 5, progress: prog(10, 100) as never }, t)).toBe('app.tv.resumeEpisode:2,5');
  });

  it('kickers, with the weekday for new episodes', () => {
    expect(kickerLabel('just-added', null, t)).toBe('app.tv.kicker.justAdded');
    expect(kickerLabel('new-episode', null, t)).toBe('app.tv.kicker.newEpisode');
    expect(kickerLabel('new-episode', 5, t, 'en')).toBe('app.tv.kicker.newEpisodeEvery:Friday');
    expect(weekdayName(0, 'en')).toBe('Sunday');
  });

  it('meta line: year, boxed rating, seasons or runtime, genres, chips', () => {
    expect(metaItems({ year: 2026, certification: 'TV-14', seasonCount: 3, genres: ['Drama', 'Thriller'], chips: null }, t)).toEqual([
      { text: '2026', kind: 'plain' },
      { text: 'TV-14', kind: 'boxed' },
      { text: 'app.tv.seasons:3', kind: 'plain' },
      { text: 'Drama, Thriller', kind: 'plain' },
    ]);
    expect(metaItems({ year: null, certification: null, runtimeMinutes: 128, genres: [] }, t)).toEqual([{ text: '2h 8m', kind: 'plain' }]);
  });

  it('clock and search typing', () => {
    expect(clock(65_000)).toBe('1:05');
    expect(clock(3_725_000)).toBe('1:02:05');
    expect(typeInto('', ' ')).toBe('');
    expect(typeInto('a'.repeat(32), 'b')).toHaveLength(32);
  });
});
