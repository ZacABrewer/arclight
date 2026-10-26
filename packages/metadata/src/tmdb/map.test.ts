import { describe, expect, it } from 'vitest';
import { fixtures } from '../test-support.js';
import {
  createImageUrlBuilder,
  deriveMovieStatus,
  mapMovie,
  mapSeason,
  mapSeries,
  mapSeriesStatus,
  pickReleaseDates,
  toIsoDate,
  yearOf,
} from './map.js';
import {
  tmdbConfigurationSchema,
  tmdbMovieDetailsSchema,
  tmdbSeasonDetailsSchema,
  tmdbTvDetailsSchema,
} from './schemas.js';

const config = tmdbConfigurationSchema.parse(fixtures.configuration);
const images = createImageUrlBuilder(config);
const base = { images, language: 'en-US', region: 'US' };

describe('createImageUrlBuilder', () => {
  it('builds absolute URLs with the preferred size per kind', () => {
    expect(images('poster', '/x.jpg')).toBe('https://image.tmdb.org/t/p/w500/x.jpg');
    expect(images('backdrop', '/x.jpg')).toBe('https://image.tmdb.org/t/p/w1280/x.jpg');
    expect(images('still', '/x.jpg')).toBe('https://image.tmdb.org/t/p/w300/x.jpg');
    expect(images('logo', '/x.png')).toBe('https://image.tmdb.org/t/p/w500/x.png');
  });

  it('returns undefined for null or empty paths', () => {
    expect(images('poster', null)).toBeUndefined();
    expect(images('poster', undefined)).toBeUndefined();
    expect(images('poster', '')).toBeUndefined();
  });

  it('falls back to original when the preferred size is not offered', () => {
    const narrow = createImageUrlBuilder(
      tmdbConfigurationSchema.parse({
        images: { secure_base_url: 'https://cdn.example/t/p/', poster_sizes: ['w92', 'original'] },
      }),
    );
    expect(narrow('poster', '/p.jpg')).toBe('https://cdn.example/t/p/original/p.jpg');
  });
});

describe('date helpers', () => {
  it('reduces timestamps to dates and rejects junk', () => {
    expect(toIsoDate('2023-07-21T00:00:00.000Z')).toBe('2023-07-21');
    expect(toIsoDate('2023-07-21')).toBe('2023-07-21');
    expect(toIsoDate('')).toBeUndefined();
    expect(toIsoDate('soon')).toBeUndefined();
    expect(yearOf('2021-09-14')).toBe(2021);
    expect(yearOf(null)).toBeUndefined();
  });
});

describe('mapSeriesStatus', () => {
  it('maps TMDB status strings onto the domain enum', () => {
    expect(mapSeriesStatus('Returning Series')).toBe('continuing');
    expect(mapSeriesStatus('Ended')).toBe('ended');
    expect(mapSeriesStatus('Canceled')).toBe('ended');
    expect(mapSeriesStatus('In Production')).toBe('upcoming');
    expect(mapSeriesStatus('Planned')).toBe('upcoming');
    expect(mapSeriesStatus(null)).toBe('unknown');
    expect(mapSeriesStatus('Something New')).toBe('unknown');
  });
});

describe('mapSeries', () => {
  const series = mapSeries(tmdbTvDetailsSchema.parse(fixtures.tvDetails), base);

  it('maps identity, titles and ids', () => {
    expect(series.tmdbId).toBe(90210);
    expect(series.tvdbId).toBe(400123);
    expect(series.imdbId).toBe('tt9000001');
    expect(series.title).toBe('Signal Lost');
    expect(series.sortTitle).toBe('signal lost');
    expect(series.year).toBe(2021);
    expect(series.status).toBe('continuing');
    expect(series.network).toBe('HBO');
    expect(series.runtimeMinutes).toBe(52);
    expect(series.genres).toEqual(['Drama', 'Mystery']);
    expect(series.firstAired).toBe('2021-09-14');
    expect(series.lastAired).toBe('2024-11-05');
    expect(series.originalLanguage).toBe('en');
    expect(series.ratings).toEqual({ tmdb: { value: 8.1, votes: 1304 } });
  });

  it('picks the certification for the configured region', () => {
    expect(series.certification).toBe('TV-MA');
    const gb = mapSeries(tmdbTvDetailsSchema.parse(fixtures.tvDetails), { ...base, region: 'GB' });
    expect(gb.certification).toBe('15');
  });

  it('builds image URLs and prefers a logo in the request language', () => {
    expect(series.images).toEqual({
      poster: 'https://image.tmdb.org/t/p/w500/signal-poster.jpg',
      backdrop: 'https://image.tmdb.org/t/p/w1280/signal-backdrop.jpg',
      logo: 'https://image.tmdb.org/t/p/w500/signal-logo-en.png',
    });
  });

  it('maps seasons including specials and omits empty optional fields', () => {
    expect(series.seasons).toHaveLength(4);
    expect(series.seasons[0]).toEqual({ seasonNumber: 0, episodeCount: 2, name: 'Specials' });
    expect(series.seasons[1]).toEqual({
      seasonNumber: 1,
      episodeCount: 8,
      name: 'Season 1',
      overview: 'The transmission begins.',
      poster: 'https://image.tmdb.org/t/p/w500/signal-s1.jpg',
    });
    expect(series.seasons[3]).not.toHaveProperty('overview');
  });

  it('de-duplicates alternate titles', () => {
    expect(series.alternateTitles).toEqual([
      { title: 'Signal Verloren', country: 'DE' },
      { title: 'シグナル・ロスト', country: 'JP' },
    ]);
  });
});

describe('mapSeason', () => {
  const episodes = mapSeason(tmdbSeasonDetailsSchema.parse(fixtures.tvSeason), base);

  it('maps every episode with numbering, dates, runtime and still', () => {
    expect(episodes).toHaveLength(3);
    expect(episodes[0]).toEqual({
      tmdbId: 2100101,
      seasonNumber: 1,
      episodeNumber: 1,
      title: 'Frequency',
      overview: 'Mara hears the first voice.',
      airDate: '2021-09-14',
      runtimeMinutes: 55,
      still: 'https://image.tmdb.org/t/p/w300/signal-s1e1.jpg',
      ratings: { tmdb: { value: 7.9, votes: 88 } },
    });
  });

  it('tolerates null air dates, runtimes, stills and overviews', () => {
    expect(episodes[2]).toEqual({
      tmdbId: 2100103,
      seasonNumber: 1,
      episodeNumber: 3,
      title: '',
      overview: '',
      ratings: { tmdb: { value: 0, votes: 0 } },
    });
  });
});

describe('pickReleaseDates', () => {
  const results = tmdbMovieDetailsSchema.parse(fixtures.movieDetails).release_dates?.results;

  it('prefers the configured region for every type', () => {
    expect(pickReleaseDates(results, 'US')).toEqual({
      inCinemas: '2023-07-21',
      digitalRelease: '2023-09-15',
      physicalRelease: '2023-10-24',
    });
  });

  it('falls back to US and then to the earliest other country', () => {
    // GB has no digital release: US supplies it. FR only has theatrical.
    expect(pickReleaseDates(results, 'GB')).toEqual({
      inCinemas: '2023-07-21',
      digitalRelease: '2023-09-15',
      physicalRelease: '2023-10-30',
    });
    const frOnly = results?.filter((r) => r.iso_3166_1 === 'FR');
    expect(pickReleaseDates(frOnly, 'DE')).toEqual({ inCinemas: '2023-07-19' });
  });

  it('returns nothing for an empty calendar', () => {
    expect(pickReleaseDates(undefined, 'US')).toEqual({});
    expect(pickReleaseDates([], 'US')).toEqual({});
  });
});

describe('deriveMovieStatus', () => {
  const dates = { inCinemas: '2023-07-21', digitalRelease: '2023-09-15', physicalRelease: '2023-10-24' };

  it('is announced before the cinema date', () => {
    expect(deriveMovieStatus(dates, new Date('2023-01-01T00:00:00Z'))).toBe('announced');
  });

  it('is inCinemas between the cinema date and the home release', () => {
    expect(deriveMovieStatus(dates, new Date('2023-07-21T12:00:00Z'))).toBe('inCinemas');
    expect(deriveMovieStatus(dates, new Date('2023-09-14T00:00:00Z'))).toBe('inCinemas');
  });

  it('is released once a digital or physical date has passed', () => {
    expect(deriveMovieStatus(dates, new Date('2023-09-15T00:00:00Z'))).toBe('released');
    expect(deriveMovieStatus({ inCinemas: '2023-07-21', physicalRelease: '2023-10-24' }, new Date('2023-10-25T00:00:00Z'))).toBe('released');
  });

  it('assumes released 90 days after cinemas when no home release is known', () => {
    const cinemaOnly = { inCinemas: '2023-07-21' };
    expect(deriveMovieStatus(cinemaOnly, new Date('2023-10-01T00:00:00Z'))).toBe('inCinemas');
    expect(deriveMovieStatus(cinemaOnly, new Date('2023-10-20T00:00:00Z'))).toBe('released');
  });

  it('is unknown with no dates at all', () => {
    expect(deriveMovieStatus({}, new Date())).toBe('unknown');
  });
});

describe('mapMovie', () => {
  const now = new Date('2024-01-01T00:00:00Z');
  const movie = mapMovie(tmdbMovieDetailsSchema.parse(fixtures.movieDetails), { ...base, now });

  it('maps identity, release dates and derived status', () => {
    expect(movie.tmdbId).toBe(55500);
    expect(movie.imdbId).toBe('tt5550001');
    expect(movie.title).toBe('The Last Harbor');
    expect(movie.sortTitle).toBe('last harbor');
    expect(movie.year).toBe(2023);
    expect(movie.status).toBe('released');
    expect(movie.inCinemas).toBe('2023-07-21');
    expect(movie.digitalRelease).toBe('2023-09-15');
    expect(movie.physicalRelease).toBe('2023-10-24');
    expect(movie.runtimeMinutes).toBe(128);
    expect(movie.genres).toEqual(['Science Fiction', 'Thriller']);
    expect(movie.studio).toBe('Beacon Films');
    expect(movie.certification).toBe('PG-13');
    expect(movie.collection).toEqual({ tmdbId: 880001, name: 'The Last Harbor Collection' });
    expect(movie.alternateTitles).toEqual([
      { title: 'Le Dernier Port', country: 'FR' },
      { title: 'Last Harbor', country: 'US' },
    ]);
  });

  it('prefers the official YouTube trailer over teasers, fan cuts and other sites', () => {
    expect(movie.youtubeTrailerId).toBe('officialTrailer003');
  });

  it('reports inCinemas when the clock sits inside the theatrical window', () => {
    const inWindow = mapMovie(tmdbMovieDetailsSchema.parse(fixtures.movieDetails), {
      ...base,
      now: new Date('2023-08-01T00:00:00Z'),
    });
    expect(inWindow.status).toBe('inCinemas');
  });

  it('maps an unreleased movie as announced and drops empty optionals', () => {
    const upcoming = mapMovie(tmdbMovieDetailsSchema.parse(fixtures.movieDetailsUpcoming), {
      ...base,
      now,
    });
    expect(upcoming.status).toBe('announced');
    expect(upcoming.inCinemas).toBe('2031-03-14');
    expect(upcoming.year).toBe(2031);
    expect(upcoming).not.toHaveProperty('imdbId');
    expect(upcoming).not.toHaveProperty('runtimeMinutes');
    expect(upcoming).not.toHaveProperty('collection');
    expect(upcoming).not.toHaveProperty('studio');
    expect(upcoming).not.toHaveProperty('youtubeTrailerId');
    expect(upcoming.images).toEqual({ poster: 'https://image.tmdb.org/t/p/w500/paper-moon-poster.jpg' });
  });

  it('uses the top-level release_date when the release calendar is empty', () => {
    const raw = tmdbMovieDetailsSchema.parse({
      ...fixtures.movieDetails,
      release_dates: { results: [] },
    });
    const mapped = mapMovie(raw, { ...base, now });
    expect(mapped.inCinemas).toBe('2023-07-21');
    expect(mapped.status).toBe('released');
  });
});
