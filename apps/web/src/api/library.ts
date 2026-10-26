import {
  LibraryStatistics,
  Movie,
  RootFolder,
  Series,
  Tag,
  WantedEpisodesPage,
  WantedMoviesPage,
  type AddMovieRequest,
  type AddRootFolderRequest,
  type AddSeriesRequest,
  type MovieListQuery,
  type PageQuery,
  type SeriesListQuery,
  type UpdateMovieRequest,
  type UpdateSeriesRequest,
} from '@media-tron/shared';
import { request, type QueryParams } from './client.js';

// The library contract exists in @media-tron/shared, but apps/api has no library routes yet.
// TODO(contract): confirm these paths against apps/api/src/modules/library/routes.ts once it lands.

const q = (v: object | undefined): QueryParams | undefined => v as QueryParams | undefined;

export const libraryApi = {
  series: {
    list: (query?: Partial<SeriesListQuery>) => request('/series', Series.array(), { query: q(query) }),
    get: (id: number) => request(`/series/${id}`, Series),
    add: (body: AddSeriesRequest) => request('/series', Series, { method: 'POST', json: body }),
    update: (id: number, body: UpdateSeriesRequest) => request(`/series/${id}`, Series, { method: 'PUT', json: body }),
    remove: (id: number, deleteFiles = false) =>
      request(`/series/${id}`, null, { method: 'DELETE', query: { deleteFiles } }),
  },
  movies: {
    list: (query?: Partial<MovieListQuery>) => request('/movie', Movie.array(), { query: q(query) }),
    get: (id: number) => request(`/movie/${id}`, Movie),
    add: (body: AddMovieRequest) => request('/movie', Movie, { method: 'POST', json: body }),
    update: (id: number, body: UpdateMovieRequest) => request(`/movie/${id}`, Movie, { method: 'PUT', json: body }),
    remove: (id: number, deleteFiles = false) =>
      request(`/movie/${id}`, null, { method: 'DELETE', query: { deleteFiles } }),
  },
  rootFolders: {
    list: () => request('/rootfolder', RootFolder.array()),
    add: (body: AddRootFolderRequest) => request('/rootfolder', RootFolder, { method: 'POST', json: body }),
    remove: (id: number) => request(`/rootfolder/${id}`, null, { method: 'DELETE' }),
  },
  tags: {
    list: () => request('/tag', Tag.array()),
  },
  wanted: {
    missingEpisodes: (query?: Partial<PageQuery>) =>
      request('/wanted/missing/episodes', WantedEpisodesPage, { query: q(query) }),
    missingMovies: (query?: Partial<PageQuery>) => request('/wanted/missing/movies', WantedMoviesPage, { query: q(query) }),
    cutoffEpisodes: (query?: Partial<PageQuery>) =>
      request('/wanted/cutoff/episodes', WantedEpisodesPage, { query: q(query) }),
    cutoffMovies: (query?: Partial<PageQuery>) => request('/wanted/cutoff/movies', WantedMoviesPage, { query: q(query) }),
  },
  statistics: () => request('/library/statistics', LibraryStatistics),
};
