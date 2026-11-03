// Concrete Movies & TV paths under /player (the router registers the matching patterns through
// browse/index.ts browseRoutes, in the web portal and in the Arclight app alike).

export const watchPaths = {
  home: '/player/watch',
  movies: '/player/watch/movies',
  movie: (id: number) => `/player/watch/movies/${id}`,
  shows: '/player/watch/shows',
  show: (id: number) => `/player/watch/shows/${id}`,
  /** Full-screen player. The key's ":" is kept readable ("movie:12"). */
  play: (itemKey: string) => `/player/watch/play/${itemKey}`,
  /** "Sign in a TV" (device code approval). */
  link: '/player/link',
};
