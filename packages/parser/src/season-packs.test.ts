import { describe, expect, it } from 'vitest';
import { parsePath, parseRelease, seriesPackKind, splitSeasonTitle } from './index.js';

const series = (name: string) => parseRelease(name, 'series').series;

describe('splitSeasonTitle', () => {
  it.each([
    ['Anime Title 2nd Season', 'Anime Title', 2, 0],
    ['Anime Title Second Season', 'Anime Title', 2, 0],
    ['Anime Title 3rd Season Part 2', 'Anime Title', 3, 2],
    ['Anime Title Season 4', 'Anime Title', 4, 0],
    ['Anime Title S2', 'Anime Title', 2, 0],
    ['Anime Title: Final Season', 'Anime Title', 'final', 0],
    ['Anime Title Final Season Part 2', 'Anime Title', 'final', 2],
    ['Anime Title 10th Season', 'Anime Title', 10, 0],
  ] as const)('%s', (input, title, season, part) => {
    expect(splitSeasonTitle(input)).toEqual({ title, season, part });
  });

  it('returns null without season words', () => {
    expect(splitSeasonTitle('Anime Title')).toBeNull();
    expect(splitSeasonTitle('Season 2')).toBeNull();
    expect(splitSeasonTitle('The Seasons')).toBeNull();
  });
});

describe('seriesPackKind', () => {
  it.each([
    ['Show.Name.S01.1080p.WEB-DL-GRP', 'season'],
    ['Show.Name.S01-S03.1080p.BluRay-GRP', 'multiSeason'],
    ['Show.Name.Complete.Series.1080p.BluRay-GRP', 'completeSeries'],
    ['Show.Name.S01.Part.1.1080p.WEB-GRP', 'partialSeason'],
    ['Show.Name.S01E01-E06.1080p.WEB-DL-GRP', 'episodeRange'],
    ['[SubGroup] Anime Title (001-024) [Batch]', 'episodeRange'],
    ['Show.Name.S01E01.1080p.WEB-DL-GRP', null],
    ['Show.Name.S01E01E02.720p.HDTV-GRP', null],
    ['Show.Name.S01E01-E02.720p.HDTV-GRP', null],
    ['Show.Name.S02.Extras.1080p.BluRay-GRP', null],
  ] as const)('%s → %s', (input, kind) => {
    expect(seriesPackKind(series(input))).toBe(kind);
  });

  it('is null for nothing parsed', () => {
    expect(seriesPackKind(null)).toBeNull();
    expect(seriesPackKind(undefined)).toBeNull();
  });
});

describe('season pack names', () => {
  it('complete series has every season and no numbers', () => {
    const s = series('Show Name - The Complete Series (2010-2015) 1080p BluRay')!;
    expect(s).toMatchObject({ title: 'Show Name', seasons: [], fullSeason: true, isMultiSeason: true, isCompleteSeries: true });
  });

  it('"Seasons 1 to 4" is a multi-season range', () => {
    expect(series('Show Name Seasons 1 to 4 720p')!.seasons).toEqual([1, 2, 3, 4]);
  });

  it('a season episode range is a pack, not the whole season', () => {
    const s = series('Show.Name.Season.1.Episodes.1-6.720p')!;
    expect(s).toMatchObject({ seasons: [1], episodes: [1, 2, 3, 4, 5, 6], fullSeason: false, isEpisodeRange: true });
  });

  it('concatenated multi-episode files are not ranges', () => {
    const s = series('Show.Name.S01E01E02E03.720p.HDTV-GRP')!;
    expect(s.episodes).toEqual([1, 2, 3]);
    expect(s.isEpisodeRange).toBeFalsy();
  });

  it('anime season batches keep the season words in the title and fill the season', () => {
    const s = series('[SubGroup] Anime Title 2nd Season [1080p] [Batch]')!;
    expect(s).toMatchObject({ title: 'Anime Title 2nd Season', seasons: [2], fullSeason: true, subGroup: 'SubGroup' });
    const f = series('[SubGroup] Anime Title Final Season Part 2 [1080p][Batch]')!;
    expect(f).toMatchObject({ title: 'Anime Title Final Season', seasons: [], isPartialSeason: true, seasonPart: 2, isMiniSeries: false });
  });

  it('absolute batches are ranges', () => {
    const s = series('[SubGroup] Anime Title - 001-100 [1080p HEVC]')!;
    expect(s.absoluteEpisodes).toHaveLength(100);
    expect(s.isEpisodeRange).toBe(true);
  });
});

describe('files inside packs', () => {
  it('a numbered file in a season pack folder takes the folder season', () => {
    expect(parsePath('Show.Name.S02.1080p.WEB-DL-GRP/03 - Episode Title.mkv', 'series').series).toMatchObject({ title: 'Show Name', seasons: [2], episodes: [3], fullSeason: false });
    expect(parsePath('Show.Name.S02.1080p.WEB-DL-GRP/E07.mkv', 'series').series).toMatchObject({ title: 'Show Name', seasons: [2], episodes: [7] });
  });

  it('a numbered file in an absolute batch is one absolute episode', () => {
    expect(parsePath('[SubGroup] Anime Title (001-024) [Batch]/13 - Some Title.mkv', 'series').series).toMatchObject({ absoluteEpisodes: [13], isEpisodeRange: false });
  });

  it('an episode file in a multi-season pack keeps its own numbers', () => {
    const s = parsePath('Show.Name.S01-S03.1080p.BluRay-GRP/Season 2/Show.Name.S02E08.1080p.BluRay-GRP.mkv', 'series').series!;
    expect(s).toMatchObject({ seasons: [2], episodes: [8], isMultiSeason: false });
  });
});
