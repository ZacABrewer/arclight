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
};
export { BrowsePlayerContext, usePlayerActions, type BrowsePlayerActions, type PlayItemsOptions } from './player-hooks.js';
export { playerBrowseApi, browseKeys } from './api.js';
export { playerPaths } from './kit.js';
