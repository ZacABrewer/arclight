import type { ImportListField, ImportListImplementation, ImportListMediaType, ImportListSchema } from '@arclight/shared';

// Form definitions served by GET /importlist/schema. Field names match the settings schemas
// in @arclight/shared (importListSettingsSchemas); the server validates with those.

const f = (
  name: string,
  label: string,
  type: ImportListField['type'],
  extra: Partial<Omit<ImportListField, 'name' | 'label' | 'type'>> = {},
): ImportListField => ({ name, label, type, required: false, secret: false, ...extra });

const tmdbFilters: ImportListField[] = [
  f('minVoteAverage', 'Minimum vote average', 'number', { min: 0, max: 10 }),
  f('minVotes', 'Minimum votes', 'number', { min: 0 }),
  f('yearFrom', 'Year from', 'number', { min: 1870 }),
  f('yearTo', 'Year to', 'number', { min: 1870 }),
  f('languages', 'Original languages', 'textList', { helpText: 'ISO-639-1 codes, e.g. en, ja', default: [] }),
  f('genreIds', 'Genres', 'numberList', { helpText: 'TMDB genre ids (any of)', default: [] }),
  f('limit', 'Limit', 'number', { min: 1, max: 1000, default: 100 }),
];

const traktAuth: ImportListField[] = [
  f('clientId', 'Trakt client id', 'text', { required: true, helpText: 'From your Trakt API application' }),
  f('clientSecret', 'Trakt client secret', 'password', { secret: true, helpText: 'Needed for authentication and token refresh' }),
  f('accessToken', 'Access token', 'password', { secret: true, readOnly: true, helpText: 'Filled by Authenticate with Trakt' }),
  f('refreshToken', 'Refresh token', 'password', { secret: true, readOnly: true }),
  f('tokenExpiresAt', 'Token expires', 'text', { readOnly: true }),
];

const limit = f('limit', 'Limit', 'number', { min: 1, max: 1000, default: 100 });
const opt = (pairs: Array<[string, string]>) => pairs.map(([value, label]) => ({ value, label }));
const SEASONS = opt([['winter', 'Winter'], ['spring', 'Spring'], ['summer', 'Summer'], ['fall', 'Fall']]);
const animeSeason: ImportListField[] = [
  f('season', 'Season', 'select', { options: SEASONS, helpText: 'Seasonal only; empty = the current season' }),
  f('seasonYear', 'Season year', 'number', { min: 1940, helpText: 'Seasonal only; empty = this year' }),
];
const both: ImportListMediaType[] = ['series', 'movie', 'both'];

interface Definition {
  name: string;
  mediaTypes: ImportListMediaType[];
  trakt?: boolean;
  simkl?: boolean;
  infoLink?: string;
  fields: ImportListField[];
}

const definitions: Record<ImportListImplementation, Definition> = {
  tmdbList: {
    name: 'TMDB List',
    mediaTypes: both,
    infoLink: 'https://www.themoviedb.org/list',
    fields: [f('listId', 'List id', 'text', { required: true, helpText: 'The number in the list URL' })],
  },
  tmdbPopular: {
    name: 'TMDB Popular',
    mediaTypes: both,
    fields: [
      f('listType', 'List type', 'select', {
        default: 'popular',
        options: [
          { value: 'popular', label: 'Popular' },
          { value: 'topRated', label: 'Top rated' },
          { value: 'trending', label: 'Trending (week)' },
          { value: 'nowPlaying', label: 'Now playing (movies)' },
          { value: 'upcoming', label: 'Upcoming (movies)' },
          { value: 'airingToday', label: 'Airing today (series)' },
          { value: 'onTheAir', label: 'On the air (series)' },
        ],
      }),
      ...tmdbFilters,
    ],
  },
  tmdbCollection: {
    name: 'TMDB Collection',
    mediaTypes: ['movie'],
    fields: [f('collectionId', 'Collection id', 'number', { required: true, min: 1 })],
  },
  tmdbPerson: {
    name: 'TMDB Person',
    mediaTypes: both,
    fields: [
      f('personId', 'Person id', 'number', { required: true, min: 1 }),
      f('includeCast', 'Include cast credits', 'boolean', { default: true }),
      f('includeCrew', 'Include crew credits', 'boolean', { default: false }),
      f('crewJobs', 'Crew jobs', 'textList', { helpText: 'e.g. Director; empty = all jobs', default: [] }),
    ],
  },
  tmdbKeyword: {
    name: 'TMDB Keyword',
    mediaTypes: both,
    fields: [f('keywordId', 'Keyword id', 'number', { required: true, min: 1 }), ...tmdbFilters],
  },
  trakt: {
    name: 'Trakt List',
    mediaTypes: both,
    trakt: true,
    infoLink: 'https://trakt.tv',
    fields: [
      ...traktAuth,
      f('username', 'Username', 'text', { required: true }),
      f('listName', 'List name (slug)', 'text', { required: true }),
      limit,
    ],
  },
  traktPopular: {
    name: 'Trakt Popular',
    mediaTypes: both,
    trakt: true,
    fields: [
      ...traktAuth,
      f('listType', 'List type', 'select', {
        default: 'popular',
        options: [
          { value: 'trending', label: 'Trending' },
          { value: 'popular', label: 'Popular' },
          { value: 'anticipated', label: 'Anticipated' },
          { value: 'watched', label: 'Most watched' },
          { value: 'played', label: 'Most played' },
          { value: 'collected', label: 'Most collected' },
          { value: 'recommended', label: 'Most recommended' },
          { value: 'boxOffice', label: 'Box office (movies)' },
        ],
      }),
      f('period', 'Period', 'select', {
        default: 'weekly',
        helpText: 'For most watched, played, collected and recommended',
        options: opt([['daily', 'Day'], ['weekly', 'Week'], ['monthly', 'Month'], ['yearly', 'Year'], ['all', 'All time']]),
      }),
      f('yearFrom', 'Year from', 'number', { min: 1870 }),
      f('yearTo', 'Year to', 'number', { min: 1870 }),
      f('genres', 'Genres', 'textList', { helpText: 'Trakt genre slugs', default: [] }),
      f('languages', 'Languages', 'textList', { helpText: 'ISO-639-1 codes', default: [] }),
      f('minRating', 'Minimum rating', 'number', { min: 0, max: 100 }),
      limit,
    ],
  },
  traktUser: {
    name: 'Trakt User',
    mediaTypes: both,
    trakt: true,
    fields: [
      ...traktAuth,
      f('username', 'Username', 'text', { helpText: 'Empty: the authenticated user' }),
      f('listType', 'List', 'select', {
        default: 'watchlist',
        options: [
          { value: 'watchlist', label: 'Watchlist' },
          { value: 'watched', label: 'Watched' },
          { value: 'collection', label: 'Collection' },
          { value: 'favorites', label: 'Favorites' },
          { value: 'recommendations', label: 'Recommendations (authenticated user)' },
        ],
      }),
      limit,
    ],
  },
  plexWatchlist: {
    name: 'Plex Watchlist',
    mediaTypes: both,
    fields: [f('plexToken', 'Plex token', 'password', { required: true, secret: true })],
  },
  imdbList: {
    name: 'IMDb List',
    mediaTypes: both,
    fields: [f('listId', 'List or user id', 'text', { required: true, helpText: 'ls... for a list, ur... for a watchlist' })],
  },
  rss: {
    name: 'RSS / JSON feed',
    mediaTypes: both,
    fields: [f('url', 'Feed URL', 'url', { required: true, helpText: 'JSON of TMDB/IMDb ids or an RSS feed' })],
  },
  stevenLu: {
    name: 'StevenLu Popular Movies',
    mediaTypes: ['movie'],
    fields: [f('url', 'Feed URL', 'url', { default: 'https://s3.amazonaws.com/popular-movies/movies.json' })],
  },
  tmdbCompany: {
    name: 'TMDB Company',
    mediaTypes: ['movie'],
    infoLink: 'https://www.themoviedb.org',
    fields: [f('companyId', 'Company id', 'number', { required: true, min: 1, helpText: 'The number in the company URL' }), ...tmdbFilters],
  },
  tmdbNetwork: {
    name: 'TMDB Network',
    mediaTypes: ['series'],
    infoLink: 'https://www.themoviedb.org',
    fields: [f('networkId', 'Network id', 'number', { required: true, min: 1, helpText: 'The number in the network URL' }), ...tmdbFilters],
  },
  tmdbDiscover: {
    name: 'TMDB Discover',
    mediaTypes: both,
    infoLink: 'https://www.themoviedb.org',
    fields: [
      f('sortBy', 'Sort by', 'select', {
        default: 'popularity.desc',
        options: opt([
          ['popularity.desc', 'Popularity'],
          ['vote_average.desc', 'Rating'],
          ['vote_count.desc', 'Vote count'],
          ['primary_release_date.desc', 'Newest'],
          ['revenue.desc', 'Revenue (movies)'],
        ]),
      }),
      f('keywordIds', 'Keywords', 'numberList', { helpText: 'TMDB keyword ids (any of)', default: [] }),
      f('companyIds', 'Companies', 'numberList', { helpText: 'TMDB company ids (movies)', default: [] }),
      f('networkIds', 'Networks', 'numberList', { helpText: 'TMDB network ids (series)', default: [] }),
      f('watchProviderIds', 'Streaming on', 'numberList', { helpText: 'TMDB watch provider ids (any of)', default: [] }),
      f('watchRegion', 'Streaming region', 'text', { helpText: 'Two-letter country code; empty = your metadata region' }),
      f('certificationLte', 'Certification up to', 'text', { helpText: 'e.g. PG-13 (in your metadata region)' }),
      f('runtimeMin', 'Runtime from (min)', 'number', { min: 0 }),
      f('runtimeMax', 'Runtime to (min)', 'number', { min: 0 }),
      ...tmdbFilters,
    ],
  },
  traktLists: {
    name: 'Trakt User Lists',
    mediaTypes: both,
    trakt: true,
    infoLink: 'https://trakt.tv',
    fields: [
      ...traktAuth,
      f('username', 'Username', 'text', { helpText: 'Empty: the authenticated user' }),
      f('source', 'Lists', 'select', { default: 'own', options: opt([['own', 'Their own lists'], ['liked', 'Lists they liked']]) }),
      f('listNames', 'Only these lists', 'textList', { helpText: 'List names or slugs; empty = every list', default: [] }),
      limit,
    ],
  },
  imdbTop: {
    name: 'IMDb Top Rated',
    mediaTypes: both,
    infoLink: 'https://developer.imdb.com/non-commercial-datasets/',
    fields: [
      f('minVotes', 'Minimum votes', 'number', { min: 1000, default: 25000 }),
      f('limit', 'Limit', 'number', { min: 1, max: 1000, default: 250 }),
    ],
  },
  letterboxd: {
    name: 'Letterboxd',
    mediaTypes: ['movie'],
    infoLink: 'https://letterboxd.com',
    fields: [
      f('source', 'Source', 'select', {
        default: 'watchlist',
        options: opt([['watchlist', 'Watchlist'], ['list', 'One of their lists'], ['diary', 'Diary (recent)'], ['url', 'Any list URL']]),
      }),
      f('username', 'Username', 'text', { helpText: 'Watchlist, list and diary' }),
      f('listSlug', 'List slug', 'text', { helpText: 'The last part of letterboxd.com/user/list/slug/' }),
      f('url', 'List URL', 'url', { helpText: 'Any letterboxd.com list page, e.g. a popular list' }),
      f('limit', 'Limit', 'number', { min: 1, max: 1000, default: 250 }),
    ],
  },
  mdblist: {
    name: 'MDBList',
    mediaTypes: both,
    infoLink: 'https://mdblist.com',
    fields: [
      f('apiKey', 'API key', 'password', { required: true, secret: true, helpText: 'From your mdblist.com preferences' }),
      f('list', 'List', 'text', { required: true, helpText: 'List id, username/list-slug, or the list URL' }),
      f('limit', 'Limit', 'number', { min: 1, max: 5000, default: 500 }),
    ],
  },
  anilist: {
    name: 'AniList',
    mediaTypes: both,
    infoLink: 'https://anilist.co',
    fields: [
      f('source', 'Source', 'select', {
        default: 'user',
        options: opt([['user', 'User list'], ['seasonal', 'Seasonal'], ['trending', 'Trending'], ['popular', 'Popular'], ['top', 'Top rated']]),
      }),
      f('username', 'Username', 'text', { helpText: 'User list only' }),
      f('statuses', 'Statuses', 'multiSelect', {
        default: ['current', 'planning'],
        helpText: 'User list only',
        options: opt([
          ['current', 'Watching'],
          ['planning', 'Planning'],
          ['completed', 'Completed'],
          ['paused', 'Paused'],
          ['dropped', 'Dropped'],
          ['repeating', 'Rewatching'],
        ]),
      }),
      ...animeSeason,
      limit,
    ],
  },
  myAnimeList: {
    name: 'MyAnimeList',
    mediaTypes: both,
    infoLink: 'https://myanimelist.net/apiconfig',
    fields: [
      f('clientId', 'Client id', 'password', { required: true, secret: true, helpText: 'From myanimelist.net/apiconfig' }),
      f('source', 'Source', 'select', { default: 'user', options: opt([['user', 'User list'], ['seasonal', 'Seasonal'], ['ranking', 'Ranking']]) }),
      f('username', 'Username', 'text', { helpText: 'User list only' }),
      f('statuses', 'Statuses', 'multiSelect', {
        default: ['watching', 'plan_to_watch'],
        helpText: 'User list only',
        options: opt([
          ['watching', 'Watching'],
          ['plan_to_watch', 'Plan to watch'],
          ['completed', 'Completed'],
          ['on_hold', 'On hold'],
          ['dropped', 'Dropped'],
        ]),
      }),
      ...animeSeason,
      f('rankingType', 'Ranking', 'select', {
        default: 'all',
        helpText: 'Ranking only',
        options: opt([
          ['all', 'Top anime'],
          ['airing', 'Top airing'],
          ['upcoming', 'Top upcoming'],
          ['tv', 'Top TV'],
          ['movie', 'Top movies'],
          ['bypopularity', 'Most popular'],
          ['favorite', 'Most favourited'],
        ]),
      }),
      limit,
    ],
  },
  kitsu: {
    name: 'Kitsu',
    mediaTypes: both,
    infoLink: 'https://kitsu.app',
    fields: [
      f('source', 'Source', 'select', { default: 'user', options: opt([['user', 'User library'], ['trending', 'Trending']]) }),
      f('username', 'Username', 'text', { helpText: 'User library only (profile name or slug)' }),
      f('statuses', 'Statuses', 'multiSelect', {
        default: ['current', 'planned'],
        helpText: 'User library only',
        options: opt([
          ['current', 'Watching'],
          ['planned', 'Want to watch'],
          ['completed', 'Completed'],
          ['on_hold', 'On hold'],
          ['dropped', 'Dropped'],
        ]),
      }),
      limit,
    ],
  },
  simkl: {
    name: 'Simkl',
    mediaTypes: both,
    simkl: true,
    infoLink: 'https://simkl.com/settings/developer/',
    fields: [
      f('clientId', 'Simkl client id', 'text', { required: true, helpText: 'From your Simkl developer app' }),
      f('accessToken', 'Access token', 'password', { secret: true, readOnly: true, helpText: 'Filled by Authenticate with Simkl' }),
      f('statuses', 'Statuses', 'multiSelect', {
        default: ['plantowatch', 'watching'],
        options: opt([
          ['plantowatch', 'Plan to watch'],
          ['watching', 'Watching'],
          ['hold', 'On hold'],
          ['completed', 'Completed'],
          ['dropped', 'Dropped'],
        ]),
      }),
      f('types', 'Types', 'multiSelect', {
        default: ['shows', 'movies', 'anime'],
        options: opt([['shows', 'Shows'], ['movies', 'Movies'], ['anime', 'Anime']]),
      }),
      f('limit', 'Limit', 'number', { min: 1, max: 5000, default: 500 }),
    ],
  },
  jellyfinFavorites: {
    name: 'Jellyfin / Emby Favorites',
    mediaTypes: both,
    fields: [
      f('serverType', 'Server', 'select', { default: 'jellyfin', options: opt([['jellyfin', 'Jellyfin'], ['emby', 'Emby']]) }),
      f('url', 'Server URL', 'url', { required: true, helpText: 'e.g. http://jellyfin.example.com:8096' }),
      f('apiKey', 'API key', 'password', { required: true, secret: true, helpText: 'Created under Dashboard, API keys' }),
      f('username', 'User', 'text', { required: true, helpText: 'Whose favourites to add' }),
    ],
  },
  customUrl: {
    name: 'Custom JSON / CSV URL',
    mediaTypes: both,
    fields: [
      f('url', 'URL', 'url', { required: true, helpText: 'A JSON or CSV document listing TMDB, IMDb or TVDB ids' }),
      f('format', 'Format', 'select', { default: 'auto', options: opt([['auto', 'Detect'], ['json', 'JSON'], ['csv', 'CSV']]) }),
      f('itemsPath', 'Items path', 'text', { helpText: 'JSON only: dotted path to the array, e.g. data.items' }),
      f('headerName', 'Header name', 'text', { helpText: 'Optional request header, e.g. Authorization' }),
      f('headerValue', 'Header value', 'password', { secret: true }),
    ],
  },
};

export function importListSchemas(): ImportListSchema[] {
  return (Object.keys(definitions) as ImportListImplementation[]).map((implementation) => {
    const d = definitions[implementation];
    return {
      implementation,
      implementationName: d.name,
      supportedMediaTypes: d.mediaTypes,
      requiresTraktAuth: d.trakt ?? false,
      ...(d.simkl ? { requiresSimklAuth: true } : {}),
      ...(d.infoLink ? { infoLink: d.infoLink } : {}),
      fields: d.fields,
    };
  });
}

export function supportedMediaTypes(implementation: ImportListImplementation): ImportListMediaType[] {
  return definitions[implementation].mediaTypes;
}
