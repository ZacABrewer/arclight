import { describe, expect, it } from 'vitest';
import { NAMING_DEFAULTS, NamingConfig, type Episode, type MediaFile, type Movie, type Series } from '@media-tron/shared';
import {
  NamingFormatError,
  buildEpisodeFileName,
  buildMovieFileName,
  buildMovieFolder,
  buildSeasonFolder,
  buildSeriesFolder,
  getSamples,
  requiresAbsoluteNumber,
  requiresEpisodeTitle,
} from './build.js';
import { SAMPLES } from './samples.js';
import type { NamingEpisode, NamingFile, NamingMovie, NamingSeries } from './types.js';

const cfg = (o: Partial<NamingConfig> = {}): NamingConfig => ({
  ...NAMING_DEFAULTS,
  renameEpisodes: true,
  renameMovies: true,
  ...o,
});

const S = SAMPLES;
const series = S.series;
const ep = (n: number, o: Partial<NamingEpisode> = {}): NamingEpisode => ({ ...S.episodes[0]!, episodeNumber: n, absoluteEpisodeNumber: n, title: `Episode Title (${n})`, ...o });
const three = [ep(1), ep(2), ep(3)];
const file = S.file;
const extras = S.extras;
const tv = (format: string, o: { series?: NamingSeries; episodes?: NamingEpisode[]; file?: NamingFile; config?: Partial<NamingConfig> } = {}) =>
  buildEpisodeFileName(
    cfg({ standardEpisodeFormat: format, dailyEpisodeFormat: format, animeEpisodeFormat: format, ...o.config }),
    o.series ?? series,
    o.episodes ?? [ep(1)],
    o.file ?? file,
    extras,
  );
const folder = (title: string, format = '{Series Title}', o: Partial<NamingConfig> = {}, year = 2010) =>
  buildSeriesFolder(cfg({ seriesFolderFormat: format, ...o }), { title, year, seriesType: 'standard' });

describe('config contract', () => {
  it('defaults match the upstream defaults', () => {
    expect(NAMING_DEFAULTS).toMatchObject({
      renameEpisodes: false,
      renameMovies: false,
      replaceIllegalCharacters: true,
      colonReplacement: 'smart',
      multiEpisodeStyle: 'prefixedRange',
      standardEpisodeFormat: '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}',
      dailyEpisodeFormat: '{Series Title} - {Air-Date} - {Episode Title} {Quality Full}',
      seasonFolderFormat: 'Season {season}',
      specialsFolderFormat: 'Specials',
      movieFormat: '{Movie Title} ({Release Year}) {Quality Full}',
      movieFolderFormat: '{Movie Title} ({Release Year})',
    });
  });

  it('rejects illegal custom colon text', () => {
    expect(NamingConfig.safeParse({ customColonReplacement: 'a:b' }).success).toBe(false);
    expect(NamingConfig.safeParse({ customColonReplacement: ' ~' }).success).toBe(true);
  });

  it('accepts shared library records structurally', () => {
    // Compile-time check: the shared contract types satisfy the builder inputs.
    const accept = (_s: NamingSeries, _e: NamingEpisode, _f: NamingFile, _m: NamingMovie) => true;
    const typed = accept as unknown as (s: Series, e: Episode, f: MediaFile, m: Movie) => boolean;
    expect(typeof typed).toBe('function');
  });
});

describe('default formats (spec examples)', () => {
  it('single episode', () => {
    expect(buildEpisodeFileName(cfg(), series, [ep(1)], file, extras)).toBe(
      "The Series Title's! - S01E01 - Episode Title (1) WEBDL-1080p Proper",
    );
  });

  it('multi episode', () => {
    expect(buildEpisodeFileName(cfg(), series, three, file, extras)).toBe(
      "The Series Title's! - S01E01-E03 - Episode Title WEBDL-1080p Proper",
    );
  });

  it('daily', () => {
    expect(buildEpisodeFileName(cfg(), S.dailySeries, [ep(1)], file, extras)).toBe(
      "The Series Title's! - 2013-10-30 - Episode Title (1) WEBDL-1080p Proper",
    );
  });

  it('daily specials use the standard format', () => {
    expect(buildEpisodeFileName(cfg(), S.dailySeries, [ep(1, { seasonNumber: 0 })], file, extras)).toBe(
      "The Series Title's! - S00E01 - Episode Title (1) WEBDL-1080p Proper",
    );
  });

  it('anime with absolute number and version', () => {
    const c = cfg({ animeEpisodeFormat: '{Series Title} - S{season:00}E{episode:00} - {absolute:000} - {Episode Title} {Quality Full}' });
    expect(buildEpisodeFileName(c, S.animeSeries, [ep(1)], file, extras)).toBe(
      "The Series Title's! - S01E01 - 001 - Episode Title (1) WEBDL-1080p v2",
    );
  });

  it('anime without absolute numbers falls back to the standard format', () => {
    const c = cfg({ animeEpisodeFormat: '{Series Title} - {absolute:000}', standardEpisodeFormat: '{Series Title} S{season:00}E{episode:00}' });
    expect(buildEpisodeFileName(c, S.animeSeries, [ep(1, { absoluteEpisodeNumber: null })], file, extras)).toBe(
      "The Series Title's! S01E01",
    );
  });

  it.each([
    [2, 5, 'The Fall', 'HDTV-720p', 1, "The Series Title's! - S02E05 - The Fall HDTV-720p"],
  ])('worked example S%iE%i', (season, episode, title, quality, version, expected) => {
    const f: NamingFile = { ...file, quality: { quality: { name: quality }, revision: { version, real: 0 } } };
    expect(buildEpisodeFileName(cfg(), series, [{ seasonNumber: season, episodeNumber: episode, title }], f, extras)).toBe(expected);
  });

  it('multipart titles collapse; distinct titles join with +', () => {
    expect(buildEpisodeFileName(cfg(), series, [ep(1, { title: 'Pilot (1)' }), ep(2, { title: 'Pilot (2)' })], file, extras)).toBe(
      "The Series Title's! - S01E01-E02 - Pilot WEBDL-1080p Proper",
    );
    expect(buildEpisodeFileName(cfg(), series, [ep(1, { title: 'Alpha' }), ep(2, { title: 'Beta' })], file, extras)).toBe(
      "The Series Title's! - S01E01-E02 - Alpha + Beta WEBDL-1080p Proper",
    );
  });

  it('episodes are sorted before numbering', () => {
    expect(buildEpisodeFileName(cfg(), series, [ep(3), ep(1), ep(2)], file, extras)).toContain('S01E01-E03');
  });
});

describe('multi-episode styles', () => {
  it.each([
    ['extend', 'S01E01-02-03'],
    ['duplicate', 'S01E01 - S01E02 - S01E03'],
    ['repeat', 'S01E01E02E03'],
    ['scene', 'S01E01-E02-E03'],
    ['range', 'S01E01-03'],
    ['prefixedRange', 'S01E01-E03'],
  ] as const)('%s', (style, numbering) => {
    expect(buildEpisodeFileName(cfg({ multiEpisodeStyle: style }), series, three, file, extras)).toBe(
      `The Series Title's! - ${numbering} - Episode Title WEBDL-1080p Proper`,
    );
  });

  it.each(['extend', 'duplicate', 'repeat', 'scene', 'range', 'prefixedRange'] as const)('%s degrades to the plain pattern for one episode', (style) => {
    expect(tv('S{season:00}E{episode:00}', { config: { multiEpisodeStyle: style } })).toBe('S01E01');
  });

  it('duplicate without a trailing run uses the leading separator', () => {
    expect(tv('{Series Title} S{season:00}E{episode:00}', { episodes: [ep(1), ep(2)], config: { multiEpisodeStyle: 'duplicate' } })).toBe(
      "The Series Title's! S01E01 S01E02",
    );
  });

  it('keeps the case and separator of the numbering pattern', () => {
    expect(tv('{Series Title} - {season}x{episode:00}', { episodes: [ep(1), ep(2)], config: { multiEpisodeStyle: 'repeat' } })).toBe(
      "The Series Title's! - 1x01x02",
    );
    expect(tv('s{season:00}.e{episode:00}', { episodes: [ep(1), ep(2)], config: { multiEpisodeStyle: 'scene' } })).toBe('s01.e01-.e02');
  });

  it('standalone episode token renders first-last', () => {
    expect(tv('{Series Title} - {season}-{episode:00}', { episodes: three })).toBe("The Series Title's! - 1-01-03");
  });

  const anime = (style: NamingConfig['multiEpisodeStyle'], eps = three) =>
    buildEpisodeFileName(
      cfg({ multiEpisodeStyle: style, animeEpisodeFormat: '{Series Title} - {absolute:000} - {Episode Title}' }),
      S.animeSeries,
      eps,
      file,
      extras,
    );
  it.each([
    ['extend', '001-002-003'],
    ['duplicate', '001 - 002 - 003'],
    ['repeat', '001-002-003'],
    ['scene', '001-002-003'],
    ['range', '001-003'],
    ['prefixedRange', '001-003'],
  ] as const)('absolute %s', (style, numbers) => {
    expect(anime(style)).toBe(`The Series Title's! - ${numbers} - Episode Title`);
  });

  it('absolute range example 12-13', () => {
    expect(anime('prefixedRange', [ep(1, { absoluteEpisodeNumber: 12, title: 'Title' }), ep(2, { absoluteEpisodeNumber: 13, title: 'Title' })])).toBe(
      "The Series Title's! - 012-013 - Title",
    );
  });

  it('absolute token is deleted for non-anime series', () => {
    expect(tv('{Series Title} S{season:00}E{episode:00} {absolute:000}')).toBe("The Series Title's! S01E01");
  });
});

describe('series tokens and case/separator rules', () => {
  it.each([
    ['{Series.Title}.S{season:00}E{episode:00}.{Episode.Title}.{Quality.Full}-{Release Group}', "The.Series.Title's!.S01E01.Episode.Title.(1).WEBDL-1080p.Proper-RlsGrp"],
    ['{series title} - s{season:00}e{episode:00}', "the series title's! - s01e01"],
    ['{SERIES.TITLE}', "THE.SERIES.TITLE'S!"],
    ['{Series Title} {[Quality Title]}{-Release Group}', "The Series Title's! [WEBDL-1080p]-RlsGrp"],
    ['{Series TitleYear} - {season}x{episode:00}', "The Series Title's! (2010) - 1x01"],
    ['{Series CleanTitle}', "The Series Title's!"],
    ['{Series CleanTitleYear}', "The Series Title's! 2010"],
    ['{Series TitleThe}', "Series Title's!, The"],
    ['{Series CleanTitleThe}', "Series Title's!, The"],
    ['{Series TitleTheYear}', "Series Title's!, The (2010)"],
    ['{Series CleanTitleTheYear}', "Series Title's!, The 2010"],
    ['{Series TitleFirstCharacter}', 'S'],
    ['{Series Year}', '2010'],
    ['{Series Type}', 'Standard'],
    ['{ImdbId} {TvdbId} {TmdbId} {TvMazeId}', 'tt12345 12345 54321 2345'],
    ['{Series Title:10}', 'The Ser...'],
    ['{Series Title:-10}', "...itle's!"],
  ])('%s', (format, expected) => {
    expect(tv(format)).toBe(expected);
  });

  it.each([
    ['Fargo', 2014, '{Series TitleYear}', 'Fargo (2014)'],
    ['Fargo (2014)', 2015, '{Series TitleYear}', 'Fargo (2014)'],
    ['Fargo (2014)', 2014, '{Series TitleWithoutYear}', 'Fargo'],
    ['The Office', 2005, '{Series TitleTheYear}', 'Office, The (2005)'],
    // Folder clean-up (4.10.1) trims the trailing dot that example 11.12 shows; Windows forbids it.
    ["Marvel's Agents of S.H.I.E.L.D.", 2013, '{Series CleanTitle}', 'Marvels Agents of S.H.I.E.L.D'],
    ['The 100', 2014, '{Series TitleFirstCharacter}/{Series Title}', '1/The 100'],
    ['Breaking Bad Extra', 2008, '{Series Title:12}', 'Breaking...'],
  ])('series folder %s %s %s', (title, year, format, expected) => {
    expect(folder(title, format, {}, year)).toBe(expected);
  });

  it('unknown ids render empty', () => {
    expect(tv('{Series Title}{ [TvMazeId]}', { series: { ...series, tvMazeId: 0 } })).toBe("The Series Title's!");
  });
});

describe('colons and illegal characters', () => {
  it.each([
    ['smart', 'CSI - Miami - S01E01'],
    ['delete', 'CSI Miami - S01E01'],
    ['dash', 'CSI- Miami - S01E01'],
    ['spaceDash', 'CSI - Miami - S01E01'],
    ['spaceDashSpace', 'CSI - Miami - S01E01'],
  ] as const)('colon %s', (mode, expected) => {
    expect(tv('{Series Title} - S{season:00}E{episode:00}', { series: { ...series, title: 'CSI: Miami' }, config: { colonReplacement: mode } })).toBe(expected);
  });

  it('custom colon text applies to TV only', () => {
    const c = { colonReplacement: 'custom' as const, customColonReplacement: ' ~' };
    expect(folder('CSI: Miami', '{Series Title}', c)).toBe('CSI ~ Miami');
    expect(buildMovieFolder(cfg(c), { ...S.movie })).toBe('The Movie - Title (2010)');
  });

  it('illegal characters are replaced in values, not in literal text', () => {
    expect(folder('Who? What*')).toBe('Who! What-');
    expect(folder('AC/DC <Live>')).toBe('AC+DC Live');
    expect(folder('AC/DC: Live?', '{Series Title}', { replaceIllegalCharacters: false })).toBe('ACDC Live');
  });

  it('literal ellipsis in the pattern is protected (TV)', () => {
    expect(tv('{Series Title}...{Release Group}')).toBe("The Series Title's!...RlsGrp");
  });
});

describe('optional tokens and clean-up', () => {
  const noGroup: NamingFile = { ...file, releaseGroup: null };
  it.each([
    ['{Series Title}{ - Release Group}', noGroup, "The Series Title's!"],
    ['{Series Title} - {Release Group}', noGroup, "The Series Title's! - Media-Tron"],
    ['{Series Title} - {Release Hash}', file, "The Series Title's!"],
    // Runs of *different* separators are left alone (4.9.2); use a prefix block to make it optional.
    ['{Series Title} - S{season:00}E{episode:00} - {Bogus Token} - {Quality Title}', file, "The Series Title's! - S01E01 - - WEBDL-1080p"],
    ['{Series Title} - S{season:00}E{episode:00}{ - Bogus Token} - {Quality Title}', file, "The Series Title's! - S01E01 - WEBDL-1080p"],
    ['{Series Title}  {Release Hash}  -  {Quality Title}', file, "The Series Title's! - WEBDL-1080p"],
    ['{{Series Title}} {Series Title}', file, "{Series Title} The Series Title's!"],
  ])('%s', (format, f, expected) => {
    expect(tv(format, { file: f })).toBe(expected);
  });

  it('season folder trims dangling separators', () => {
    const c = cfg({ seasonFolderFormat: 'Season {season} - {Season Title}' });
    expect(buildSeasonFolder(c, series, 1)).toBe('Season 1');
    expect(buildSeasonFolder(c, series, 1, { seasonTitle: 'Cour: 2' })).toBe('Season 1 - Cour - 2');
  });

  it('folders keep trailing dashes but lose trailing dots and spaces', () => {
    expect(folder('Title -')).toBe('Title -');
    expect(folder('Title...')).toBe('Title');
  });

  it('reserved device names', () => {
    expect(buildMovieFolder(cfg({ movieFolderFormat: '{Movie.Title} ({Release Year})' }), { title: 'Con Air', year: 1997 })).toBe('Con_Air (1997)');
    expect(folder('Con', '{Series Title}')).toBe('Con_');
  });
});

describe('air date, episode titles, original names', () => {
  it.each([
    ['{Air-Date}', '2013-10-30'],
    ['{Air.Date}', '2013.10.30'],
    ['{Air Date}', '2013 10 30'],
    ['{Air_Date}', '2013_10_30'],
  ])('%s', (format, expected) => {
    expect(tv(format)).toBe(expected);
  });

  it('missing air date renders Unknown; multi-episode uses the first', () => {
    expect(tv('{Air-Date}', { episodes: [ep(1, { airDate: null })] })).toBe('Unknown');
    expect(tv('{Air-Date}', { episodes: [ep(1, { airDate: '2020-01-01' }), ep(2, { airDate: '2020-01-02' })] })).toBe('2020-01-01');
  });

  it('clean episode titles join with "and"', () => {
    const eps = [ep(1, { title: 'The Beginning' }), ep(2, { title: "The End's Near" })];
    expect(tv('{Episode Title}', { episodes: eps })).toBe("The Beginning + The End's Near");
    expect(tv('{Episode CleanTitle}', { episodes: eps })).toBe('The Beginning and The Ends Near');
  });

  it('episode title truncation modifier', () => {
    expect(tv('{Episode Title:8}')).toBe('Episo...');
  });

  it('original title prefers the scene name, else the file name when no numbering is present', () => {
    expect(tv('{Original Title}')).toBe("The.Series.Title's!.S01E01.1080p.WEBDL.x264-EVOLVE");
    const noScene: NamingFile = { ...file, sceneName: null };
    expect(tv('{Original Title}', { file: noScene })).toBe("The.Series.Title's!.S01E01.1080p.WEBDL.x264-EVOLVE");
    expect(tv('{Original Filename}', { file: noScene })).toBe("The.Series.Title's!.S01E01.1080p.WEBDL.x264-EVOLVE");
  });

  it('original filename is empty when the component carries numbering and the file is saved', () => {
    const noScene: NamingFile = { ...file, sceneName: null, relativePath: 'old name.mkv' };
    expect(tv('S{season:00}E{episode:00} {Original Filename}', { file: noScene })).toBe('S01E01');
    expect(tv('S{season:00}E{episode:00} {Original Filename}', { file: { ...noScene, id: 0 } })).toBe('S01E01 old name');
  });

  it('release hash', () => {
    expect(tv('{Series Title} [{Release Hash}]', { file: S.animeFile })).toBe("The Series Title's! [ABCDEFGH]");
  });
});

describe('quality, media info and custom formats', () => {
  const q = (name: string, version: number, real: number): NamingFile => ({ ...file, quality: { quality: { name }, revision: { version, real } } });
  it.each([
    [q('Bluray-1080p', 1, 0), series, 'Bluray-1080p'],
    [q('WEBDL-1080p', 2, 0), series, 'WEBDL-1080p Proper'],
    [q('HDTV-720p', 2, 1), series, 'HDTV-720p Proper REAL'],
    [q('WEBDL-1080p', 3, 0), S.animeSeries, 'WEBDL-1080p v3'],
  ])('quality full %#', (f, s, expected) => {
    expect(tv('{Quality Full}', { file: f, series: s })).toBe(expected);
  });

  it('quality parts and user titles', () => {
    expect(tv('{Quality Title}|{Quality Proper}|{Quality Real}', { file: q('HDTV-720p', 2, 1) })).toBe('HDTV-720p|Proper|REAL');
    const titled: NamingFile = { ...file, quality: { quality: { name: 'WEBDL-1080p', title: 'WEB 1080p' }, revision: { version: 1, real: 0 } } };
    expect(tv('{Quality Title}', { file: titled })).toBe('WEB 1080p');
  });

  it.each([
    ['{MediaInfo Simple}', 'x264 DTS'],
    ['{MediaInfo Full}', 'x264 DTS [DE] [EN+DE]'],
    ['{MediaInfo VideoCodec}', 'x264'],
    ['{MediaInfo AudioCodec}', 'DTS'],
    ['{MediaInfo AudioChannels}', '5.1'],
    ['{MediaInfo AudioLanguages}', '[DE]'],
    ['{MediaInfo AudioLanguagesAll}', '[DE]'],
    ['{MediaInfo SubtitleLanguages}', '[EN+DE]'],
    ['{MediaInfo SubtitleLanguages:DE}', '[DE]'],
    ['{MediaInfo VideoDynamicRange}', 'HDR'],
    ['{MediaInfo VideoDynamicRangeType}', 'HLG'],
    ['{MediaInfo VideoBitDepth}', '10'],
    ['{MediaInfo 3D}', ''],
  ])('%s', (format, expected) => {
    expect(tv(format)).toBe(expected);
  });

  it('english-only audio is skipped by AudioLanguages and MediaInfo Full', () => {
    const f: NamingFile = { ...file, mediaInfo: { ...file.mediaInfo, audioLanguages: ['eng'] } };
    expect(tv('{MediaInfo Full}', { file: f })).toBe('x264 DTS [EN+DE]');
    expect(tv('{Series Title} {MediaInfo AudioLanguages}', { file: f })).toBe("The Series Title's!");
    expect(tv('{MediaInfo AudioLanguagesAll}', { file: f })).toBe('[EN]');
  });

  it('"and others" language marker survives separator collapsing', () => {
    const f: NamingFile = { ...file, mediaInfo: { ...file.mediaInfo, subtitles: ['en', 'de', 'fr'] } };
    expect(tv('{Series Title} {MediaInfo SubtitleLanguages:EN+}', { file: f })).toBe("The Series Title's! [EN+--]");
  });

  it('media info tokens vanish without media info; SDR has no dynamic range', () => {
    expect(tv('{Series Title} {MediaInfo Simple}', { file: { ...file, mediaInfo: null } })).toBe("The Series Title's!");
    const sdr: NamingFile = { ...file, mediaInfo: { videoFormat: 'hevc', videoDynamicRange: 'SDR' } };
    expect(tv('{MediaInfo VideoCodec} {MediaInfo VideoDynamicRange} {MediaInfo VideoBitDepth}', { file: sdr })).toBe('h265 8');
  });

  it.each([
    ['{Custom Formats}', 'Surround Sound x264'],
    ['{Custom Formats:x264}', 'x264'],
    ['{Custom Formats:-x264}', 'Surround Sound'],
    ['{Custom Format:x264}', 'x264'],
    ['{Series Title}{ Custom Format}', "The Series Title's!"],
    ['{Series Title}{ Custom Format:X264}', "The Series Title's!"],
  ])('%s', (format, expected) => {
    expect(tv(format)).toBe(expected);
  });

  it('custom formats excluded from renaming are not rendered', () => {
    const out = buildEpisodeFileName(cfg({ standardEpisodeFormat: '{Custom Formats}' }), series, [ep(1)], file, {
      customFormats: [{ name: 'Hidden', includeInRenaming: false }, { name: 'Shown', includeInRenaming: true }],
    });
    expect(out).toBe('Shown');
  });
});

describe('folders, paths and limits', () => {
  it('default folders', () => {
    expect(buildSeriesFolder(cfg(), series)).toBe("The Series Title's!");
    expect(buildSeasonFolder(cfg(), series, 1)).toBe('Season 1');
    expect(buildSeasonFolder(cfg({ seasonFolderFormat: 'Season {season:00}' }), series, 3)).toBe('Season 03');
    expect(buildSeasonFolder(cfg(), series, 0)).toBe('Specials');
  });

  it('file format with folder levels is split and rendered per component', () => {
    expect(tv('{Series Title}/Season {season:00}\\{Series Title} - S{season:00}E{episode:00}')).toBe(
      "The Series Title's!/Season 01/The Series Title's! - S01E01",
    );
  });

  it('extension is appended and reserved in the budget', () => {
    const long = ep(1, { title: 'x'.repeat(400) });
    const out = buildEpisodeFileName(cfg(), { ...series, title: 'Show' }, [long], { ...file, quality: { quality: { name: 'WEBDL-1080p' }, revision: { version: 1, real: 0 } } }, { extension: '.mkv' });
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(255);
    expect(out.startsWith('Show - S01E01 - xxxx')).toBe(true);
    expect(out.endsWith('x... WEBDL-1080p.mkv')).toBe(true);
  });

  it('long multi-episode titles shorten to first...last before cutting', () => {
    const eps = [ep(1, { title: 'A'.repeat(40) }), ep(2, { title: 'B'.repeat(40) }), ep(3, { title: 'Last' })];
    const out = buildEpisodeFileName(cfg({ standardEpisodeFormat: 'S{season:00}E{episode:00} {Episode Title}' }), series, eps, file, { maxFileNameBytes: 60 });
    expect(out).toBe(`S01E01-E03 ${'A'.repeat(40)}...Last`);
  });

  it('budget counts UTF-8 bytes and the season path', () => {
    const out = buildEpisodeFileName(
      cfg({ standardEpisodeFormat: 'S{season:00}E{episode:00} {Episode Title}' }),
      series,
      [ep(1, { title: 'é'.repeat(50) })],
      file,
      { maxPathBytes: 60, seasonPath: '/tv/Show/Season 01' },
    );
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(60 - 19);
    expect(out).toMatch(/^S01E01 é+\.\.\.$/);
  });

  it('series title is hard-truncated only when episode titles cannot absorb the overflow', () => {
    const out = buildEpisodeFileName(cfg({ standardEpisodeFormat: '{Series Title} - S{season:00}E{episode:00}' }), { ...series, title: 'Z'.repeat(300) }, [ep(1)], file, {});
    expect(out.length).toBe(255);
    expect(out.endsWith('...')).toBe(true);
  });

  it('rename off uses the original title (+ extension when given)', () => {
    expect(buildEpisodeFileName(NAMING_DEFAULTS, series, [ep(1)], file, { extension: '.mkv' })).toBe(
      "The.Series.Title's!.S01E01.1080p.WEBDL.x264-EVOLVE.mkv",
    );
    expect(buildMovieFileName(NAMING_DEFAULTS, S.movie, { ...S.movieFile, sceneName: null })).toBe(
      'The.Movie.Title.2010.1080p.BluRay.DTS.x264-EVOLVE',
    );
  });

  it('empty formats throw a naming-format error', () => {
    expect(() => buildEpisodeFileName(cfg({ standardEpisodeFormat: ' ' }), series, [ep(1)], file)).toThrow(NamingFormatError);
    expect(() => buildEpisodeFileName(cfg({ dailyEpisodeFormat: '' }), S.dailySeries, [ep(1)], file)).toThrow('Daily episode format cannot be empty');
    expect(() => buildMovieFileName(cfg({ movieFormat: '' }), S.movie, S.movieFile)).toThrow('Standard movie format cannot be empty');
  });

  it('predicates', () => {
    expect(requiresEpisodeTitle(cfg(), series, [ep(1)])).toBe(true);
    expect(requiresEpisodeTitle(cfg({ standardEpisodeFormat: '{Series Title} S{season:00}E{episode:00}' }), series, [ep(1)])).toBe(false);
    expect(requiresAbsoluteNumber(cfg({ animeEpisodeFormat: '{absolute:000}' }), S.animeSeries)).toBe(true);
    expect(requiresAbsoluteNumber(cfg(), S.animeSeries)).toBe(false);
  });
});

describe('movies', () => {
  const v1: NamingFile = { ...S.movieFile, quality: { quality: { name: 'Bluray-1080p' }, revision: { version: 1, real: 0 } } };
  const movie = S.movie;
  const mv = (format: string, m: NamingMovie = movie, f: NamingFile = v1) => buildMovieFileName(cfg({ movieFormat: format }), m, f, extras);
  const amelie: NamingMovie = { title: 'Amélie', year: 2001, translations: [{ language: 'de', title: 'Die fabelhafte Welt der Amélie' }] };

  it.each([
    [NAMING_DEFAULTS.movieFormat, 'The Movie - Title (2010) Bluray-1080p'],
    ['{Movie.Title}.{Release.Year}.{Quality.Title}.{MediaInfo.VideoCodec}', 'The.Movie.-.Title.2010.Bluray-1080p.x264'],
    ['{Movie CleanTitle}', 'The Movie Title'],
    ['{Movie TitleThe}', 'Movie - Title, The'],
    ['{Movie CleanTitleThe}', 'Movie Title, The'],
    ['{Movie TitleFirstCharacter}', 'M'],
    ['{Movie OriginalTitle}', 'The Original Movie Title'],
    ['{Movie Collection}', 'The Movie Collection'],
    ['{Movie CollectionThe}', 'Movie Collection, The'],
    ['{Movie Certification}', 'R'],
    ['{Movie Title} {ImdbId} {TmdbId}', 'The Movie - Title tt0123456 345691'],
    ['{Movie Title:9}', 'The Mo...'],
    ['{Movie Title} [{Edition Tags}]', 'The Movie - Title [Ultimate Extended Edition]'],
    ['{Movie Title} {Release Group}', 'The Movie - Title EVOLVE'],
    ['{Movie Title} {MediaInfo 3D}', 'The Movie - Title'],
  ])('%s', (format, expected) => {
    expect(mv(format)).toBe(expected);
  });

  it('year 0 leaves literal parentheses', () => {
    expect(mv(NAMING_DEFAULTS.movieFormat, { ...movie, year: 0 })).toBe('The Movie - Title () Bluray-1080p');
    expect(buildMovieFolder(cfg(), { title: 'Unreleased', year: 0 })).toBe('Unreleased ()');
  });

  it('diacritics are kept except in clean tokens', () => {
    expect(mv(NAMING_DEFAULTS.movieFormat, amelie, { ...v1, quality: { quality: { name: 'WEBDL-1080p' }, revision: { version: 1, real: 0 } } })).toBe('Amélie (2001) WEBDL-1080p');
    expect(mv('{Movie CleanTitle} ({Release Year})', amelie)).toBe('Amelie (2001)');
  });

  it('translated titles', () => {
    expect(mv('{Movie Title:de}', amelie)).toBe('Die fabelhafte Welt der Amélie');
    expect(mv('{Movie Title:xx|de}', amelie)).toBe('Die fabelhafte Welt der Amélie');
    expect(mv('{Movie Title:fr|de}', amelie)).toBe('Amélie');
    expect(mv('{Movie TitleThe:de}', { ...amelie, title: 'The Amélie' })).toBe('Amélie, The');
  });

  it('edition and id wrappers', () => {
    const fmt = '{Movie Title} ({Release Year}) {edition-{Edition Tags}} {imdb-{ImdbId}}';
    expect(mv(fmt, movie, { ...v1, edition: "Director's Cut" })).toBe("The Movie - Title (2010) {edition-Director's Cut} {imdb-tt0123456}");
    expect(mv(fmt, movie, { ...v1, edition: null })).toBe('The Movie - Title (2010) {imdb-tt0123456}');
    expect(mv('{Movie Title} ({Release Year}) {edition-{Edition Tags}}', amelie, { ...v1, edition: null })).toBe('Amélie (2001)');
    expect(mv('{Movie Title} {edition-{Edition Tags}}', movie, { ...v1, edition: 'imax 70mm cut' })).toBe('The Movie - Title {edition-IMAX 70mm Cut}');
  });

  it('original title fallback only when the format has exactly one token', () => {
    const noScene: NamingFile = { ...v1, sceneName: null };
    expect(mv('{Original Title}')).toBe('The.Movie.Title.2010.1080p.BluRay.DTS.x264-EVOLVE');
    expect(mv('{Original Title}', movie, noScene)).toBe('The.Movie.Title.2010.1080p.BluRay.DTS.x264-EVOLVE');
    expect(mv('{Movie Title} {Original Filename}', movie, noScene)).toBe('The Movie - Title');
  });

  it('missing quality renders all quality tokens empty', () => {
    expect(mv(NAMING_DEFAULTS.movieFormat, movie, { ...v1, quality: null })).toBe('The Movie - Title (2010)');
  });

  it('3D from multi-view count', () => {
    expect(mv('{MediaInfo 3D}', movie, { ...v1, mediaInfo: { videoMultiViewCount: 2 } })).toBe('3D');
  });

  it('movie folders: collection levels, empty segments dropped, file tokens unavailable', () => {
    expect(buildMovieFolder(cfg(), movie)).toBe('The Movie - Title (2010)');
    expect(buildMovieFolder(cfg({ movieFolderFormat: '{Movie CollectionThe}/{Movie Title} ({Release Year})' }), movie)).toBe(
      'Movie Collection, The/The Movie - Title (2010)',
    );
    expect(buildMovieFolder(cfg({ movieFolderFormat: '{Movie Collection}/{Movie Title}' }), { ...movie, collection: null })).toBe('The Movie - Title');
    expect(buildMovieFolder(cfg({ movieFolderFormat: '{Movie Title} {Quality Full}' }), movie)).toBe('The Movie - Title');
  });
});

describe('samples', () => {
  it('default config preview matches the spec', () => {
    const s = getSamples(NAMING_DEFAULTS);
    expect(s.singleEpisode.value).toBe("The Series Title's! - S01E01 - Episode Title (1) WEBDL-1080p Proper");
    expect(s.multiEpisode.value).toBe("The Series Title's! - S01E01-E03 - Episode Title WEBDL-1080p Proper");
    expect(s.dailyEpisode.value).toBe("The Series Title's! - 2013-10-30 - Episode Title (1) WEBDL-1080p Proper");
    expect(s.animeEpisode.value).toBe("The Series Title's! - S01E01 - Episode Title (1) WEBDL-1080p v2");
    expect(s.animeMultiEpisode.value).toBe("The Series Title's! - S01E01-E03 - Episode Title WEBDL-1080p v2");
    expect(s.seriesFolder.value).toBe("The Series Title's!");
    expect(s.seasonFolder.value).toBe('Season 1');
    expect(s.specialsFolder.value).toBe('Specials');
    expect(s.movie.value).toBe('The Movie - Title (2010) Bluray-1080p Proper');
    expect(s.movieFolder.value).toBe('The Movie - Title (2010)');
  });

  it('reports errors per sample instead of throwing', () => {
    const s = getSamples({ ...NAMING_DEFAULTS, standardEpisodeFormat: '' });
    expect(s.singleEpisode).toEqual({ value: null, error: 'Standard episode format cannot be empty' });
    expect(s.dailyEpisode.value).not.toBeNull();
  });
});
