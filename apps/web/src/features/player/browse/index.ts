import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// Browse pages of the /player portal (music, audiobooks, and the Movies & TV redesign). Each page is its own lazy chunk;
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
// The redesign (../redesign/pages): what the Movies & TV routes show from 0.23.0.
const RdHomePage = lazy(() => import('../redesign/pages/home.js').then((m) => ({ default: m.RdHomePage })));
const RdMoviesPage = lazy(() => import('../redesign/pages/browse.js').then((m) => ({ default: m.RdMoviesPage })));
const RdShowsPage = lazy(() => import('../redesign/pages/browse.js').then((m) => ({ default: m.RdShowsPage })));
const RdMyListPage = lazy(() => import('../redesign/pages/browse.js').then((m) => ({ default: m.RdMyListPage })));
const RdMoviePage = lazy(() => import('../redesign/pages/detail.js').then((m) => ({ default: m.RdMoviePage })));
const RdShowPage = lazy(() => import('../redesign/pages/detail.js').then((m) => ({ default: m.RdShowPage })));
const RdSearchPage = lazy(() => import('../redesign/pages/search.js').then((m) => ({ default: m.RdSearchPage })));
const RdSettingsPage = lazy(() => import('../redesign/pages/settings.js').then((m) => ({ default: m.RdSettingsPage })));
const RdProfilesPage = lazy(() => import('../redesign/pages/profiles.js').then((m) => ({ default: m.RdProfilesPage })));

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
  { path: '/player/watch', component: RdHomePage },
  { path: '/player/watch/movies', component: RdMoviesPage },
  { path: '/player/watch/movies/$id', component: RdMoviePage },
  { path: '/player/watch/shows', component: RdShowsPage },
  { path: '/player/watch/shows/$id', component: RdShowPage },
  { path: '/player/watch/my-list', component: RdMyListPage },
  { path: '/player/watch/search', component: RdSearchPage },
  { path: '/player/watch/play/$itemKey', component: VideoPlayerPage },
  { path: '/player/link', component: SignInTvPage },
];
// Settings and Who's watching are exported below, not routed here: each shell mounts them its own
// way (the app adds its device rows to Settings and has its own picker gate).

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
  RdHomePage,
  RdMoviesPage,
  RdShowsPage,
  RdMyListPage,
  RdMoviePage,
  RdShowPage,
  RdSearchPage,
  RdSettingsPage,
  RdProfilesPage,
};
export { BrowsePlayerContext, usePlayerActions, type BrowsePlayerActions, type PlayItemsOptions } from './player-hooks.js';
export { playerBrowseApi, browseKeys } from './api.js';
export { playerPaths } from './kit.js';
export { watchPaths } from '../video/paths.js';
export { openVideo, setVideoLauncher, getVideoLauncher, defaultVideoLauncher, playHref, useOpenVideo, type OpenVideoOptions, type PlaySearch, type VideoLauncher } from '../video/video-launcher.js';
