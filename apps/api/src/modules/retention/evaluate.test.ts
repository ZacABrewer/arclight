import { describe, expect, it } from 'vitest';
import type { RetentionCondition } from '@arclight/shared';
import { evaluateRule, formatSize, inScope, type EvaluationContext, type LibraryItemFacts, type RuleForEvaluation, type WatchFacts } from './evaluate.js';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function item(extra: Partial<LibraryItemFacts> = {}): LibraryItemFacts {
  return {
    mediaType: 'movie',
    id: 1,
    tmdbId: 100,
    tvdbId: null,
    imdbId: null,
    title: 'Harbour Lights',
    year: 2021,
    tags: [],
    rootFolderPath: '/movies',
    path: '/movies/Harbour Lights (2021)',
    added: ago(60),
    sizeBytes: 5 * 1024 ** 3,
    hasFiles: true,
    monitored: true,
    inCollection: false,
    ...extra,
  };
}

function rule(conditions: RetentionCondition[], extra: Partial<RuleForEvaluation> = {}): RuleForEvaluation {
  return { mediaType: 'movie', scope: { type: 'all' }, conditions, action: 'deleteFiles', keepIfRequestedWithinDays: null, keepIfInCollection: false, ...extra };
}

function watch(users: Array<[string, boolean, string | null]>, found = true): WatchFacts {
  const list = users.map(([name, played, lastPlayedAt]) => ({ name, played, lastPlayedAt }));
  const last = list.reduce<string | null>((acc, u) => (u.lastPlayedAt && (!acc || u.lastPlayedAt > acc) ? u.lastPlayedAt : acc), null);
  return { found, users: list, lastPlayedAt: last };
}

function ctx(w: WatchFacts | null, lastRequestedAt: string | null = null): EvaluationContext {
  return { now: NOW, watch: w, lastRequestedAt };
}

describe('inScope', () => {
  it('matches media type, tags and root folders', () => {
    expect(inScope({ mediaType: 'series', scope: { type: 'all' } }, item())).toBe(false);
    expect(inScope({ mediaType: 'movie', scope: { type: 'tags', tagIds: [3] } }, item({ tags: [1, 3] }))).toBe(true);
    expect(inScope({ mediaType: 'movie', scope: { type: 'tags', tagIds: [3] } }, item({ tags: [1] }))).toBe(false);
    expect(inScope({ mediaType: 'movie', scope: { type: 'rootFolders', paths: ['/movies/'] } }, item())).toBe(true);
    expect(inScope({ mediaType: 'movie', scope: { type: 'rootFolders', paths: ['D:\\Movies'] } }, item({ rootFolderPath: 'd:/movies', path: 'd:/movies/x' }))).toBe(true);
    expect(inScope({ mediaType: 'movie', scope: { type: 'rootFolders', paths: ['/movies4k'] } }, item())).toBe(false);
  });
});

describe('evaluateRule: watch conditions', () => {
  it('watchedByAll needs every user who can see the item to have played it', () => {
    const r = rule([{ type: 'watchedByAll' }]);
    const all = evaluateRule(r, item(), ctx(watch([['alice', true, ago(3)], ['bob', true, ago(5)]])));
    expect(all).toMatchObject({ match: true, reasons: ['watched by all 2 users'], watchedBy: ['alice', 'bob'] });
    expect(evaluateRule(r, item(), ctx(watch([['alice', true, ago(3)], ['bob', false, null]]))).match).toBe(false);
    expect(evaluateRule(r, item(), ctx(watch([], false))).match).toBe(false);
  });

  it('watchedByAny matches on a single watcher', () => {
    const r = rule([{ type: 'watchedByAny' }]);
    expect(evaluateRule(r, item(), ctx(watch([['alice', false, null], ['bob', true, ago(1)]]))).reasons).toEqual(['watched by bob']);
    expect(evaluateRule(r, item(), ctx(watch([['alice', false, null]]))).match).toBe(false);
  });

  it('watchedByUsers compares names case-insensitively and fails on unknown users', () => {
    const r = rule([{ type: 'watchedByUsers', users: ['Alice', 'bob'] }]);
    expect(evaluateRule(r, item(), ctx(watch([['alice', true, null], ['Bob', true, null], ['carol', false, null]]))).reasons).toEqual([
      'watched by Alice and bob',
    ]);
    expect(evaluateRule(r, item(), ctx(watch([['alice', true, null]]))).match).toBe(false);
  });

  it('notWatchedWithinDays: never or long ago, but only for items old enough and known to a server', () => {
    const r = rule([{ type: 'notWatchedWithinDays', days: 30 }]);
    expect(evaluateRule(r, item(), ctx(watch([['alice', false, null]]))).reasons).toEqual(['never watched, added 60 days ago']);
    expect(evaluateRule(r, item(), ctx(watch([['alice', true, ago(45)]]))).reasons).toEqual(['last watched 45 days ago']);
    expect(evaluateRule(r, item(), ctx(watch([['alice', true, ago(10)]]))).match).toBe(false);
    expect(evaluateRule(r, item({ added: ago(20) }), ctx(watch([['alice', false, null]]))).match).toBe(false);
    expect(evaluateRule(r, item(), ctx(watch([], false))).match).toBe(false);
  });

  it('never matches watch conditions without play-state data', () => {
    for (const c of [{ type: 'watchedByAll' }, { type: 'watchedByAny' }, { type: 'notWatchedWithinDays', days: 1 }] as RetentionCondition[]) {
      expect(evaluateRule(rule([c]), item(), ctx(null)).match).toBe(false);
    }
  });
});

describe('evaluateRule: library conditions', () => {
  it('addedOlderThanDays', () => {
    expect(evaluateRule(rule([{ type: 'addedOlderThanDays', days: 30 }]), item(), ctx(null)).reasons).toEqual(['added 60 days ago']);
    expect(evaluateRule(rule([{ type: 'addedOlderThanDays', days: 90 }]), item(), ctx(null)).match).toBe(false);
  });

  it('sizeAbove', () => {
    const r = rule([{ type: 'sizeAbove', bytes: 4 * 1024 ** 3 }]);
    expect(evaluateRule(r, item(), ctx(null)).reasons).toEqual(['5.0 GB on disk (over 4.0 GB)']);
    expect(evaluateRule(r, item({ sizeBytes: 1024 }), ctx(null)).match).toBe(false);
    expect(formatSize(512)).toBe('512 B');
  });

  it('requires every condition and reports a reason per condition', () => {
    const r = rule([{ type: 'watchedByAny' }, { type: 'addedOlderThanDays', days: 30 }, { type: 'sizeAbove', bytes: 1 }]);
    const ev = evaluateRule(r, item(), ctx(watch([['alice', true, ago(2)]])));
    expect(ev.match).toBe(true);
    expect(ev.reasons).toHaveLength(3);
    expect(evaluateRule(r, item({ added: ago(5) }), ctx(watch([['alice', true, ago(2)]]))).match).toBe(false);
  });
});

describe('evaluateRule: keep options and no-ops', () => {
  const r = rule([{ type: 'addedOlderThanDays', days: 1 }], { keepIfRequestedWithinDays: 30, keepIfInCollection: true });

  it('keeps recently requested items', () => {
    expect(evaluateRule(r, item(), ctx(null, ago(10)))).toMatchObject({ match: false, keptBy: 'requested 10 days ago' });
    expect(evaluateRule(r, item(), ctx(null, ago(40))).match).toBe(true);
  });

  it('keeps movies in a collection', () => {
    expect(evaluateRule(r, item({ inCollection: true }), ctx(null))).toMatchObject({ match: false, keptBy: 'part of a collection' });
  });

  it('skips items the action cannot change', () => {
    const unmonitor = rule([{ type: 'addedOlderThanDays', days: 1 }], { action: 'unmonitor' });
    expect(evaluateRule(unmonitor, item({ monitored: false }), ctx(null)).keptBy).toBe('already unmonitored');
    expect(evaluateRule(rule([{ type: 'addedOlderThanDays', days: 1 }]), item({ hasFiles: false }), ctx(null)).keptBy).toBe('no files on disk');
    const deleteItem = rule([{ type: 'addedOlderThanDays', days: 1 }], { action: 'deleteItem' });
    expect(evaluateRule(deleteItem, item({ hasFiles: false, monitored: false }), ctx(null)).match).toBe(true);
  });
});
