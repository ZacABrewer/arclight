import { describe, expect, it } from 'vitest';
import type { EpisodeMetadata, MovieMetadata, SeriesMetadata } from '@arclight/metadata';
import {
  toEpisodeMetadataInput,
  toMediaImages,
  toMovieMetadataInput,
  toMovieStatus,
  toSeriesMetadataInput,
  toSeriesStatus,
  toYear,
} from './map.js';

const series: SeriesMetadata = {
  tmdbId: 1399,
  tvdbId: 121361,
  imdbId: 'tt0944947',
  title: 'Game of Thrones',
  originalTitle: 'Game of Thrones',
  sortTitle: 'game of thrones',
  year: 2011,
  overview: 'Seven noble families fight for control.',
  status: 'ended',
  network: 'HBO',
  runtimeMinutes: 60,
  genres: ['Drama', 'Fantasy'],
  firstAired: '2011-04-17',
  lastAired: '2019-05-19',
  images: { poster: 'https://img/p.jpg', backdrop: 'https://img/b.jpg' },
  ratings: { tmdb: { value: 8.4, votes: 22000 } },
  certification: 'TV-MA',
  originalLanguage: 'en',
  seasons: [
    { seasonNumber: 0, episodeCount: 1 },
    { seasonNumber: 1, episodeCount: 2, name: 'Season 1' },
  ],
  alternateTitles: [{ title: 'GoT', country: 'US' }],
};

const episode: EpisodeMetadata = {
  tmdbId: 63056,
  seasonNumber: 1,
  episodeNumber: 1,
  title: 'Winter Is Coming',
  overview: '',
  airDate: '2011-04-17',
  runtimeMinutes: 62,
  still: 'https://img/s.jpg',
  ratings: { tmdb: { value: 7.9, votes: 300 } },
};

const movie: MovieMetadata = {
  tmdbId: 603,
  imdbId: 'tt0133093',
  title: 'The Matrix',
  originalTitle: 'The Matrix',
  sortTitle: 'matrix',
  year: 1999,
  overview: 'A hacker learns the truth.',
  status: 'released',
  inCinemas: '1999-03-31',
  digitalRelease: '1999-09-21',
  runtimeMinutes: 136,
  genres: ['Action', 'Science Fiction'],
  studio: 'Warner Bros.',
  images: { poster: 'https://img/m.jpg', logo: 'https://img/l.png' },
  ratings: { tmdb: { value: 8.2, votes: 25000.4 } },
  certification: 'R',
  originalLanguage: 'en',
  collection: { tmdbId: 2344, name: 'The Matrix Collection' },
  alternateTitles: [],
  youtubeTrailerId: 'abc',
};

describe('status mapping', () => {
  it('maps series statuses', () => {
    expect(toSeriesStatus('continuing', undefined)).toBe('continuing');
    expect(toSeriesStatus('ended', '2010-01-01')).toBe('ended');
    expect(toSeriesStatus('upcoming', undefined)).toBe('upcoming');
    expect(toSeriesStatus('unknown', '2010-01-01')).toBe('continuing');
    expect(toSeriesStatus('unknown', undefined)).toBe('upcoming');
  });

  it('maps movie statuses', () => {
    expect(toMovieStatus('announced')).toBe('announced');
    expect(toMovieStatus('inCinemas')).toBe('inCinemas');
    expect(toMovieStatus('released')).toBe('released');
    expect(toMovieStatus('unknown')).toBe('tba');
  });
});

describe('helpers', () => {
  it('derives the year', () => {
    expect(toYear(2011, '2010-01-01')).toBe(2011);
    expect(toYear(undefined, '2010-05-01')).toBe(2010);
    expect(toYear(undefined, undefined)).toBe(0);
    expect(toYear(0, 'garbage')).toBe(0);
  });

  it('turns an image set into library images', () => {
    expect(toMediaImages({})).toEqual([]);
    expect(toMediaImages({ poster: 'p', backdrop: 'b', logo: 'l' })).toEqual([
      { coverType: 'poster', url: 'p', remoteUrl: 'p' },
      { coverType: 'fanart', url: 'b', remoteUrl: 'b' },
      { coverType: 'clearlogo', url: 'l', remoteUrl: 'l' },
    ]);
  });
});

describe('toEpisodeMetadataInput', () => {
  it('maps every field and nulls empty text', () => {
    expect(toEpisodeMetadataInput(episode)).toEqual({
      tmdbId: 63056,
      seasonNumber: 1,
      episodeNumber: 1,
      absoluteEpisodeNumber: null,
      title: 'Winter Is Coming',
      overview: null,
      airDate: '2011-04-17',
      airDateUtc: null,
      runtimeMinutes: 62,
    });
  });
});

describe('toSeriesMetadataInput', () => {
  it('maps a full series with episodes', () => {
    expect(toSeriesMetadataInput(series, [episode])).toEqual({
      tmdbId: 1399,
      tvdbId: 121361,
      imdbId: 'tt0944947',
      title: 'Game of Thrones',
      year: 2011,
      overview: 'Seven noble families fight for control.',
      status: 'ended',
      network: 'HBO',
      runtimeMinutes: 60,
      genres: ['Drama', 'Fantasy'],
      images: [
        { coverType: 'poster', url: 'https://img/p.jpg', remoteUrl: 'https://img/p.jpg' },
        { coverType: 'fanart', url: 'https://img/b.jpg', remoteUrl: 'https://img/b.jpg' },
      ],
      ratings: { tmdb: { value: 8.4, votes: 22000 } },
      certification: 'TV-MA',
      originalLanguage: 'en',
      seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }],
      episodes: [toEpisodeMetadataInput(episode)],
    });
  });

  it('fills gaps in a sparse series', () => {
    const sparse: SeriesMetadata = {
      tmdbId: 5,
      title: 'Untitled Project',
      originalTitle: '',
      sortTitle: 'untitled project',
      overview: '',
      status: 'unknown',
      genres: [],
      images: {},
      ratings: { tmdb: { value: 0, votes: 0 } },
      originalLanguage: '',
      seasons: [],
      alternateTitles: [],
    };
    const out = toSeriesMetadataInput(sparse, []);
    expect(out).toMatchObject({
      tvdbId: null,
      imdbId: null,
      year: 0,
      overview: null,
      status: 'upcoming',
      network: null,
      runtimeMinutes: null,
      images: [],
      certification: null,
      originalLanguage: null,
      seasons: [],
      episodes: [],
    });
  });
});

describe('toMovieMetadataInput', () => {
  it('maps a full movie', () => {
    expect(toMovieMetadataInput(movie)).toEqual({
      tmdbId: 603,
      imdbId: 'tt0133093',
      title: 'The Matrix',
      originalTitle: 'The Matrix',
      year: 1999,
      overview: 'A hacker learns the truth.',
      status: 'released',
      inCinemas: '1999-03-31',
      digitalRelease: '1999-09-21',
      physicalRelease: null,
      runtimeMinutes: 136,
      studio: 'Warner Bros.',
      genres: ['Action', 'Science Fiction'],
      images: [
        { coverType: 'poster', url: 'https://img/m.jpg', remoteUrl: 'https://img/m.jpg' },
        { coverType: 'clearlogo', url: 'https://img/l.png', remoteUrl: 'https://img/l.png' },
      ],
      ratings: { tmdb: { value: 8.2, votes: 25000 } },
      certification: 'R',
      originalLanguage: 'en',
      collection: { tmdbId: 2344, title: 'The Matrix Collection' },
    });
  });

  it('takes the year from the earliest known release when missing', () => {
    const { year: _y, inCinemas: _c, ...rest } = movie;
    const out = toMovieMetadataInput({ ...rest, status: 'unknown', digitalRelease: '2001-02-03' });
    expect(out.year).toBe(2001);
    expect(out.status).toBe('tba');
    expect(out.inCinemas).toBeNull();
  });
});
