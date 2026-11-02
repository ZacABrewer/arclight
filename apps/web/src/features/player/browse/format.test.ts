import { describe, expect, it } from 'vitest';
import { albumGroup, clockTime, groupAlbums, groupByDisc, isInProgress, lengthLabel, names, progressShare, shuffled, timeLeftLabel } from './format.js';
import { album, progress, track } from './test-utils.js';

describe('format helpers', () => {
  it('formats clock times', () => {
    expect(clockTime(0)).toBe('0:00');
    expect(clockTime(187_000)).toBe('3:07');
    expect(clockTime(3_723_000)).toBe('1:02:03');
    expect(clockTime(-5)).toBe('0:00');
  });

  it('formats lengths', () => {
    expect(lengthLabel(10_000)).toBe('1 m');
    expect(lengthLabel(48 * 60_000)).toBe('48 m');
    expect(lengthLabel(83 * 60_000)).toBe('1 h 23 m');
  });

  it('measures progress', () => {
    expect(progressShare(null)).toBe(0);
    expect(progressShare(progress('audiobook:1', { positionMs: 50, durationMs: 200 }))).toBe(0.25);
    expect(progressShare(progress('audiobook:1', { positionMs: 50, durationMs: 0 }), 100)).toBe(0.5);
    expect(progressShare(progress('audiobook:1', { played: true }))).toBe(1);
    expect(isInProgress(progress('audiobook:1', { positionMs: 1 }))).toBe(true);
    expect(isInProgress(progress('audiobook:1', { positionMs: 1, played: true }))).toBe(false);
    expect(isInProgress(progress('audiobook:1'))).toBe(false);
    expect(timeLeftLabel(progress('audiobook:1', { positionMs: 60 * 60_000, durationMs: 3 * 60 * 60_000 }), 0)).toBe('2 h 0 m left');
  });

  it('shuffles a copy and keeps every item', () => {
    const src = ['a', 'b', 'c', 'd'];
    const out = shuffled(src, () => 0);
    expect(out).not.toBe(src);
    expect(src).toEqual(['a', 'b', 'c', 'd']);
    expect([...out].sort()).toEqual(src);
    expect(out).toEqual(['b', 'c', 'd', 'a']);
  });

  it('groups tracks by disc keeping the play index', () => {
    const groups = groupByDisc([track(1, { discNumber: 2 }), track(2, { discNumber: 1 }), track(3, { discNumber: null })]);
    expect(groups.map((g) => g.disc)).toEqual([1, 2]);
    expect(groups[0]?.tracks.map((x) => x.index)).toEqual([1, 2]);
    expect(groups[1]?.tracks.map((x) => x.index)).toEqual([0]);
  });

  it('groups albums by release type, newest first', () => {
    expect(albumGroup('LP')).toBe('album');
    expect(albumGroup('EP')).toBe('ep');
    expect(albumGroup('Single')).toBe('single');
    expect(albumGroup(null)).toBe('other');
    const g = groupAlbums([album(1, { year: 2001 }), album(2, { year: 2010 }), album(3, { albumType: 'Single' })]);
    expect(g.map((x) => x.group)).toEqual(['album', 'single']);
    expect(g[0]?.albums.map((a) => a.id)).toEqual([2, 1]);
  });

  it('joins names', () => {
    expect(names([])).toBeNull();
    expect(names(['A', 'B'])).toBe('A, B');
  });
});
