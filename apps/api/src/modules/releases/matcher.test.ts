import { describe, expect, it } from 'vitest';
import { cleanTitle, matchRelease, numeralTitle } from './matcher.js';
import { makeEpisode, makeMovie, makeSeries, snapshot } from './test-support.js';

describe('cleanTitle', () => {
  it('drops punctuation, case and common words', () => {
    expect(cleanTitle('The Walking Dead!')).toBe('walkingdead');
    expect(cleanTitle('walking dead')).toBe('walkingdead');
    expect(cleanTitle('Carnivàle')).toBe('carnivale');
  });

  it('keeps all-digit titles verbatim and spells out percent', () => {
    expect(cleanTitle('1923')).toBe('1923');
    expect(cleanTitle('3%')).toBe('3percent');
  });

  it('treats roman numerals and number words as digits in the numeral form', () => {
    expect(numeralTitle('Dune Part II')).toBe(numeralTitle('Dune: Part Two'));
    expect(numeralTitle('Dune Part 2')).toBe('dunepart2');
  });
});

describe('series matching', () => {
  const show = makeSeries({ title: 'Show Name' });
  const s2 = [5, 6, 7].map((n) => makeEpisode(show.id, 2, n));
  const s1 = [1].map((n) => makeEpisode(show.id, 1, n));
  const lib = snapshot([show], [...s1, ...s2]);

  it('maps a multi-episode release to both episodes', () => {
    const { match } = matchRelease('Show.Name.S02E05E06.1080p.WEB-DL.DDP5.1.H.264-GRP', {}, lib);
    expect(match.status).toBe('mapped');
    if (match.status !== 'mapped' || match.mediaType !== 'series') throw new Error();
    expect(match.episodes.map((e) => e.episodeNumber)).toEqual([5, 6]);
  });

  it('maps a season pack to every episode of the season', () => {
    const { match } = matchRelease('Show.Name.S02.1080p.BluRay.x264-GRP', {}, lib);
    if (match.status !== 'mapped' || match.mediaType !== 'series') throw new Error(JSON.stringify(match));
    expect(match.fullSeason).toBe(true);
    expect(match.episodes.map((e) => e.id)).toEqual(s2.map((e) => e.id));
  });

  it('skips episode numbers missing from the library', () => {
    const { match } = matchRelease('Show.Name.S01E01E02.720p.HDTV-GRP', {}, lib);
    if (match.status !== 'mapped' || match.mediaType !== 'series') throw new Error();
    expect(match.episodes.map((e) => e.id)).toEqual([s1[0]!.id]);
  });

  it('reports unknownEpisode when the series matches but no episode does', () => {
    const { match } = matchRelease('Show.Name.S09E01.720p.HDTV-GRP', {}, lib);
    expect(match).toMatchObject({ status: 'unknown', reason: 'unknownEpisode' });
  });

  it('reports unknownSeries for titles not in the library', () => {
    const { match } = matchRelease('Other.Show.S01E01.720p.HDTV-GRP', {}, lib);
    expect(match).toMatchObject({ status: 'unknown', reason: 'unknownSeries' });
  });

  it('maps daily releases by air date, but not for standard series', () => {
    const daily = makeSeries({ title: 'Daily Show', seriesType: 'daily' });
    const ep = makeEpisode(daily.id, 2024, 50, { airDate: '2024-03-15' });
    const standard = makeSeries({ title: 'Weekly Show' });
    const ep2 = makeEpisode(standard.id, 1, 1, { airDate: '2024-03-15' });
    const l = snapshot([daily, standard], [ep, ep2]);
    const hit = matchRelease('Daily.Show.2024.03.15.720p.HDTV.x264-GRP', {}, l).match;
    if (hit.status !== 'mapped' || hit.mediaType !== 'series') throw new Error();
    expect(hit.episodes[0]!.id).toBe(ep.id);
    expect(matchRelease('Weekly.Show.2024.03.15.720p.HDTV.x264-GRP', {}, l).match).toMatchObject({ reason: 'unknownEpisode' });
  });

  it('maps anime absolute numbers to the season/episode', () => {
    const anime = makeSeries({ title: 'Anime Name', seriesType: 'anime' });
    const ep = makeEpisode(anime.id, 5, 7, { absoluteEpisodeNumber: 125 });
    const { match } = matchRelease('[SubsPlease] Anime Name - 125 (1080p) [ABCD1234].mkv', {}, snapshot([anime], [ep]));
    if (match.status !== 'mapped' || match.mediaType !== 'series') throw new Error(JSON.stringify(match));
    expect(match.episodes[0]!.id).toBe(ep.id);
  });

  it('uses the year to disambiguate same-titled series, else reports ambiguity', () => {
    const a = makeSeries({ title: 'Remake', year: 2005 });
    const b = makeSeries({ title: 'Remake', year: 2019 });
    const l = snapshot([a, b], [makeEpisode(a.id, 1, 1), makeEpisode(b.id, 1, 1)]);
    const hit = matchRelease('Remake.2019.S01E01.720p.HDTV-GRP', {}, l).match;
    expect(hit.status === 'mapped' && hit.mediaType === 'series' && hit.series.id).toBe(b.id);
    expect(matchRelease('Remake.S01E01.720p.HDTV-GRP', {}, l).match).toMatchObject({ status: 'ambiguous' });
  });

  it('falls back to indexer-supplied tvdb ids', () => {
    const { match } = matchRelease('Totally.Different.Name.S02E05.720p.HDTV-GRP', { tvdbId: show.tvdbId! }, lib);
    expect(match.status === 'mapped' && match.mediaType === 'series' && match.series.id).toBe(show.id);
  });

  it('prefers the searched series when a search is running', () => {
    const { match } = matchRelease('Show.Name.S02E05.720p.HDTV-GRP', {}, lib, {
      criteria: { mediaType: 'series', seriesId: show.id },
    });
    expect(match).toMatchObject({ status: 'mapped', matchType: 'title' });
  });
});

describe('movie matching', () => {
  const dune2 = makeMovie({ title: 'Dune: Part Two', year: 2024 });
  const br82 = makeMovie({ title: 'Blade Runner', year: 1982 });
  const br17 = makeMovie({ title: 'Blade Runner', year: 2017 });
  const lib = snapshot([], [], [dune2, br82, br17]);

  it('matches "Dune Part Two" even though it looks like an episode', () => {
    const { match } = matchRelease('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos-GRP', {}, lib);
    expect(match.status === 'mapped' && match.mediaType === 'movie' && match.movie.id).toBe(dune2.id);
  });

  it('does not match a different year', () => {
    expect(matchRelease('Dune.2021.1080p.BluRay.x264-GRP', {}, lib).match.status).not.toBe('mapped');
  });

  it('picks the movie whose year matches', () => {
    const { match } = matchRelease('Blade.Runner.1982.1080p.BluRay.x264-GRP', {}, lib);
    expect(match.status === 'mapped' && match.mediaType === 'movie' && match.movie.id).toBe(br82.id);
  });

  it('tolerates a year off by one when nothing matches exactly', () => {
    const m = makeMovie({ title: 'Late Film', year: 2023 });
    const { match } = matchRelease('Late.Film.2024.1080p.WEB-DL-GRP', {}, snapshot([], [], [m]), { hint: 'movie' });
    expect(match.status === 'mapped' && match.mediaType === 'movie' && match.movie.id).toBe(m.id);
  });

  it('does not trust an indexer imdb id whose year disagrees', () => {
    const m = makeMovie({ title: 'Original', year: 1990, imdbId: 'tt0100000' });
    const { match } = matchRelease('Remake.2020.1080p.WEB-DL-GRP', { imdbId: 'tt0100000' }, snapshot([], [], [m]), { hint: 'movie' });
    expect(match.status).not.toBe('mapped');
    const ok = matchRelease('Original.1990.1080p.WEB-DL-GRP', { imdbId: 'tt0100000' }, snapshot([], [], [m]), { hint: 'movie' }).match;
    expect(ok).toMatchObject({ status: 'mapped', matchType: 'id' });
  });

  it('reports ambiguity when two movies tie on title and year window', () => {
    const a = makeMovie({ title: 'Twin', year: 2010 });
    const b = makeMovie({ title: 'Twin', year: 2010, tmdbId: 99999 });
    expect(matchRelease('Twin.2010.1080p.WEB-DL-GRP', {}, snapshot([], [], [a, b]), { hint: 'movie' }).match).toMatchObject({
      status: 'ambiguous',
      reason: 'unknownMovie',
    });
  });
});
