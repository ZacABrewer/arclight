import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// Browse pages of the /player portal (music and audiobooks). Each page is its own lazy chunk;
// the player core wires `browseRoutes` into router.tsx under its /player layout, wrapping each
// component in <Suspense>. Paths use TanStack Router's `$param` syntax; pages read the params
// by these names.

export interface BrowseRoute {
  /** Full path under the site root. */
  path: string;
  component: LazyExoticComponent<ComponentType>;
}

const MusicHomePage = lazy(() => import('./music-home.js').then((m) => ({ default: m.MusicHomePage })));
const AlbumsPage = lazy(() => import('./library.js').then((m) => ({ default: m.AlbumsPage })));
const ArtistsPage = lazy(() => import('./library.js').then((m) => ({ default: m.ArtistsPage })));
const AlbumPage = lazy(() => import('./album-page.js').then((m) => ({ default: m.AlbumPage })));
const ArtistPage = lazy(() => import('./artist-page.js').then((m) => ({ default: m.ArtistPage })));
const PlaylistsPage = lazy(() => import('./playlists.js').then((m) => ({ default: m.PlaylistsPage })));
const PlaylistPage = lazy(() => import('./playlists.js').then((m) => ({ default: m.PlaylistPage })));
const BooksHomePage = lazy(() => import('./books.js').then((m) => ({ default: m.BooksHomePage })));
const BookPage = lazy(() => import('./book-page.js').then((m) => ({ default: m.BookPage })));
const PlayerSearchPage = lazy(() => import('./search-page.js').then((m) => ({ default: m.PlayerSearchPage })));
// Movies & TV (../video).
const WatchHomePage = lazy(() => import('../video/watch-home.js').then((m) => ({ default: m.WatchHomePage })));
const MoviesPage = lazy(() => import('../video/library.js').then((m) => ({ default: m.MoviesPage })));
const MovieDetailsPage = lazy(() => import('../video/movie-page.js').then((m) => ({ default: m.MovieDetailsPage })));
const ShowsPage = lazy(() => import('../video/library.js').then((m) => ({ default: m.ShowsPage })));
const ShowDetailsPage = lazy(() => import('../video/show-page.js').then((m) => ({ default: m.ShowDetailsPage })));
const VideoPlayerPage = lazy(() => import('../video/player-page.js').then((m) => ({ default: m.VideoPlayerPage })));
const SignInTvPage = lazy(() => import('../video/link-page.js').then((m) => ({ default: m.SignInTvPage })));

export const browseRoutes: readonly BrowseRoute[] = [
  { path: '/player/music', component: MusicHomePage },
  { path: '/player/music/albums', component: AlbumsPage },
  { path: '/player/music/artists', component: ArtistsPage },
  { path: '/player/music/album/$albumId', component: AlbumPage },
  { path: '/player/music/artist/$artistId', component: ArtistPage },
  { path: '/player/music/playlists', component: PlaylistsPage },
  { path: '/player/music/playlist/$playlistId', component: PlaylistPage },
  { path: '/player/books', component: BooksHomePage },
  { path: '/player/books/$bookId', component: BookPage },
  { path: '/player/search', component: PlayerSearchPage },
  { path: '/player/watch', component: WatchHomePage },
  { path: '/player/watch/movies', component: MoviesPage },
  { path: '/player/watch/movies/$id', component: MovieDetailsPage },
  { path: '/player/watch/shows', component: ShowsPage },
  { path: '/player/watch/shows/$id', component: ShowDetailsPage },
  { path: '/player/watch/play/$itemKey', component: VideoPlayerPage },
  { path: '/player/link', component: SignInTvPage },
];

export {
  MusicHomePage,
  AlbumsPage,
  ArtistsPage,
  AlbumPage,
  ArtistPage,
  PlaylistsPage,
  PlaylistPage,
  BooksHomePage,
  BookPage,
  PlayerSearchPage,
  WatchHomePage,
  MoviesPage,
  MovieDetailsPage,
  ShowsPage,
  ShowDetailsPage,
  VideoPlayerPage,
  SignInTvPage,
};
export { BrowsePlayerContext, usePlayerActions, type BrowsePlayerActions, type PlayItemsOptions } from './player-hooks.js';
export { playerBrowseApi, browseKeys } from './api.js';
export { playerPaths } from './kit.js';
export { watchPaths } from '../video/paths.js';
export { openVideo, setVideoLauncher, getVideoLauncher, defaultVideoLauncher, playHref, useOpenVideo, type OpenVideoOptions, type PlaySearch, type VideoLauncher } from '../video/video-launcher.js';
