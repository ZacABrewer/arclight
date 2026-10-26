// Fake fetch for client tests: routes URL paths to JSON fixtures or scripted responses.
// Lives in src so it is typechecked, but is not exported from index.ts.

import type { FetchLike } from './tmdb/client.js';

import configuration from '../fixtures/tmdb/configuration.json' with { type: 'json' };
import findImdb from '../fixtures/tmdb/find-imdb.json' with { type: 'json' };
import genresMovie from '../fixtures/tmdb/genres-movie.json' with { type: 'json' };
import movieDetails from '../fixtures/tmdb/movie-details.json' with { type: 'json' };
import movieDetailsUpcoming from '../fixtures/tmdb/movie-details-upcoming.json' with { type: 'json' };
import searchMovie from '../fixtures/tmdb/search-movie.json' with { type: 'json' };
import searchMulti from '../fixtures/tmdb/search-multi.json' with { type: 'json' };
import searchTv from '../fixtures/tmdb/search-tv.json' with { type: 'json' };
import tvDetails from '../fixtures/tmdb/tv-details.json' with { type: 'json' };
import tvSeason from '../fixtures/tmdb/tv-season.json' with { type: 'json' };

export const fixtures = {
  configuration,
  findImdb,
  genresMovie,
  movieDetails,
  movieDetailsUpcoming,
  searchMovie,
  searchMulti,
  searchTv,
  tvDetails,
  tvSeason,
};

export type Responder = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface FakeFetch {
  fetch: FetchLike;
  /** Every request made, in order. */
  calls: { url: URL; init: RequestInit | undefined }[];
  /** Paths requested, e.g. "/3/search/tv". */
  paths(): string[];
}

/**
 * Builds a fetch whose behaviour is decided by `route(url)`. The default route serves the
 * standard fixtures by path so most tests only override what they care about.
 */
export function createFakeFetch(route: Responder = defaultRoute): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    return route(url, init);
  };
  return { fetch, calls, paths: () => calls.map((c) => c.url.pathname) };
}

export function defaultRoute(url: URL): Response {
  const path = url.pathname.replace(/^\/3/, '');
  switch (true) {
    case path === '/configuration':
      return jsonResponse(configuration);
    case path === '/search/tv':
      return jsonResponse(searchTv);
    case path === '/search/movie':
      return jsonResponse(searchMovie);
    case path === '/search/multi':
      return jsonResponse(searchMulti);
    case path.startsWith('/find/'):
      return jsonResponse(findImdb);
    case path === '/tv/90210':
      return jsonResponse(tvDetails);
    case path === '/tv/90210/season/1':
      return jsonResponse(tvSeason);
    case path === '/movie/55500':
      return jsonResponse(movieDetails);
    case path === '/movie/66600':
      return jsonResponse(movieDetailsUpcoming);
    case path === '/genre/movie/list':
      return jsonResponse(genresMovie);
    case path.startsWith('/trending/'):
      return jsonResponse(searchMulti);
    case path === '/discover/movie':
      return jsonResponse(searchMovie);
    case path === '/discover/tv':
      return jsonResponse(searchTv);
    default:
      return jsonResponse({ status_code: 34, status_message: 'The resource you requested could not be found.' }, 404);
  }
}
