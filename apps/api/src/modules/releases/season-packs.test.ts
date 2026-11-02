import { describe, expect, it } from 'vitest';
import { buildDecision, compareDecisions, evaluate, packPreferred, seriesPackCoverage, type Candidate, type DecisionContext, type ExistingFile, type Ranked } from './engine.js';
import { matchRelease } from './matcher.js';
import { absoluteRange, animeSeasonQueries, wantsSeasonSearch } from './season-search.js';
import { GB, HD_ALLOWED, makeCandidate, makeContext, makeEpisode, makeProfile, makeRelease, makeSeries, quality, snapshot } from './test-support.js';
import type { SceneRule } from '../scene-mapping/mapping.js';

// Season packs end to end through the matcher and the decision engine: multi-season and
// complete-series packs, episode ranges, anime batches, "only wanted" and per-episode sizes.

const show = makeSeries({ title: 'Show Name', runtimeMinutes: 45 });
const seasons = [1, 2, 3].flatMap((s) => Array.from({ length: 12 }, (_, i) => makeEpisode(show.id, s, i + 1)));
const special = makeEpisode(show.id, 0, 1);
const lib = snapshot([show], [...seasons, special]);
const s1 = seasons.filter((e) => e.seasonNumber === 1);

const anime = makeSeries({ title: 'Anime Title', seriesType: 'anime', runtimeMinutes: 24 });
const animeEps = [1, 2, 3].flatMap((s) => Array.from({ length: 12 }, (_, i) => makeEpisode(anime.id, s, i + 1)));
const animeLib = snapshot([anime], animeEps);

function tv(title: string, size = 30 * GB, l = lib): Candidate {
  return makeCandidate(makeRelease(title, { size }), l);
}

function reasons(ctx: DecisionContext, c: Candidate): string[] {
  return evaluate(ctx, c).rejections.map((r) => r.reason);
}

function file(q: ReturnType<typeof quality>, episodeIds: number[], id = 5000 + episodeIds[0]!): ExistingFile {
  return { id, quality: q, formatScore: 0, releaseGroup: 'GRP', dateAdded: '2026-02-01T00:00:00.000Z', episodeIds, sizeBytes: GB };
}

function mapped(title: string, l = lib) {
  const { match } = matchRelease(title, {}, l, { hint: 'series' });
  if (match.status !== 'mapped' || match.mediaType !== 'series') throw new Error(`${title}: ${match.status}`);
  return match;
}

describe('pack mapping', () => {
  it('maps a multi-season pack to every episode of its seasons', () => {
    const m = mapped('Show.Name.S01-S03.1080p.BluRay.x264-GRP');
    expect(m.episodes).toHaveLength(36);
    expect(m.fullSeason).toBe(true);
  });

  it('maps "Complete Series" to every regular season, not specials', () => {
    const m = mapped('Show.Name.Complete.Series.1080p.BluRay.x264-GRP');
    expect(m.episodes).toHaveLength(36);
    expect(m.episodes.some((e) => e.seasonNumber === 0)).toBe(false);
  });

  it('maps an episode range to just those episodes', () => {
    const m = mapped('Show.Name.S02E05-E10.1080p.WEB-DL-GRP');
    expect(m.episodes.map((e) => `${e.seasonNumber}x${e.episodeNumber}`)).toEqual(['2x5', '2x6', '2x7', '2x8', '2x9', '2x10']);
  });

  it('maps a Part/Vol pack to its season (files decide on import)', () => {
    const m = mapped('Show.Name.S03.Part.1.1080p.NF.WEB-DL-GRP');
    expect(m.episodes.every((e) => e.seasonNumber === 3)).toBe(true);
    expect(m.fullSeason).toBe(true);
  });

  it('maps anime absolute batches across seasons', () => {
    const m = mapped('[SubGroup] Anime Title (001-024) [Batch] [1080p]', animeLib);
    expect(m.episodes).toHaveLength(24);
    expect(new Set(m.episodes.map((e) => e.seasonNumber))).toEqual(new Set([1, 2]));
  });

  it('maps anime batches named by season words through the base title', () => {
    const second = mapped('[SubGroup] Anime Title 2nd Season [1080p] [Batch]', animeLib);
    expect(second.episodes).toHaveLength(12);
    expect(second.episodes.every((e) => e.seasonNumber === 2)).toBe(true);

    const range = mapped('[SubGroup] Anime Title S3 - 01-12 [1080p] [Batch]', animeLib);
    expect(range.episodes.every((e) => e.seasonNumber === 3)).toBe(true);
    expect(range.episodes).toHaveLength(12);

    const final = mapped('[SubGroup] Anime Title Final Season Part 2 [1080p][Batch]', animeLib);
    expect(final.episodes.every((e) => e.seasonNumber === 3)).toBe(true);
  });

  it('reads "Title 3rd Season - 25" past the season end as absolute', () => {
    const m = mapped('[SubGroup] Anime Title 3rd Season - 25 [1080p]', animeLib);
    expect(m.episodes.map((e) => `${e.seasonNumber}x${e.episodeNumber}`)).toEqual(['3x1']);
  });
});

describe('pack decisions', () => {
  it('accepts multi-season and complete series packs by default', () => {
    expect(reasons(makeContext(), tv('Show.Name.S01-S03.1080p.BluRay.x264-GRP'))).toEqual([]);
    expect(reasons(makeContext(), tv('Show.Name.Complete.Series.1080p.BluRay.x264-GRP'))).toEqual([]);
  });

  it('wants a pack when some of its episodes are monitored, not when none are', () => {
    const off = s1.map((e, i) => (i < 6 ? { ...e, monitored: false } : e));
    const half = snapshot([show], off);
    expect(reasons(makeContext(), tv('Show.Name.S01.1080p.BluRay.x264-GRP', 10 * GB, half))).not.toContain('episodeNotMonitored');
    const none = snapshot([show], s1.map((e) => ({ ...e, monitored: false })));
    expect(reasons(makeContext(), tv('Show.Name.S01.1080p.BluRay.x264-GRP', 10 * GB, none))).toContain('episodeNotMonitored');
  });

  it('counts only wanted episodes towards the upgrade mode (never downgrades good ones)', () => {
    // 11 of 12 episodes are at cutoff (WEBDL-1080p); one is missing.
    const files = s1.slice(1).map((e) => file(quality('WEBDL-1080p'), [e.id]));
    const pack = tv('Show.Name.S01.1080p.BluRay.x264-GRP', 10 * GB);
    const all = makeContext({ existingFiles: files });
    expect(reasons(all, pack)).toContain('diskNotUpgrade');
    const any = makeContext({ existingFiles: files, settings: { ...makeContext().settings, seasonPackUpgrade: 'any' } });
    expect(reasons(any, pack)).toEqual([]);
    expect(seriesPackCoverage(any, pack)).toEqual({ kind: 'season', seasons: [1], episodeCount: 12, wantedCount: 1 });
  });

  it('ignores unmonitored episodes when counting a pack in "all" mode', () => {
    // The only file at cutoff belongs to an unmonitored episode: every wanted episode gains.
    const eps = s1.map((e, i) => (i === 0 ? { ...e, monitored: false } : e));
    const l = snapshot([show], eps);
    const ctx = makeContext({ existingFiles: [file(quality('WEBDL-1080p'), [eps[0]!.id])] });
    expect(reasons(ctx, tv('Show.Name.S01.1080p.BluRay.x264-GRP', 10 * GB, l))).toEqual([]);
  });

  it('rejects a pack that upgrades nothing', () => {
    const files = s1.map((e) => file(quality('Bluray-1080p'), [e.id]));
    const ctx = makeContext({ existingFiles: files, settings: { ...makeContext().settings, seasonPackUpgrade: 'any' } });
    expect(reasons(ctx, tv('Show.Name.S01.720p.HDTV.x264-GRP', 6 * GB))).toContain('diskNotUpgrade');
  });

  it('treats an episode range like a pack: wanted episodes only', () => {
    const files = [file(quality('Bluray-1080p'), [s1[0]!.id])];
    const ctx = makeContext({ existingFiles: files, settings: { ...makeContext().settings, seasonPackUpgrade: 'any' } });
    const range = tv('Show.Name.S01E01-E06.720p.HDTV.x264-GRP', 6 * GB);
    expect(reasons(ctx, range)).toEqual([]);
    expect(seriesPackCoverage(ctx, range)).toMatchObject({ kind: 'episodeRange', episodeCount: 6, wantedCount: 5 });
  });

  it('applies size limits per episode', () => {
    const limits = () => ({ minSize: 5, maxSize: 50, preferredSize: 20 });
    const ctx = makeContext({ qualityLimits: limits });
    // 12 x 45 min: 2.7 GB to 26 GB in total; 0.22 GB to 2.2 GB per episode.
    expect(reasons(ctx, tv('Show.Name.S01.1080p.BluRay.x264-GRP', 12 * GB))).toEqual([]);
    const small = evaluate(ctx, tv('Show.Name.S01.1080p.BluRay.x264-GRP', 1 * GB)).rejections.find((r) => r.reason === 'belowMinimumSize');
    expect(small?.message).toMatch(/per episode/);
    expect(reasons(ctx, tv('Show.Name.S01.1080p.BluRay.x264-GRP', 40 * GB))).toContain('aboveMaximumSize');
  });

  it('applies the global maximum size per episode for packs', () => {
    const settings = { ...makeContext().settings, maximumSizeMb: 3000 };
    expect(reasons(makeContext({ settings }), tv('Show.Name.S01.1080p.BluRay.x264-GRP', 24 * GB))).not.toContain('maximumSizeExceeded');
    expect(reasons(makeContext({ settings }), tv('Show.Name.S01.1080p.BluRay.x264-GRP', 48 * GB))).toContain('maximumSizeExceeded');
    expect(reasons(makeContext({ settings }), tv('Show.Name.S01E01.1080p.BluRay.x264-GRP', 4 * GB))).toContain('maximumSizeExceeded');
  });

  it('ignores seasons that have not started airing in a complete series pack', () => {
    const upcoming = Array.from({ length: 10 }, (_, i) => makeEpisode(show.id, 4, i + 1, { airDateUtc: '2027-01-01T20:00:00.000Z' }));
    const l = snapshot([show], [...seasons, ...upcoming]);
    expect(reasons(makeContext(), tv('Show.Name.Complete.Series.1080p.BluRay.x264-GRP', 40 * GB, l))).not.toContain('fullSeasonNotAired');
    // A season pack of the unaired season itself is still rejected.
    expect(reasons(makeContext(), tv('Show.Name.S04.1080p.BluRay.x264-GRP', 10 * GB, l))).toContain('fullSeasonNotAired');
  });

  it('accepts a complete series pack in a season search', () => {
    const ctx = makeContext({ source: 'search', criteria: { mediaType: 'series', seriesId: show.id, seasonNumber: 2, userInvoked: false } });
    expect(reasons(ctx, tv('Show.Name.Complete.Series.1080p.BluRay.x264-GRP'))).not.toContain('wrongSeason');
  });

  it('records the coverage on the decision', () => {
    const ctx = makeContext({ existingFiles: s1.map((e) => file(quality('WEBDL-1080p'), [e.id])) });
    const c = tv('Show.Name.S01-S03.1080p.BluRay.x264-GRP');
    expect(seriesPackCoverage(ctx, c)).toEqual({ kind: 'multiSeason', seasons: [1, 2, 3], episodeCount: 36, wantedCount: 24 });
    expect(seriesPackCoverage(ctx, tv('Show.Name.S01E01.1080p.BluRay.x264-GRP', GB))).toBeUndefined();
  });
});

describe('pack preference', () => {
  const profile = makeProfile(HD_ALLOWED);
  const rank = (c: Candidate, ctx: DecisionContext): Ranked => {
    const decision = buildDecision('search', c, evaluate(ctx, c));
    const pack = seriesPackCoverage(ctx, c);
    if (pack) decision.pack = pack;
    return {
      decision,
      rank: {
        profile,
        preferredProtocol: undefined,
        runtimeMinutes: 45,
        preferredSizeMbPerMinute: null,
        isAnime: false,
        firstEpisodeNumber: 1,
        ...(pack ? { packPreferred: packPreferred(pack, ctx.settings) } : {}),
      },
    };
  };

  it('prefers the pack when enough of it is wanted', () => {
    const ctx = makeContext();
    const pack = rank(tv('Show.Name.S01.1080p.BluRay.x264-GRP', 10 * GB), ctx);
    const single = rank(tv('Show.Name.S01E01.1080p.BluRay.x264-GRP', GB), ctx);
    expect(compareDecisions(pack, single, 'preferAndUpgrade')).toBeLessThan(0);
  });

  it('prefers single episodes when little of the pack is wanted', () => {
    const ctx = makeContext({ existingFiles: s1.slice(2).map((e) => file(quality('Bluray-1080p'), [e.id])) });
    const pack = rank(tv('Show.Name.S01.1080p.BluRay.x264-GRP', 10 * GB), ctx);
    expect(pack.decision.pack?.wantedCount).toBe(2);
    expect(pack.rank?.packPreferred).toBe(false);
    const single = rank(tv('Show.Name.S01E01.1080p.BluRay.x264-GRP', GB), ctx);
    expect(compareDecisions(pack, single, 'preferAndUpgrade')).toBeGreaterThan(0);
    // The threshold is configurable: at 10% the same pack wins.
    const low = makeContext({ ...ctx, settings: { ...ctx.settings, seasonPackPreferPercent: 10 } });
    expect(compareDecisions(rank(tv('Show.Name.S01.1080p.BluRay.x264-GRP', 10 * GB), low), rank(tv('Show.Name.S01E01.1080p.BluRay.x264-GRP', GB), low), 'preferAndUpgrade')).toBeLessThan(0);
  });

  it('still ranks quality and custom format score before pack preference', () => {
    const ctx = makeContext();
    const pack = rank(tv('Show.Name.S01.720p.HDTV.x264-GRP', 10 * GB), ctx);
    const single = rank(tv('Show.Name.S01E01.1080p.BluRay.x264-GRP', GB), ctx);
    expect(compareDecisions(pack, single, 'preferAndUpgrade')).toBeGreaterThan(0);
  });
});

describe('season search planning', () => {
  it('searches the season once enough of it is wanted', () => {
    expect(wantsSeasonSearch(12, 12, 50)).toBe(true);
    expect(wantsSeasonSearch(7, 12, 50)).toBe(true);
    expect(wantsSeasonSearch(5, 12, 50)).toBe(false);
    expect(wantsSeasonSearch(1, 1, 0)).toBe(false);
    expect(wantsSeasonSearch(3, 12, 25)).toBe(true);
  });

  it('builds anime season-name, alias and absolute-range queries', () => {
    const rules: SceneRule[] = [
      { seriesId: anime.id, kind: 'title', sceneSeason: null, sceneEpisode: null, sceneAbsolute: null, tvdbSeason: 2, tvdbEpisode: null, tvdbAbsolute: null, sceneTitle: 'Anime Title Next Arc', source: 'manual' },
      { seriesId: anime.id, kind: 'title', sceneSeason: null, sceneEpisode: null, sceneAbsolute: null, tvdbSeason: 3, tvdbEpisode: null, tvdbAbsolute: null, sceneTitle: 'Other Arc', source: 'manual' },
    ];
    expect(animeSeasonQueries(anime, 2, animeEps, rules)).toEqual([
      'Anime Title Next Arc',
      'Anime Title Season 2',
      'Anime Title 2nd Season',
      'Anime Title S2',
      'Anime Title 13-24',
    ]);
    expect(animeSeasonQueries(anime, 1, animeEps)).toEqual(['Anime Title Batch', 'Anime Title 01-12']);
    expect(animeSeasonQueries(anime, 3, animeEps)).toContain('Anime Title 3rd Season');
    expect(animeSeasonQueries(anime, 0, animeEps)).toEqual([]);
  });

  it('uses library absolute numbers when present', () => {
    const numbered = animeEps.map((e, i) => ({ ...e, absoluteEpisodeNumber: i + 101 }));
    expect(absoluteRange(numbered, 2)).toEqual([113, 124]);
    expect(absoluteRange(numbered, 9)).toBeNull();
  });
});
