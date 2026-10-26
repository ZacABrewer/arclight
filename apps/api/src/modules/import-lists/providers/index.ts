import { rssList, stevenLu } from './feed.js';
import { imdbList } from './imdb.js';
import { plexWatchlist } from './plex.js';
import { tmdbCollection, tmdbKeyword, tmdbList, tmdbPerson, tmdbPopular } from './tmdb.js';
import { traktList, traktPopular, traktUser } from './trakt.js';
import type { ProviderRegistry } from './types.js';

export const providers: ProviderRegistry = {
  tmdbList,
  tmdbPopular,
  tmdbCollection,
  tmdbPerson,
  tmdbKeyword,
  trakt: traktList,
  traktPopular,
  traktUser,
  plexWatchlist,
  imdbList,
  rss: rssList,
  stevenLu,
};

export * from './types.js';
export { createTmdbAccess, withTmdbErrors } from './tmdb.js';
export { traktDeviceCode, traktPollToken, type TraktPollOutcome, type TraktTokens } from './trakt.js';
export { parseCsv, parseImdbExport } from './imdb.js';
export { parseFeed } from './feed.js';
