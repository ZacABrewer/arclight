import { watchPaths } from '../video/paths.js';

// Paths of the redesigned /player pages (redesign spec §4.4-§4.6). Home is /player itself; the
// Movies & TV pages keep their /player/watch addresses, so old links still work.

export const redesignPaths = {
  home: '/player',
  shows: watchPaths.shows,
  movies: watchPaths.movies,
  myList: watchPaths.myList,
  search: watchPaths.search,
  settings: '/player/settings',
  profiles: '/player/profiles',
} as const;
