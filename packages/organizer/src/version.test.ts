import { describe, expect, it } from 'vitest';
import { NAMING_DEFAULTS, type NamingConfig } from '@arclight/shared';
import { buildEpisodeFileName, buildMovieFileName } from './build.js';
import { hasVersionToken } from './tokens.js';
import type { NamingFile, NamingMovie, NamingSeries } from './types.js';

// {Version}: the multi-version library slot of a file (4K, HDR, Remux).

const cfg = (o: Partial<NamingConfig> = {}): NamingConfig => ({ ...NAMING_DEFAULTS, renameEpisodes: true, renameMovies: true, ...o });
const movie: NamingMovie = { title: 'The Movie', year: 2010 };
const series: NamingSeries = { title: 'The Show', year: 2010, seriesType: 'standard' };
const file = (versionTag?: string | null): NamingFile => ({ id: 0, relativePath: 'x.mkv', ...(versionTag !== undefined ? { versionTag } : {}) });

describe('{Version} token', () => {
  it('renders the tag in a movie format, with prefix/suffix', () => {
    const c = cfg({ movieFormat: '{Movie Title} ({Release Year}) {[Version]}' });
    expect(buildMovieFileName(c, movie, file('4K'))).toBe('The Movie (2010) [4K]');
    expect(buildMovieFileName(cfg({ movieFormat: '{Movie Title} - {Version}' }), movie, file('HDR'))).toBe('The Movie - HDR');
  });

  it('drops the token and its brackets when the file is unversioned', () => {
    const c = cfg({ movieFormat: '{Movie Title} ({Release Year}) {[Version]}' });
    expect(buildMovieFileName(c, movie, file(null))).toBe('The Movie (2010)');
    expect(buildMovieFileName(c, movie, file())).toBe('The Movie (2010)');
  });

  it('works in episode formats and honours case', () => {
    const c = cfg({ standardEpisodeFormat: '{Series Title} - S{season:00}E{episode:00} {version}' });
    const name = buildEpisodeFileName(c, series, [{ seasonNumber: 1, episodeNumber: 2, title: 'Pilot' }], file('Remux'));
    expect(name).toBe('The Show - S01E02 remux');
  });

  it('detects the token in a format', () => {
    expect(hasVersionToken('{Movie Title} {[Version]}')).toBe(true);
    expect(hasVersionToken('{Movie Title} {edition-{Edition Tags}}')).toBe(false);
  });
});
