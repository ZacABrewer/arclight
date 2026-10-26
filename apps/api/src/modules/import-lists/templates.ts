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
const both: ImportListMediaType[] = ['series', 'movie', 'both'];

interface Definition {
  name: string;
  mediaTypes: ImportListMediaType[];
  trakt?: boolean;
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
          { value: 'watched', label: 'Most watched (week)' },
          { value: 'boxOffice', label: 'Box office (movies)' },
        ],
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
};

export function importListSchemas(): ImportListSchema[] {
  return (Object.keys(definitions) as ImportListImplementation[]).map((implementation) => {
    const d = definitions[implementation];
    return {
      implementation,
      implementationName: d.name,
      supportedMediaTypes: d.mediaTypes,
      requiresTraktAuth: d.trakt ?? false,
      ...(d.infoLink ? { infoLink: d.infoLink } : {}),
      fields: d.fields,
    };
  });
}

export function supportedMediaTypes(implementation: ImportListImplementation): ImportListMediaType[] {
  return definitions[implementation].mediaTypes;
}
