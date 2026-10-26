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
} from '@arclight/shared';
import { request } from './client.js';
import { t } from '../i18n/index.js';

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
  get tmdbList() {
    return t('api.importLists.aPublicTmdbListBy');
  },
  get tmdbPopular() {
    return t('api.importLists.tmdbPopularTopRatedOr');
  },
  get tmdbCollection() {
    return t('api.importLists.everyMovieInATmdb');
  },
  get tmdbPerson() {
    return t('api.importLists.titlesAnActorOrCrew');
  },
  get tmdbKeyword() {
    return t('api.importLists.titlesTaggedWithATmdb');
  },
  get trakt() {
    return t('api.importLists.aTraktUserListNeeds');
  },
  get traktPopular() {
    return t('api.importLists.traktTrendingPopularAnticipatedMost');
  },
  get traktUser() {
    return t('api.importLists.aTraktUsersWatchlistWatched');
  },
  get plexWatchlist() {
    return t('api.importLists.yourPlexWatchlistNeedsA');
  },
  get imdbList() {
    return t('api.importLists.aPublicImdbListOr');
  },
  get rss() {
    return t('api.importLists.aJsonOrRssFeed');
  },
  get stevenLu() {
    return t('api.importLists.theStevenluPopularMoviesFeed');
  },
};
