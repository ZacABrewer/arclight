import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RetentionEvent } from '@arclight/notifications';
import type { RetentionRuleInputRaw } from '@arclight/shared';
import { mediaRequests } from '../../db/schema.js';
import { libraryService } from '../library/index.js';
import { MediaServerError } from '@arclight/media-servers';
import { setSection, getSection } from '../settings/service.js';
import { RetentionActions } from './actions.js';
import { RetentionError, RetentionService } from './service.js';
import { addMovie, addSeries, configured, daysAgo, FakeMediaServer, NOW, setupLibrary, type LibraryFixture } from './test-support.js';

let fx: LibraryFixture;
let clock: Date;
let jelly: FakeMediaServer;
let servers: FakeMediaServer[];
let events: RetentionEvent[];

beforeEach(async () => {
  fx = await setupLibrary();
  clock = NOW;
  jelly = new FakeMediaServer('jellyfin', 'Jelly');
  servers = [jelly];
  events = [];
});

afterEach(async () => {
  await rm(fx.tmp, { recursive: true, force: true });
});

function service(opts: { apply?: RetentionActions['apply'] } = {}) {
  return new RetentionService({
    db: fx.db,
    servers: () => servers.map((s) => configured(s)),
    apply: opts.apply ?? new RetentionActions(fx.db).apply,
    notify: async (e) => {
      events.push(e);
    },
    now: () => clock,
  });
}

const advanceDays = (days: number) => {
  clock = new Date(clock.getTime() + days * 86_400_000);
};

function watchedRule(extra: Partial<RetentionRuleInputRaw> = {}): RetentionRuleInputRaw {
  return { name: 'Watched movies', mediaType: 'movie', conditions: [{ type: 'watchedByAll' }], action: 'unmonitor', graceDays: 7, dryRun: false, ...extra };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('retention rules', () => {
  it('creates, lists, updates and deletes rules with defaults', () => {
    const svc = service();
    const created = svc.createRule({ name: 'Old shows', mediaType: 'series', conditions: [{ type: 'addedOlderThanDays', days: 365 }], action: 'deleteItem' });
    expect(created).toMatchObject({ id: 1, enabled: true, scope: { type: 'all' }, graceDays: 7, dryRun: true, addExclusion: false, keepIfRequestedWithinDays: null });
    expect(svc.listRules()).toHaveLength(1);
    const updated = svc.updateRule(created.id, { ...created, graceDays: 14, dryRun: false });
    expect(updated).toMatchObject({ graceDays: 14, dryRun: false });
    svc.deleteRule(created.id);
    expect(svc.listRules()).toEqual([]);
    expect(() => svc.getRule(created.id)).toThrow(RetentionError);
  });

  it('rejects invalid rules and duplicate names', () => {
    const svc = service();
    expect(() => svc.createRule({ name: 'x', mediaType: 'movie', conditions: [], action: 'unmonitor' })).toThrow(/conditions/);
    svc.createRule(watchedRule());
    expect(() => svc.createRule(watchedRule({ name: 'WATCHED MOVIES' }))).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });
});

describe('RetentionSweep: staging, grace and applying', () => {
  it('stages a watched movie with reasons and applies it only after the grace period', async () => {
    const id = await addMovie(fx, { tmdbId: 11, title: 'Harbour Lights' });
    jelly.user('alice');
    jelly.user('bob');
    jelly.play('alice', 'movie', { tmdbId: 11 }, { played: true, lastPlayedAt: daysAgo(2) });
    jelly.play('bob', 'movie', { tmdbId: 11 }, { played: true, lastPlayedAt: daysAgo(1) });
    const svc = service();
    svc.createRule(watchedRule());

    const first = await svc.sweep();
    expect(first).toMatchObject({ rulesEvaluated: 1, staged: 1, applied: 0 });
    const [candidate] = svc.listCandidates();
    expect(candidate).toMatchObject({
      mediaId: id,
      status: 'pending',
      reasons: ['watched by all 2 users'],
      watchedBy: ['alice', 'bob'],
      applyAfter: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'retention', totalStaged: 1, totalApplied: 0 });
    expect(libraryService.getMovie(fx.db, id).monitored).toBe(true);

    advanceDays(3);
    expect((await svc.sweep()).applied).toBe(0);
    expect(events).toHaveLength(1); // nothing new to report

    advanceDays(5);
    const due = await svc.sweep();
    expect(due).toMatchObject({ applied: 1, staged: 0 });
    expect(libraryService.getMovie(fx.db, id).monitored).toBe(false);
    expect(svc.listCandidates()[0]).toMatchObject({ status: 'applied', appliedAt: clock.toISOString() });
    expect(events[1]).toMatchObject({ totalApplied: 1, applied: [expect.objectContaining({ title: 'Harbour Lights', action: 'unmonitor' })] });
  });

  it('applies on the staging sweep when graceDays is 0', async () => {
    await addMovie(fx, { tmdbId: 11, title: 'A' });
    const svc = service();
    svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'unmonitor', graceDays: 0, dryRun: false });
    expect(await svc.sweep()).toMatchObject({ staged: 1, applied: 1 });
  });

  it('never applies candidates of a dry-run rule', async () => {
    const id = await addMovie(fx, { tmdbId: 11, title: 'A' });
    const svc = service();
    svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'unmonitor', graceDays: 0 });
    expect(await svc.sweep()).toMatchObject({ staged: 1, applied: 0 });
    advanceDays(30);
    await svc.sweep();
    expect(libraryService.getMovie(fx.db, id).monitored).toBe(true);
    expect(svc.listCandidates()[0]).toMatchObject({ status: 'pending', dryRun: true });
  });

  it('a dry-run sweep reports matches without staging, applying or notifying', async () => {
    await addMovie(fx, { tmdbId: 11, title: 'A' });
    const svc = service();
    svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'deleteItem', graceDays: 0, dryRun: false });
    const r = await svc.sweep({ dryRun: true });
    expect(r).toMatchObject({ dryRun: true, staged: 0, applied: 0, matches: [expect.objectContaining({ title: 'A', reasons: ['added 100 days ago'] })] });
    expect(svc.listCandidates()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('drops waiting candidates that stop matching', async () => {
    await addMovie(fx, { tmdbId: 11, title: 'A' });
    jelly.user('alice');
    jelly.play('alice', 'movie', { tmdbId: 11 }, { played: true });
    const svc = service();
    svc.createRule(watchedRule());
    await svc.sweep();
    expect(svc.listCandidates()).toHaveLength(1);
    jelly.user('bob');
    jelly.play('bob', 'movie', { tmdbId: 11 }, { played: false });
    const r = await svc.sweep();
    expect(r.dropped).toBe(1);
    expect(svc.listCandidates()).toEqual([]);
  });

  it('follows a rule grace change from the first sighting', async () => {
    await addMovie(fx, { tmdbId: 11, title: 'A' });
    const svc = service();
    const rule = svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'unmonitor', graceDays: 7, dryRun: false });
    await svc.sweep();
    svc.updateRule(rule.id, { ...rule, graceDays: 1 });
    advanceDays(2);
    expect((await svc.sweep()).applied).toBe(1);
  });

  it('drops waiting candidates of a disabled rule and does not evaluate it', async () => {
    await addMovie(fx, { tmdbId: 11, title: 'A' });
    const svc = service();
    const rule = svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'unmonitor', dryRun: false });
    await svc.sweep();
    svc.updateRule(rule.id, { ...rule, enabled: false });
    expect(await svc.sweep()).toMatchObject({ rulesEvaluated: 0, dropped: 1 });
  });
});

describe('RetentionSweep: pinning', () => {
  it('a kept candidate is never applied and survives later sweeps; deleting it unpins', async () => {
    const id = await addMovie(fx, { tmdbId: 11, title: 'A' });
    const svc = service();
    svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'unmonitor', graceDays: 1, dryRun: false });
    await svc.sweep();
    const [c] = svc.listCandidates();
    expect(svc.keep(c!.id)).toMatchObject({ status: 'kept', keptAt: NOW.toISOString() });
    advanceDays(5);
    expect((await svc.sweep()).applied).toBe(0);
    expect(svc.listCandidates({ status: 'kept' })).toHaveLength(1);
    expect(libraryService.getMovie(fx.db, id).monitored).toBe(true);

    svc.deleteCandidate(c!.id);
    expect(await svc.sweep()).toMatchObject({ staged: 1 });
  });

  it('cannot keep or re-apply an applied candidate', async () => {
    await addMovie(fx, { tmdbId: 11, title: 'A' });
    const svc = service();
    svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'unmonitor', graceDays: 0, dryRun: false });
    await svc.sweep();
    const [c] = svc.listCandidates();
    expect(() => svc.keep(c!.id)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    await expect(svc.applyCandidate(c!.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('RetentionSweep: media servers', () => {
  it('skips watch rules (and leaves their candidates alone) when a server fails', async () => {
    const id = await addMovie(fx, { tmdbId: 11, title: 'A' });
    jelly.user('alice');
    jelly.play('alice', 'movie', { tmdbId: 11 }, { played: true });
    const svc = service();
    svc.createRule(watchedRule({ graceDays: 1 }));
    svc.createRule({ name: 'Big', mediaType: 'movie', conditions: [{ type: 'sizeAbove', bytes: 10 }], action: 'unmonitor', graceDays: 30, dryRun: false });
    await svc.sweep();
    expect(svc.listCandidates()).toHaveLength(2);

    jelly.fail = new MediaServerError('jellyfin', 'network', 'Could not reach http://fake');
    advanceDays(3);
    const r = await svc.sweep();
    expect(r.rulesSkipped).toEqual([{ ruleId: 1, ruleName: 'Watched movies', reason: 'a media server could not be read' }]);
    expect(r.serverErrors).toEqual([{ server: 'Jelly', message: 'Could not reach http://fake' }]);
    expect(r).toMatchObject({ rulesEvaluated: 1, applied: 0, dropped: 0 });
    expect(libraryService.getMovie(fx.db, id).monitored).toBe(true);
    expect(svc.listCandidates({ ruleId: 1 })[0]!.status).toBe('pending');
  });

  it('skips watch rules when no server is flagged for retention', async () => {
    await addMovie(fx, { tmdbId: 11, title: 'A' });
    servers = [];
    const svc = service();
    svc.createRule(watchedRule());
    const r = await svc.sweep();
    expect(r.rulesSkipped[0]!.reason).toBe('no enabled media server is flagged for retention');
  });

  it('merges users across servers by name and matches items by any provider id', async () => {
    const plex = new FakeMediaServer('plex', 'Plex');
    servers = [jelly, plex];
    await addMovie(fx, { tmdbId: 11, title: 'A', imdbId: 'tt0011' });
    const seriesId = await addSeries(fx, { tmdbId: 21, tvdbId: 9021, title: 'Show' });
    jelly.user('Alice');
    plex.user('alice');
    plex.user('bob');
    jelly.play('Alice', 'movie', { tmdbId: 11 }, { played: false });
    plex.play('alice', 'movie', { imdbId: 'TT0011' }, { played: true });
    plex.play('bob', 'movie', { imdbId: 'tt0011' }, { played: true });
    plex.play('alice', 'series', { tvdbId: 9021 }, { played: true });
    plex.play('bob', 'series', { tvdbId: 9021 }, { played: true });
    const svc = service();
    svc.createRule(watchedRule());
    svc.createRule(watchedRule({ name: 'Watched shows', mediaType: 'series' }));
    await svc.sweep();
    const candidates = svc.listCandidates();
    expect(candidates.map((c) => [c.mediaType, c.reasons[0]])).toEqual([
      ['movie', 'watched by all 2 users'],
      ['series', 'watched by all 2 users'],
    ]);
    expect(candidates[1]!.mediaId).toBe(seriesId);
  });

  it('ignores disabled server users', async () => {
    await addMovie(fx, { tmdbId: 11, title: 'A' });
    jelly.user('alice');
    jelly.user('ghost', { isDisabled: true });
    jelly.play('alice', 'movie', { tmdbId: 11 }, { played: true });
    jelly.play('ghost', 'movie', { tmdbId: 11 }, { played: false });
    const svc = service();
    svc.createRule(watchedRule());
    expect((await svc.sweep()).staged).toBe(1);
  });

  it('keeps items requested recently', async () => {
    await addMovie(fx, { tmdbId: 11, title: 'A' });
    fx.db
      .insert(mediaRequests)
      .values({ type: 'movie', status: 'approved' as never, tmdbId: 11, title: 'A', requestedById: 1, tags: [], createdAt: daysAgo(5), updatedAt: daysAgo(5) })
      .run();
    const svc = service();
    svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'unmonitor', keepIfRequestedWithinDays: 14 });
    expect((await svc.sweep()).staged).toBe(0);
    advanceDays(10);
    expect((await svc.sweep()).staged).toBe(1);
  });
});

describe('apply paths', () => {
  it('deleteFiles recycles the files, removes the file rows and unmonitors', async () => {
    setSection(fx.db, 'mediaManagement', { ...getSection(fx.db, 'mediaManagement'), recycleBinPath: fx.binPath });
    const id = await addMovie(fx, { tmdbId: 11, title: 'Harbour', sizeBytes: 4_000 });
    const movie = libraryService.getMovie(fx.db, id);
    const svc = service();
    svc.createRule({ name: 'Big', mediaType: 'movie', conditions: [{ type: 'sizeAbove', bytes: 10 }], action: 'deleteFiles', graceDays: 0, dryRun: false });
    const r = await svc.sweep();
    expect(r.applied).toBe(1);
    expect(await exists(join(movie.path, 'Harbour.mkv'))).toBe(false);
    expect(await exists(join(fx.binPath, 'Harbour (2020)', 'Harbour.mkv'))).toBe(true);
    // The subtitle is not a media file: deleteFiles leaves it in place.
    expect(await exists(join(movie.path, 'Harbour.en.srt'))).toBe(true);
    const after = libraryService.getMovie(fx.db, id);
    expect(after).toMatchObject({ monitored: false, hasFile: false });
    expect(libraryService.listMediaFiles(fx.db, { movieId: id })).toEqual([]);
    expect(events.at(-1)).toMatchObject({ freedBytes: 4_000, totalApplied: 1 });
  });

  it('deleteItem recycles the whole folder, deletes the movie and adds an exclusion', async () => {
    setSection(fx.db, 'mediaManagement', { ...getSection(fx.db, 'mediaManagement'), recycleBinPath: fx.binPath });
    const id = await addMovie(fx, { tmdbId: 11, title: 'Harbour' });
    const movie = libraryService.getMovie(fx.db, id);
    const svc = service();
    svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'deleteItem', addExclusion: true, graceDays: 0, dryRun: false });
    await svc.sweep();
    expect(await exists(movie.path)).toBe(false);
    expect((await readdir(join(fx.binPath, 'Harbour (2020)'))).sort()).toEqual(['Harbour.en.srt', 'Harbour.mkv']);
    expect(libraryService.findMovieByTmdbId(fx.db, 11)).toBeNull();
    expect(libraryService.isExcluded(fx.db, 'movie', 11)).toBe(true);
    expect(svc.listCandidates()[0]!.status).toBe('applied');
  });

  it('deleteItem without a recycle bin deletes permanently and skips the exclusion when not asked', async () => {
    const id = await addMovie(fx, { tmdbId: 11, title: 'Harbour' });
    const movie = libraryService.getMovie(fx.db, id);
    const svc = service();
    svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'deleteItem', graceDays: 0, dryRun: false });
    await svc.sweep();
    expect(await exists(movie.path)).toBe(false);
    expect(libraryService.isExcluded(fx.db, 'movie', 11)).toBe(false);
  });

  it('manual apply ignores the grace period and dry-run flag', async () => {
    const id = await addMovie(fx, { tmdbId: 11, title: 'A' });
    const svc = service();
    svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'unmonitor', graceDays: 30 });
    await svc.sweep();
    const [c] = svc.listCandidates();
    expect(await svc.applyCandidate(c!.id)).toMatchObject({ status: 'applied' });
    expect(libraryService.getMovie(fx.db, id).monitored).toBe(false);
  });

  it('records failures and retries them on the next sweep', async () => {
    await addMovie(fx, { tmdbId: 11, title: 'A' });
    let calls = 0;
    const svc = service({
      apply: async () => {
        calls++;
        if (calls === 1) throw new Error('disk on fire');
        return { freedBytes: 0, recycled: [] };
      },
    });
    svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'unmonitor', graceDays: 0, dryRun: false });
    const first = await svc.sweep();
    expect(first).toMatchObject({ applied: 0, failed: 1 });
    expect(svc.listCandidates()[0]).toMatchObject({ status: 'failed', error: 'disk on fire' });
    expect(events[0]).toMatchObject({ totalFailed: 1, failed: [expect.objectContaining({ error: 'disk on fire' })] });
    expect(await svc.sweep()).toMatchObject({ applied: 1, failed: 0 });
  });

  it('marks a candidate whose item vanished as failed', async () => {
    const id = await addMovie(fx, { tmdbId: 11, title: 'A', withFile: false });
    const svc = service();
    svc.createRule({ name: 'Old', mediaType: 'movie', conditions: [{ type: 'addedOlderThanDays', days: 30 }], action: 'deleteItem', graceDays: 30 });
    await svc.sweep();
    await libraryService.deleteMovie(fx.db, id);
    const [c] = svc.listCandidates();
    expect(await svc.applyCandidate(c!.id)).toMatchObject({ status: 'failed', error: 'no longer in the library' });
  });
});
