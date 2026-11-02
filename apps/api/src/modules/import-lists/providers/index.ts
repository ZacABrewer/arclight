import { anilist, kitsu, myAnimeList } from './anime.js';
import { customUrl, rssList, stevenLu } from './feed.js';
import { imdbList, imdbTop } from './imdb.js';
import { jellyfinFavorites } from './jellyfin.js';
import { letterboxd } from './letterboxd.js';
import { mdblist } from './mdblist.js';
import { plexWatchlist } from './plex.js';
import { simkl } from './simkl.js';
import { tmdbCollection, tmdbCompany, tmdbDiscover, tmdbKeyword, tmdbList, tmdbNetwork, tmdbPerson, tmdbPopular } from './tmdb.js';
import { traktList, traktLists, traktPopular, traktUser } from './trakt.js';
import type { ProviderRegistry } from './types.js';

export const providers: ProviderRegistry = {
  tmdbList,
  tmdbPopular,
  tmdbCollection,
  tmdbPerson,
  tmdbKeyword,
  tmdbCompany,
  tmdbNetwork,
  tmdbDiscover,
  trakt: traktList,
  traktPopular,
  traktUser,
  traktLists,
  plexWatchlist,
  imdbList,
  imdbTop,
  rss: rssList,
  stevenLu,
  customUrl,
  letterboxd,
  mdblist,
  anilist,
  myAnimeList,
  kitsu,
  simkl,
  jellyfinFavorites,
};

export * from './types.js';
export { createTmdbAccess, withTmdbErrors } from './tmdb.js';
export { traktDeviceCode, traktPollToken, type TraktPollOutcome, type TraktTokens } from './trakt.js';
export { simklPin, simklPollPin, type SimklPollOutcome } from './simkl.js';
export { parseCsv, parseImdbExport } from './imdb.js';
export { parseFeed } from './feed.js';
export { createDatasetCache } from './datasets.js';
