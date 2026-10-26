import { describe, expect, it } from 'vitest';
import type { Episode, Series } from '@arclight/shared';
import { matchRelease, type LibrarySnapshot, type SeriesMatch } from '../releases/matcher.js';
import { makeEpisode, makeSeries } from '../releases/test-support.js';
import { absoluteIndex, type SceneRule } from './mapping.js';

// Matcher integration of scene numbering: precedence manual > feed > anime absolute fallback,
// multi-season anime, season packs and title aliases.

function rule(seriesId: number, r: Partial<SceneRule> & Pick<SceneRule, 'kind'>): SceneRule {
  return {
    seriesId,
    sceneSeason: null,
    sceneEpisode: null,
    sceneAbsolute: null,
    tvdbSeason: null,
    tvdbEpisode: null,
    tvdbAbsolute: null,
    sceneTitle: null,
    source: 'feed',
    ...r,
  };
}

function lib(series: Series[], episodes: Episode[], rules: SceneRule[] = []): LibrarySnapshot {
  return {
    series: () => series,
    episodes: (id) => episodes.filter((e) => e.seriesId === id),
    movies: () => [],
    sceneMappings: (id) => rules.filter((r) => r.seriesId === id),
    sceneTitleRules: () => rules.filter((r) => r.kind === 'title'),
  };
}

function mapped(title: string, l: LibrarySnapshot, criteria?: { seriesId: number }): SeriesMatch {
  const { match } = matchRelease(title, {}, l, criteria ? { criteria: { mediaType: 'series', ...criteria } } : { hint: 'series' });
  if (match.status !== 'mapped' || match.mediaType !== 'series') throw new Error(`not mapped: ${title} ${JSON.stringify(match)}`);
  return match;
}

const se = (m: SeriesMatch) => m.episodes.map((e) => `S${e.seasonNumber}E${e.episodeNumber}`);

/** Season 1: 24 episodes, season 2: 12, season 3: 10. */
function standardShow(overrides: Partial<Series> = {}) {
  const show = makeSeries({ title: 'Show Name', ...overrides });
  const episodes = [
    ...Array.from({ length: 24 }, (_, i) => makeEpisode(show.id, 1, i + 1)),
    ...Array.from({ length: 12 }, (_, i) => makeEpisode(show.id, 2, i + 1)),
    ...Array.from({ length: 10 }, (_, i) => makeEpisode(show.id, 3, i + 1)),
  ];
  return { show, episodes };
}

describe('season mappings', () => {
  it('remaps a whole scene season to another library season', () => {
    const { show, episodes } = standardShow();
    const l = lib([show], episodes, [rule(show.id, { kind: 'season', sceneSeason: 4, tvdbSeason: 3 })]);
    const m = mapped('Show.Name.S04E05.1080p.WEB-DL-GRP', l);
    expect(se(m)).toEqual(['S3E5']);
    expect(m.sceneSource).toBe('feed');
  });

  it('applies an episode anchor as an offset (scene S02E03 = library S01E15)', () => {
    const { show, episodes } = standardShow();
    const l = lib([show], episodes, [rule(show.id, { kind: 'season', sceneSeason: 2, sceneEpisode: 1, tvdbSeason: 1, tvdbEpisode: 13 })]);
    expect(se(mapped('Show.Name.S02E03.1080p.WEB-DL-GRP', l))).toEqual(['S1E15']);
  });

  it('uses the nearest anchor at or below the episode, and leaves numbers below every anchor alone', () => {
    const { show, episodes } = standardShow();
    const l = lib([show], episodes, [
      rule(show.id, { kind: 'season', sceneSeason: 3, sceneEpisode: 5, tvdbSeason: 2, tvdbEpisode: 1 }),
      rule(show.id, { kind: 'season', sceneSeason: 3, sceneEpisode: 9, tvdbSeason: 2, tvdbEpisode: 10 }),
    ]);
    expect(se(mapped('Show.Name.S03E06.720p.HDTV-GRP', l))).toEqual(['S2E2']);
    expect(se(mapped('Show.Name.S03E09E10.720p.HDTV-GRP', l))).toEqual(['S2E10', 'S2E11']);
    expect(se(mapped('Show.Name.S03E02.720p.HDTV-GRP', l))).toEqual(['S3E2']);
  });

  it('maps a scene season onto library absolute numbers', () => {
    const show = makeSeries({ title: 'Long Show', seriesType: 'anime' });
    const episodes = Array.from({ length: 100 }, (_, i) => makeEpisode(show.id, 1, i + 1, { absoluteEpisodeNumber: i + 1 }));
    const l = lib([show], episodes, [rule(show.id, { kind: 'season', sceneSeason: 2, sceneEpisode: 1, tvdbAbsolute: 62 })]);
    expect(se(mapped('Long.Show.S02E03.1080p.WEB-DL-GRP', l))).toEqual(['S1E64']);
  });

  it('maps a season pack through an anchor to the right episode range', () => {
    const { show, episodes } = standardShow();
    const l = lib([show], episodes, [
      rule(show.id, { kind: 'season', sceneSeason: 1, sceneEpisode: 1, tvdbSeason: 1, tvdbEpisode: 1 }),
      rule(show.id, { kind: 'season', sceneSeason: 2, sceneEpisode: 1, tvdbSeason: 1, tvdbEpisode: 13 }),
      rule(show.id, { kind: 'season', sceneSeason: 3, tvdbSeason: 2 }),
    ]);
    const s2 = mapped('Show.Name.S02.1080p.BluRay.x264-GRP', l);
    expect(s2.fullSeason).toBe(true);
    expect(se(s2)).toEqual(Array.from({ length: 12 }, (_, i) => `S1E${i + 13}`));
    const s1 = mapped('Show.Name.S01.1080p.BluRay.x264-GRP', l);
    expect(se(s1)).toEqual(Array.from({ length: 12 }, (_, i) => `S1E${i + 1}`));
  });

  it('maps a multi-season pack season by season', () => {
    const { show, episodes } = standardShow();
    const l = lib([show], episodes, [rule(show.id, { kind: 'season', sceneSeason: 2, tvdbSeason: 3 })]);
    const m = mapped('Show.Name.S01-S02.1080p.BluRay.x264-GRP', l);
    expect(m.episodes).toHaveLength(24 + 10);
    expect(new Set(m.episodes.map((e) => e.seasonNumber))).toEqual(new Set([1, 3]));
  });
});

describe('absolute mappings and precedence', () => {
  it('maps scene absolute numbers to library season/episode', () => {
    const { show, episodes } = standardShow({ seriesType: 'anime' });
    const l = lib([show], episodes, [rule(show.id, { kind: 'absolute', sceneAbsolute: 25, tvdbSeason: 2, tvdbEpisode: 1 })]);
    expect(se(mapped('[SubsPlease] Show Name - 29 (1080p)', l))).toEqual(['S2E5']);
  });

  it('maps scene absolute numbers to shifted library absolute numbers', () => {
    const show = makeSeries({ title: 'Show Name', seriesType: 'anime' });
    const episodes = Array.from({ length: 30 }, (_, i) => makeEpisode(show.id, 1, i + 1, { absoluteEpisodeNumber: i + 1 }));
    const l = lib([show], episodes, [rule(show.id, { kind: 'absolute', sceneAbsolute: 1, tvdbAbsolute: 3 })]);
    expect(se(mapped('[Group] Show Name - 10 [1080p]', l))).toEqual(['S1E12']);
  });

  it('prefers manual rules over feed rules', () => {
    const { show, episodes } = standardShow();
    const l = lib([show], episodes, [
      rule(show.id, { kind: 'season', sceneSeason: 4, tvdbSeason: 3, source: 'feed' }),
      rule(show.id, { kind: 'season', sceneSeason: 4, tvdbSeason: 2, source: 'manual' }),
    ]);
    const m = mapped('Show.Name.S04E05.1080p.WEB-DL-GRP', l);
    expect(se(m)).toEqual(['S2E5']);
    expect(m.sceneSource).toBe('manual');
  });

  it('falls back to feed rules when the manual rules do not cover the release', () => {
    const { show, episodes } = standardShow();
    const l = lib([show], episodes, [
      rule(show.id, { kind: 'season', sceneSeason: 5, tvdbSeason: 1, source: 'manual' }),
      rule(show.id, { kind: 'season', sceneSeason: 4, tvdbSeason: 3, source: 'feed' }),
    ]);
    const m = mapped('Show.Name.S04E02.1080p.WEB-DL-GRP', l);
    expect(se(m)).toEqual(['S3E2']);
    expect(m.sceneSource).toBe('feed');
  });

  it('prefers a feed absolute rule over the derived anime absolute fallback', () => {
    const { show, episodes } = standardShow({ seriesType: 'anime' });
    const l = lib([show], episodes, [rule(show.id, { kind: 'absolute', sceneAbsolute: 30, tvdbSeason: 3, tvdbEpisode: 1 })]);
    expect(se(mapped('[Group] Show Name - 31 [1080p]', l))).toEqual(['S3E2']);
    // Below the anchor the fallback (derived absolute numbering) still applies.
    expect(se(mapped('[Group] Show Name - 26 [1080p]', l))).toEqual(['S2E2']);
  });

  it('restricts an absolute rule to its scene season', () => {
    const { show, episodes } = standardShow({ seriesType: 'anime' });
    const l = lib([show], episodes, [rule(show.id, { kind: 'absolute', sceneSeason: 3, sceneAbsolute: 1, tvdbSeason: 3, tvdbEpisode: 1 })]);
    // "S02E05 - 030": season 2 does not match the rule; the anime fallback maps absolute 30.
    expect(se(mapped('Show Name - S02E05 - 030 [1080p]', l))).toEqual(['S2E6']);
  });
});

describe('anime absolute fallback (no mapping)', () => {
  it('uses the library absolute numbers when present', () => {
    const show = makeSeries({ title: 'Show Name', seriesType: 'anime' });
    const episodes = [
      makeEpisode(show.id, 1, 1, { absoluteEpisodeNumber: 1 }),
      makeEpisode(show.id, 2, 1, { absoluteEpisodeNumber: 14 }),
    ];
    const m = mapped('[SubsPlease] Show Name - 14 (1080p)', lib([show], episodes));
    expect(se(m)).toEqual(['S2E1']);
    expect(m.sceneSource).toBeUndefined();
  });

  it('derives absolute numbers across seasons when the library has none', () => {
    const { show, episodes } = standardShow({ seriesType: 'anime' });
    const m = mapped('[SubsPlease] Show Name - 27 (1080p)', lib([show], episodes));
    expect(se(m)).toEqual(['S2E3']);
    expect(m.sceneSource).toBe('absolute');
    expect(se(mapped('[SubsPlease] Show Name - 37 (1080p)', lib([show], episodes)))).toEqual(['S3E1']);
  });

  it('reads an episode past the end of the season as absolute (S01E27 = S02E03)', () => {
    const { show, episodes } = standardShow({ seriesType: 'anime' });
    expect(se(mapped('Show.Name.S01E27.1080p.WEB-DL-GRP', lib([show], episodes)))).toEqual(['S2E3']);
    // A number inside the season stays a season episode.
    expect(se(mapped('Show.Name.S01E05.1080p.WEB-DL-GRP', lib([show], episodes)))).toEqual(['S1E5']);
  });

  it('does not derive absolute numbers for standard series', () => {
    const { show, episodes } = standardShow();
    const { match } = matchRelease('Show.Name.S01E27.1080p.WEB-DL-GRP', {}, lib([show], episodes), { hint: 'series' });
    expect(match).toMatchObject({ status: 'unknown', reason: 'unknownEpisode' });
    expect(absoluteIndex(episodes, false).size).toBe(0);
    expect(absoluteIndex(episodes, true).get(25)).toMatchObject({ seasonNumber: 2, episodeNumber: 1 });
  });
});

describe('title aliases', () => {
  it('matches a release by a scene title alias', () => {
    const { show, episodes } = standardShow({ title: 'Attack on Titan', seriesType: 'anime' });
    const l = lib([show], episodes, [rule(show.id, { kind: 'title', sceneTitle: 'Shingeki no Kyojin' })]);
    const m = mapped('[SubsPlease] Shingeki no Kyojin - 05 (1080p)', l);
    expect(m.series.id).toBe(show.id);
    expect(m.matchType).toBe('alias');
    expect(se(m)).toEqual(['S1E5']);
  });

  it('lands releases matched through a season alias in that season', () => {
    const { show, episodes } = standardShow({ seriesType: 'anime' });
    const l = lib([show], episodes, [rule(show.id, { kind: 'title', sceneTitle: 'Show Name 2nd Season', tvdbSeason: 2 })]);
    const m = mapped('[Group] Show Name 2nd Season - 05 [1080p]', l);
    expect(se(m)).toEqual(['S2E5']);
    expect(m.sceneSource).toBe('feed');
  });

  it('ignores an alias restricted to another scene season', () => {
    const { show, episodes } = standardShow();
    const l = lib([show], episodes, [rule(show.id, { kind: 'title', sceneTitle: 'Alt Name', sceneSeason: 2 })]);
    expect(se(mapped('Alt.Name.S02E01.720p.HDTV-GRP', l))).toEqual(['S2E1']);
    const { match } = matchRelease('Alt.Name.S01E01.720p.HDTV-GRP', {}, l, { hint: 'series' });
    expect(match).toMatchObject({ status: 'unknown', reason: 'unknownSeries' });
  });

  it('reports an alias shared by two series as ambiguous, unless one is being searched', () => {
    const a = makeSeries({ title: 'First Show' });
    const b = makeSeries({ title: 'Second Show' });
    const episodes = [makeEpisode(a.id, 1, 1), makeEpisode(b.id, 1, 1)];
    const l = lib([a, b], episodes, [
      rule(a.id, { kind: 'title', sceneTitle: 'Shared Alias' }),
      rule(b.id, { kind: 'title', sceneTitle: 'Shared Alias' }),
    ]);
    const { match } = matchRelease('Shared.Alias.S01E01.720p.HDTV-GRP', {}, l, { hint: 'series' });
    expect(match).toMatchObject({ status: 'ambiguous', candidates: [a.id, b.id] });
    expect(mapped('Shared.Alias.S01E01.720p.HDTV-GRP', l, { seriesId: b.id }).series.id).toBe(b.id);
  });

  it('prefers a manual alias rule over a feed alias rule of the same series', () => {
    const { show, episodes } = standardShow({ seriesType: 'anime' });
    const l = lib([show], episodes, [
      rule(show.id, { kind: 'title', sceneTitle: 'Show Name S2', tvdbSeason: 3, source: 'feed' }),
      rule(show.id, { kind: 'title', sceneTitle: 'Show Name S2', tvdbSeason: 2, source: 'manual' }),
    ]);
    const m = mapped('[Group] Show Name S2 - 05 [1080p]', l);
    expect(se(m)).toEqual(['S2E5']);
    expect(m.sceneSource).toBe('manual');
  });
});
