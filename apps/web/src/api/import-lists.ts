import { z } from 'zod';
import {
  ImportList,
  ImportListExclusion,
  ImportListFoundItem,
  ImportListItem,
  ImportListSchema,
  ImportListSettings,
  ImportListSyncResult,
  ImportListTestResult,
  TraktDeviceResponse,
  TraktPollResponse,
  type ImportListCreateInput,
  type ImportListExclusionCreate,
  type ImportListImplementation,
  type ImportListItemsQuery,
  type TraktPollRequest,
} from '@media-tron/shared';
import { request } from './client.js';

// Client for the import-lists module (/importlist*, /importlistexclusion*, /settings/importlists).
// Every response is parsed with the shared contract.

export type ImportListTestInput = ImportListCreateInput & { id?: number };

export const importListsApi = {
  list: () => request('/importlist', z.array(ImportList)),
  get: (id: number) => request(`/importlist/${id}`, ImportList),
  schema: () => request('/importlist/schema', z.array(ImportListSchema)),
  create: (body: ImportListCreateInput) => request('/importlist', ImportList, { method: 'POST', json: body }),
  update: (id: number, body: ImportListCreateInput) => request(`/importlist/${id}`, ImportList, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/importlist/${id}`, null, { method: 'DELETE' }),
  test: (body: ImportListTestInput) => request('/importlist/test', ImportListTestResult, { method: 'POST', json: body }),
  sync: () => request('/importlist/sync', ImportListSyncResult, { method: 'POST' }),
  items: (id: number) => request(`/importlist/${id}/items`, z.array(ImportListItem)),
  /** Items across every list; filter by title to drive the "found in list" chips. */
  foundIn: (query: ImportListItemsQuery = {}) =>
    request('/importlist/items', z.array(ImportListFoundItem), { query: { mediaType: query.mediaType, tmdbId: query.tmdbId } }),
  traktDevice: (clientId: string) =>
    request('/importlist/trakt/device', TraktDeviceResponse, { method: 'POST', json: { clientId } }),
  traktPoll: (body: TraktPollRequest) => request('/importlist/trakt/poll', TraktPollResponse, { method: 'POST', json: body }),
  exclusions: {
    list: () => request('/importlistexclusion', z.array(ImportListExclusion)),
    create: (body: ImportListExclusionCreate) =>
      request('/importlistexclusion', ImportListExclusion, { method: 'POST', json: body }),
    remove: (id: number) => request(`/importlistexclusion/${id}`, null, { method: 'DELETE' }),
  },
  settings: {
    get: () => request('/settings/importlists', ImportListSettings),
    update: (body: ImportListSettings) => request('/settings/importlists', ImportListSettings, { method: 'PUT', json: body }),
  },
};

/** The schema endpoint carries no prose; these one-liners drive the add dialog. */
export const IMPORT_LIST_DESCRIPTIONS: Record<ImportListImplementation, string> = {
  tmdbList: 'A public TMDB list by its id.',
  tmdbPopular: 'TMDB popular, top rated or trending titles, with vote/year/language filters.',
  tmdbCollection: 'Every movie in a TMDB collection (e.g. a franchise).',
  tmdbPerson: 'Titles an actor or crew member worked on.',
  tmdbKeyword: 'Titles tagged with a TMDB keyword.',
  trakt: 'A Trakt user list. Needs a Trakt API app; private lists need authentication.',
  traktPopular: 'Trakt trending, popular, anticipated, most watched or box office.',
  traktUser: "A Trakt user's watchlist, watched history or collection.",
  plexWatchlist: 'Your Plex watchlist (needs a Plex token).',
  imdbList: 'A public IMDb list or a user watchlist.',
  rss: 'A JSON or RSS feed of TMDB/IMDb ids.',
  stevenLu: 'The StevenLu popular movies feed.',
};
