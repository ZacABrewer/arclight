import { describe, expect, it } from 'vitest';
import type { DelayProfile, ReleaseProfile } from '@arclight/shared';
import {
  KEPT_BY_CHOICE_MESSAGE,
  buildDecision,
  evaluate,
  isUpgradable,
  prioritize,
  type Candidate,
  type DecisionContext,
  type ExistingFile,
  type Ranked,
} from './engine.js';
import {
  GB,
  HD_ALLOWED,
  NOW,
  makeCandidate,
  makeContext,
  makeEpisode,
  makeIndexer,
  makeMovie,
  makeProfile,
  makeRelease,
  makeSeries,
  quality,
  snapshot,
} from './test-support.js';

const show = makeSeries({ title: 'Show Name', runtimeMinutes: 45 });
const s1 = [1, 2, 3].map((n) => makeEpisode(show.id, 1, n));
const lib = snapshot([show], s1);
const movie = makeMovie({ title: 'Some Movie', year: 2020, runtimeMinutes: 120 });
const movieLib = snapshot([], [], [movie]);

function reasons(ctx: DecisionContext, c: Candidate): string[] {
  return evaluate(ctx, c).rejections.map((r) => r.reason);
}

function tv(title: string, overrides: Parameters<typeof makeRelease>[1] = {}, l = lib) {
  return makeCandidate(makeRelease(title, overrides), l);
}

function file(q: ReturnType<typeof quality>, episodeIds: number[], overrides: Partial<ExistingFile> = {}): ExistingFile {
  return { id: 900 + episodeIds[0]!, quality: q, formatScore: 0, releaseGroup: 'GRP', dateAdded: '2026-02-28T00:00:00.000Z', episodeIds, sizeBytes: GB, ...overrides };
}

const delayProfile = (overrides: Partial<DelayProfile> = {}): DelayProfile => ({
  id: 1,
  order: 1,
  tags: [],
  preferredProtocol: 'usenet',
  usenetDelayMinutes: 0,
  torrentDelayMinutes: 120,
  bypassIfHighestQuality: false,
  bypassIfAboveCustomFormatScore: false,
  minimumCustomFormatScore: 0,
  ...overrides,
});

describe('release-intrinsic specs', () => {
  it('accepts a clean release', () => {
    expect(reasons(makeContext(), tv('Show.Name.S01E01.1080p.WEB-DL-GRP'))).toEqual([]);
  });

  it('rejects qualities the profile does not allow', () => {
    const ctx = makeContext({ profile: makeProfile(['WEBDL-1080p', 'Bluray-1080p']) });
    expect(reasons(ctx, tv('Show.Name.S01E01.720p.HDTV-GRP'))).toContain('qualityNotWanted');
  });

  it('enforces the custom format minimum score (equal passes)', () => {
    expect(reasons(makeContext({ profile: makeProfile(HD_ALLOWED, { minFormatScore: 1 }) }), tv('Show.Name.S01E01.1080p.WEB-DL-GRP'))).toContain(
      'customFormatMinimumScore',
    );
    expect(reasons(makeContext({ profile: makeProfile(HD_ALLOWED, { minFormatScore: 0 }) }), tv('Show.Name.S01E01.1080p.WEB-DL-GRP'))).toEqual([]);
  });

  it('enforces profile languages but accepts untagged releases', () => {
    const ctx = makeContext({ profile: makeProfile(HD_ALLOWED, { languages: ['de'] }) });
    expect(reasons(ctx, tv('Show.Name.S01E01.FRENCH.1080p.WEB-DL-GRP'))).toContain('wantedLanguage');
    expect(reasons(ctx, tv('Show.Name.S01E01.GERMAN.1080p.WEB-DL-GRP'))).toEqual([]);
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP'))).toEqual([]);
  });

  it('enforces the global maximum size', () => {
    const ctx = makeContext({ settings: { ...makeContext().settings, maximumSizeMb: 1000 } });
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { size: 2 * GB }))).toContain('maximumSizeExceeded');
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { size: 0 }))).toEqual([]);
  });

  it('checks per-quality size limits against runtime', () => {
    // 45-minute episode, WEBDL-1080p 10..40 MB/min → 450 MB .. 1800 MB
    const ctx = makeContext({ qualityLimits: () => ({ minSize: 10, maxSize: 40, preferredSize: null }) });
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { size: 300 * 1024 * 1024 }))).toContain('belowMinimumSize');
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { size: 2 * GB }))).toContain('aboveMaximumSize');
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { size: GB }))).toEqual([]);
    // Double episode doubles the window.
    expect(reasons(ctx, tv('Show.Name.S01E01E02.1080p.WEB-DL-GRP', { size: 3 * GB }))).toEqual([]);
  });

  it('rejects unknown runtime for a later season of a series without runtime', () => {
    const noRuntime = makeSeries({ title: 'New Show', runtimeMinutes: null });
    const ep = makeEpisode(noRuntime.id, 3, 1);
    const c = tv('New.Show.S03E01.1080p.WEB-DL-GRP', {}, snapshot([noRuntime], [ep]));
    expect(reasons(makeContext(), c)).toContain('unknownRuntime');
  });

  it('rejects small samples', () => {
    expect(reasons(makeContext(), tv('Show.Name.S01E01.1080p.WEB-DL.SAMPLE-GRP', { size: 30 * 1024 * 1024 }))).toContain('sample');
  });

  it('rejects raw discs unless the profile allows BR-DISK', () => {
    const m = makeCandidate(makeRelease('Some.Movie.2020.1080p.Full.Blu-ray.AVC-GRP', { size: 40 * GB }), movieLib);
    expect(reasons(makeContext(), m)).toContain('raw');
    const permissive = makeContext({ profile: makeProfile([...HD_ALLOWED, 'BR-DISK']) });
    const m2 = makeCandidate(makeRelease('Some.Movie.2020.1080p.Full.Blu-ray.AVC-GRP', { size: 40 * GB }), movieLib, permissive.profile);
    expect(reasons(permissive, m2)).not.toContain('raw');
  });

  it('holds usenet releases younger than the minimum age (temporary)', () => {
    const ctx = makeContext({ settings: { ...makeContext().settings, minimumAgeMinutes: 120 } });
    const ev = evaluate(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { protocol: 'usenet', ageMinutes: 30 }));
    expect(ev.rejections).toEqual([expect.objectContaining({ reason: 'minimumAge', type: 'temporary' })]);
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { protocol: 'torrent', ageMinutes: 30 }))).toEqual([]);
  });

  it('rejects usenet releases beyond retention', () => {
    const ctx = makeContext({ settings: { ...makeContext().settings, retentionDays: 1500 } });
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { protocol: 'usenet', ageMinutes: 1600 * 1440 }))).toContain('maximumAge');
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { protocol: 'usenet', ageMinutes: 1500 * 1440 }))).toEqual([]);
  });

  it('enforces the indexer minimum seeders; unknown seeders pass', () => {
    const ctx = makeContext({ indexer: makeIndexer({ settings: { ...makeIndexer().settings, minimumSeeders: 5 } }) });
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { seeders: 2 }))).toContain('minimumSeeders');
    const { seeders: _s, ...noSeeders } = makeRelease('Show.Name.S01E01.1080p.WEB-DL-GRP');
    expect(reasons(ctx, makeCandidate(noSeeders, lib))).toEqual([]);
  });

  it('requires a shared tag when the indexer is tagged', () => {
    expect(reasons(makeContext({ indexer: makeIndexer({ tags: [7] }) }), tv('Show.Name.S01E01.1080p.WEB-DL-GRP'))).toContain('noMatchingTag');
  });

  it('temporarily rejects releases from an indexer in failure backoff', () => {
    const ev = evaluate(makeContext({ indexerDisabledTill: '2026-03-01T13:00:00.000Z' }), tv('Show.Name.S01E01.1080p.WEB-DL-GRP'));
    expect(ev.rejections).toEqual([expect.objectContaining({ reason: 'indexerDisabled', type: 'temporary' })]);
  });

  it('applies release profile required and ignored terms', () => {
    const rp: ReleaseProfile = { id: 1, name: 'x265 only', enabled: true, required: ['x265', 'HEVC'], ignored: ['/\\bCAM\\b/'], tags: [] };
    const ctx = makeContext({ releaseProfiles: [rp] });
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL.x264-GRP'))).toContain('mustContainMissing');
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL.HEVC-GRP'))).toEqual([]);
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL.HEVC.CAM-GRP'))).toContain('mustNotContainPresent');
  });
});

describe('series-specific specs', () => {
  const future = makeEpisode(show.id, 2, 1, { airDateUtc: '2026-03-01T14:00:00.000Z' });
  const soon = makeEpisode(show.id, 2, 2, { airDateUtc: '2026-03-01T12:30:00.000Z' });
  const s2lib = snapshot([show], [future, soon]);

  it('rejects single episodes that have not aired, with a tolerance', () => {
    expect(reasons(makeContext(), tv('Show.Name.S02E01.1080p.WEB-DL-GRP', {}, s2lib))).toContain('beforeAirDate');
    expect(reasons(makeContext(), tv('Show.Name.S02E02.1080p.WEB-DL-GRP', {}, s2lib))).not.toContain('beforeAirDate');
    const lax = makeContext({ settings: { ...makeContext().settings, allowUnairedEpisodes: true } });
    expect(reasons(lax, tv('Show.Name.S02E01.1080p.WEB-DL-GRP', {}, s2lib))).not.toContain('beforeAirDate');
  });

  it('rejects season packs with episodes airing more than 24h out', () => {
    const later = makeEpisode(show.id, 3, 1, { airDateUtc: '2026-03-04T12:00:00.000Z' });
    const l = snapshot([show], [makeEpisode(show.id, 3, 2), later]);
    expect(reasons(makeContext(), tv('Show.Name.S03.1080p.WEB-DL-GRP', { size: 10 * GB }, l))).toContain('fullSeasonNotAired');
    expect(reasons(makeContext(), tv('Show.Name.S01.1080p.WEB-DL-GRP', { size: 4 * GB }))).not.toContain('fullSeasonNotAired');
  });

  it('rejects multi-season packs unless allowed', () => {
    const l = snapshot([show], [...s1, makeEpisode(show.id, 2, 1)]);
    const c = tv('Show.Name.S01-S02.1080p.BluRay-GRP', { size: 0 }, l);
    expect(reasons(makeContext(), c)).toContain('multiSeason');
    expect(reasons(makeContext({ settings: { ...makeContext().settings, allowMultiSeason: true } }), c)).not.toContain('multiSeason');
  });

  it('rejects split episodes', () => {
    const c = tv('Show.Name.S01E01.1080p.WEB-DL-GRP');
    const split = { ...c, parsed: { ...c.parsed, series: { ...c.parsed.series!, isSplitEpisode: true } } };
    expect(reasons(makeContext(), split)).toContain('splitEpisode');
  });

  it('rejects unmonitored series/episodes unless the search is user invoked', () => {
    const unmonitored = makeSeries({ title: 'Quiet Show', monitored: false });
    const ep = makeEpisode(unmonitored.id, 1, 1);
    const c = tv('Quiet.Show.S01E01.1080p.WEB-DL-GRP', {}, snapshot([unmonitored], [ep]));
    expect(reasons(makeContext(), c)).toContain('seriesNotMonitored');
    const epOff = makeEpisode(show.id, 4, 1, { monitored: false });
    expect(reasons(makeContext(), tv('Show.Name.S04E01.1080p.WEB-DL-GRP', {}, snapshot([show], [epOff])))).toContain('episodeNotMonitored');
    const manual = makeContext({ source: 'interactiveSearch', criteria: { mediaType: 'series', seriesId: unmonitored.id, userInvoked: true } });
    expect(reasons(manual, c)).not.toContain('seriesNotMonitored');
  });

  it('rejects replacing a multi-episode file with a release covering fewer episodes', () => {
    const ctx = makeContext({ existingFiles: [file(quality('HDTV-720p'), [s1[0]!.id, s1[1]!.id])] });
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP'))).toContain('existingFileHasMoreEpisodes');
  });

  it('applies search criteria: wrong episode and full season for single-episode searches', () => {
    const ctx = makeContext({ source: 'search', criteria: { mediaType: 'series', seriesId: show.id, episodeIds: [s1[1]!.id], seasonNumber: 1, userInvoked: false } });
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP'))).toContain('wrongEpisode');
    expect(reasons(ctx, tv('Show.Name.S01.1080p.WEB-DL-GRP', { size: 4 * GB }))).toContain('fullSeason');
    expect(reasons(ctx, tv('Show.Name.S01E02.1080p.WEB-DL-GRP'))).toEqual([]);
  });
});

describe('movie specs', () => {
  it('rejects movies not yet available unless the search is user invoked', () => {
    const upcoming = makeMovie({ title: 'Upcoming Film', year: 2026, inCinemas: '2026-02-20', digitalRelease: null, physicalRelease: null });
    const c = makeCandidate(makeRelease('Upcoming.Film.2026.1080p.WEB-DL-GRP'), snapshot([], [], [upcoming]));
    expect(reasons(makeContext(), c)).toContain('availability');
    expect(reasons(makeContext({ source: 'userInvokedSearch', criteria: { mediaType: 'movie', movieId: upcoming.id, userInvoked: true } }), c)).not.toContain(
      'availability',
    );
  });

  it('rejects unmonitored movies', () => {
    const off = makeMovie({ title: 'Off Film', monitored: false });
    const c = makeCandidate(makeRelease('Off.Film.2020.1080p.WEB-DL-GRP'), snapshot([], [], [off]));
    expect(reasons(makeContext(), c)).toContain('movieNotMonitored');
  });
});

describe('upgrades, queue, history, propers', () => {
  it('rejects when the file on disk already meets cutoff; accepts real upgrades', () => {
    const atCutoff = makeContext({ existingFiles: [file(quality('WEBDL-1080p'), [s1[0]!.id])] });
    expect(reasons(atCutoff, tv('Show.Name.S01E01.1080p.BluRay.x264-GRP'))).toContain('diskCutoffMet');
    const below = makeContext({ existingFiles: [file(quality('HDTV-720p'), [s1[0]!.id])] });
    expect(reasons(below, tv('Show.Name.S01E01.1080p.WEB-DL-GRP'))).toEqual([]);
    expect(reasons(makeContext({ existingFiles: [file(quality('WEBDL-720p'), [s1[0]!.id])] }), tv('Show.Name.S01E01.720p.HDTV-GRP'))).toContain(
      'diskHigherPreference',
    );
  });

  it('applies the season pack upgrade mode', () => {
    const files = [file(quality('WEBDL-1080p'), [s1[0]!.id])]; // one at cutoff, two missing
    const pack = tv('Show.Name.S01.1080p.BluRay.x264-GRP', { size: 6 * GB });
    expect(reasons(makeContext({ existingFiles: files }), pack)).toContain('diskNotUpgrade');
    expect(reasons(makeContext({ existingFiles: files, settings: { ...makeContext().settings, seasonPackUpgrade: 'any' } }), pack)).toEqual([]);
    expect(
      reasons(makeContext({ existingFiles: files, settings: { ...makeContext().settings, seasonPackUpgrade: 'percent', seasonPackUpgradeThreshold: 60 } }), pack),
    ).toEqual([]);
  });

  it('blocks a candidate no better than a queued item, but not a better one', () => {
    const queued = { title: 'Show.Name.S01E01.1080p.WEB-DL-OTHER', quality: quality('WEBDL-1080p'), formatScore: 0, state: 'downloading' as const, downloadId: 'x', episodeIds: [s1[0]!.id] };
    expect(reasons(makeContext({ queue: [queued] }), tv('Show.Name.S01E01.1080p.WEB-DL-GRP'))).toContain('queueCutoffMet');
    const low = { ...queued, quality: quality('HDTV-720p') };
    expect(reasons(makeContext({ queue: [low] }), tv('Show.Name.S01E01.1080p.WEB-DL-GRP'))).toEqual([]);
    const same = { ...low, title: 'Show.Name.S01E01.720p.HDTV-GRP' };
    expect(reasons(makeContext({ queue: [same] }), tv('Show.Name.S01E01.720p.HDTV-GRP'))).toContain('alreadyInQueue');
  });

  it('rejects in RSS when a recent grab already meets cutoff', () => {
    const ctx = makeContext({
      latestHistory: [
        { event: { eventType: 'grabbed', date: '2026-03-01T11:50:00.000Z', sourceTitle: 'Show.Name.S01E01.1080p.WEB-DL-X', quality: quality('WEBDL-1080p') }, formatScore: 0 },
      ],
    });
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.BluRay.x264-GRP'))).toContain('historyRecentCutoffMet');
    expect(reasons({ ...ctx, source: 'search', criteria: { mediaType: 'series', seriesId: show.id, userInvoked: false } }, tv('Show.Name.S01E01.1080p.BluRay.x264-GRP'))).not.toContain(
      'historyRecentCutoffMet',
    );
  });

  it('honours the propers setting and requires repacks from the same group', () => {
    const files = [file(quality('WEBDL-1080p'), [s1[0]!.id], { releaseGroup: 'GRP' })];
    expect(reasons(makeContext({ existingFiles: files, propers: 'doNotUpgrade' }), tv('Show.Name.S01E01.PROPER.1080p.WEB-DL-GRP'))).toContain('propersDisabled');
    expect(reasons(makeContext({ existingFiles: files }), tv('Show.Name.S01E01.PROPER.1080p.WEB-DL-GRP'))).toEqual([]);
    expect(reasons(makeContext({ existingFiles: files }), tv('Show.Name.S01E01.REPACK.1080p.WEB-DL-OTHER'))).toContain('repackReleaseGroupDoesNotMatch');
  });

  it('never lets an automatic decision replace a file kept by choice ("Grab anyway")', () => {
    const kept = [file(quality('HDTV-720p'), [s1[0]!.id], { keptByChoice: true })];
    const upgrade = tv('Show.Name.S01E01.1080p.WEB-DL-GRP');
    const rss = evaluate(makeContext({ existingFiles: kept }), upgrade);
    expect(rss.rejections).toEqual([{ reason: 'keptByChoice', message: KEPT_BY_CHOICE_MESSAGE, type: 'permanent' }]);
    const search = makeContext({ existingFiles: kept, source: 'search', criteria: { mediaType: 'series', seriesId: show.id, userInvoked: false } });
    expect(reasons(search, upgrade)).toContain('keptByChoice');
    expect(reasons({ ...search, source: 'userInvokedSearch' }, upgrade)).toContain('keptByChoice');
    // A season pack covering the kept episode would replace it too.
    expect(reasons(makeContext({ existingFiles: kept }), tv('Show.Name.S01.1080p.WEB-DL-GRP', { size: 6 * GB }))).toContain('keptByChoice');
    // Interactive search: the user may still replace it by hand; the normal upgrade rules apply.
    expect(reasons({ ...search, source: 'interactiveSearch' }, upgrade)).toEqual([]);
    // Other episodes, and the same file once upgrades are allowed again, upgrade as usual.
    expect(reasons(makeContext({ existingFiles: kept }), tv('Show.Name.S01E02.1080p.WEB-DL-GRP'))).toEqual([]);
    expect(reasons(makeContext({ existingFiles: [{ ...kept[0]!, keptByChoice: false }] }), upgrade)).toEqual([]);
  });

  it('rejects blocklisted releases', () => {
    expect(reasons(makeContext({ blocklisted: true }), tv('Show.Name.S01E01.1080p.WEB-DL-GRP'))).toEqual(['blocklisted']);
  });

  it('implements isUpgradable per the spec examples', () => {
    const p = makeProfile(['HDTV-720p', 'WEBDL-720p', 'WEBDL-1080p', 'Bluray-1080p'], { cutoffFormatScore: 100, minUpgradeFormatScore: 1 });
    const q = (name: Parameters<typeof quality>[0], score = 0, v = 1) => ({ quality: quality(name, v), formatScore: score });
    expect(isUpgradable(p, q('HDTV-720p'), q('WEBDL-1080p'), 'preferAndUpgrade')).toBe('none');
    expect(isUpgradable(p, q('WEBDL-1080p'), q('Bluray-1080p'), 'preferAndUpgrade')).toBe('qualityCutoff');
    expect(isUpgradable(p, q('WEBDL-1080p'), q('WEBDL-720p'), 'preferAndUpgrade')).toBe('betterQuality');
    expect(isUpgradable(p, q('WEBDL-1080p'), q('WEBDL-1080p', 0, 2), 'preferAndUpgrade')).toBe('none');
    expect(isUpgradable(p, q('WEBDL-1080p'), q('WEBDL-1080p', 0, 2), 'doNotPrefer')).toBe('customFormatScore');
    expect(isUpgradable(p, q('WEBDL-1080p', 50), q('WEBDL-1080p', 120), 'preferAndUpgrade')).toBe('none');
    expect(isUpgradable(p, q('WEBDL-1080p', 150), q('WEBDL-1080p', 200), 'preferAndUpgrade')).toBe('customFormatCutoff');
    const off = { ...p, upgradeAllowed: false };
    expect(isUpgradable(off, q('HDTV-720p'), q('WEBDL-1080p'), 'preferAndUpgrade')).toBe('upgradesNotAllowed');
  });
});

describe('delay and classification', () => {
  it('parks a young torrent under a torrent delay with remaining minutes', () => {
    const ctx = makeContext({ delayProfile: delayProfile() });
    const ev = evaluate(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { ageMinutes: 20 }));
    expect(ev.rejections).toEqual([expect.objectContaining({ reason: 'minimumAgeDelay', type: 'temporary' })]);
    expect(ev.remainingMinutes).toBe(100);
    expect(reasons(ctx, tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { ageMinutes: 130 }))).toEqual([]);
  });

  it('bypasses the delay for top quality only on the preferred protocol, and for user searches', () => {
    const p = makeProfile(['WEBDL-1080p', 'Bluray-1080p'], {}, 'Bluray-1080p');
    const ctx = makeContext({ profile: p, delayProfile: delayProfile({ usenetDelayMinutes: 60, bypassIfHighestQuality: true }) });
    const lp = snapshot([show], s1);
    expect(reasons(ctx, makeCandidate(makeRelease('Show.Name.S01E01.1080p.BluRay.x264-GRP', { protocol: 'usenet', ageMinutes: 5 }), lp, p))).toEqual([]);
    expect(reasons(ctx, makeCandidate(makeRelease('Show.Name.S01E01.1080p.BluRay.x264-GRP', { protocol: 'torrent', ageMinutes: 5 }), lp, p))).toContain(
      'minimumAgeDelay',
    );
    const user = { ...ctx, source: 'userInvokedSearch' as const, criteria: { mediaType: 'series' as const, seriesId: show.id, userInvoked: true } };
    expect(reasons(user, makeCandidate(makeRelease('Show.Name.S01E01.1080p.BluRay.x264-GRP', { protocol: 'torrent', ageMinutes: 5 }), lp, p))).toEqual([]);
  });

  it('classifies mixed temporary + permanent rejections as rejected (not parked)', () => {
    const ctx = makeContext({ delayProfile: delayProfile(), blocklisted: true });
    const c = tv('Show.Name.S01E01.1080p.WEB-DL-GRP', { ageMinutes: 5 });
    const d = buildDecision('rss', c, evaluate(ctx, c));
    expect(d.approved).toBe(false);
    expect(d.temporarilyRejected).toBe(false);
    expect(d.rejections.map((r) => r.type).sort()).toEqual(['permanent', 'temporary']);
  });
});

describe('prioritize', () => {
  const profile = makeProfile(HD_ALLOWED);
  function ranked(title: string, overrides: Parameters<typeof makeRelease>[1] = {}, rank: Partial<NonNullable<Ranked['rank']>> = {}): Ranked {
    const c = tv(title, overrides);
    return {
      decision: buildDecision('rss', c, { rejections: [], remainingMinutes: undefined }),
      rank: { profile, preferredProtocol: 'usenet', runtimeMinutes: 45, preferredSizeMbPerMinute: null, isAnime: false, firstEpisodeNumber: 1, ...rank },
    };
  }

  it('orders by quality first, then seeders, then indexer priority', () => {
    const out = prioritize(
      [
        ranked('Show.Name.S01E01.720p.HDTV-A', { guid: 'a' }),
        ranked('Show.Name.S01E01.1080p.WEB-DL-B', { guid: 'b', seeders: 3 }),
        ranked('Show.Name.S01E01.1080p.WEB-DL-C', { guid: 'c', seeders: 400 }),
        ranked('Show.Name.S01E01.1080p.WEB-DL-D', { guid: 'd', seeders: 400, indexerPriority: 1 }),
      ],
      'preferAndUpgrade',
    );
    expect(out.map((r) => r.decision.guid)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('prefers the delay profile protocol at equal quality and score', () => {
    const out = prioritize(
      [ranked('Show.Name.S01E01.1080p.WEB-DL-T', { guid: 't' }), ranked('Show.Name.S01E01.1080p.WEB-DL-U', { guid: 'u', protocol: 'usenet' })],
      'preferAndUpgrade',
    );
    expect(out[0]!.decision.guid).toBe('u');
  });

  it('puts a season pack before singles and prefers the size closest to preferred', () => {
    const pack = ranked('Show.Name.S01.1080p.WEB-DL-P', { guid: 'pack', size: 4 * GB });
    const single = ranked('Show.Name.S01E01.1080p.WEB-DL-S', { guid: 'single' });
    expect(prioritize([single, pack], 'preferAndUpgrade')[0]!.decision.guid).toBe('pack');

    const near = ranked('Show.Name.S01E01.1080p.WEB-DL-N', { guid: 'near', size: Math.round(4.6 * GB) }, { runtimeMinutes: 120, preferredSizeMbPerMinute: 40 });
    const far = ranked('Show.Name.S01E01.1080p.WEB-DL-F', { guid: 'far', size: Math.round(6.5 * GB) }, { runtimeMinutes: 120, preferredSizeMbPerMinute: 40 });
    expect(prioritize([far, near], 'preferAndUpgrade')[0]!.decision.guid).toBe('near');
  });

  it('prefers a proper at equal quality unless doNotPrefer', () => {
    const v1 = ranked('Show.Name.S01E01.1080p.WEB-DL-A', { guid: 'v1' });
    const v2 = ranked('Show.Name.S01E01.PROPER.1080p.WEB-DL-B', { guid: 'v2' });
    expect(prioritize([v1, v2], 'preferAndUpgrade')[0]!.decision.guid).toBe('v2');
    expect(prioritize([v1, v2], 'doNotPrefer')[0]!.decision.guid).toBe('v1');
  });
});

void NOW;
