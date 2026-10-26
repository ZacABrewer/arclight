import { z } from 'zod';
import {
  BulkRequestResult,
  DiscoverGenre,
  DiscoverPage,
  DiscoverSlider,
  Issue,
  IssueCount,
  IssuePage,
  MediaRequest,
  OverrideRule,
  PersonDetail,
  PublicPortal,
  RequestAccepted,
  RequestCount,
  RequestPage,
  RequestPolicyExplanation,
  RequestsDigestResult,
  RequestsSettings,
  TitleDetail,
  UserNotificationTestResult,
  UserPermissions,
  UserQuotaResponse,
  UserRequestSettings,
  WatchlistItem,
  WatchlistSyncResult,
  type ApproveRequest,
  type CreateIssue,
  type CreateRequest,
  type DiscoverKindQuery,
  type DiscoverQuery,
  type DiscoverSliderInput,
  type DiscoverSliderOrder,
  type DiscoverSliderUpdate,
  type IssueListQuery,
  type IssueStatus,
  type OverrideRuleInput,
  type RequestListQuery,
  type TrendingQuery,
  type UpdateRequest,
  type UserQuota,
  type WatchlistCreate,
} from '@arclight/shared';
import { request, type QueryParams } from './client.js';

// Paths mirror docs/API.md "## requests" (apps/api/src/modules/requests). Every response is
// parsed with the shared contract.

const q = (v: object | undefined): QueryParams | undefined => v as QueryParams | undefined;

/** POST /request answers 201 with the request or 202 with a message (nothing left to request). */
export type CreateRequestOutcome = { kind: 'created'; request: MediaRequest } | { kind: 'accepted'; message: string };

const CreateRequestResponse = z.union([MediaRequest, RequestAccepted]);

/** The URL segment the discover routes use for a media type. */
export type DiscoverKind = 'movie' | 'tv';
export const kindOf = (mediaType: 'movie' | 'series'): DiscoverKind => (mediaType === 'movie' ? 'movie' : 'tv');

export const requestsApi = {
  list: (query: RequestListQuery = {}) => request('/request', RequestPage, { query: q(query) }),
  count: () => request('/request/count', RequestCount),
  get: (id: number) => request(`/request/${id}`, MediaRequest),
  create: async (body: CreateRequest): Promise<CreateRequestOutcome> => {
    const res = await request('/request', CreateRequestResponse, { method: 'POST', json: body });
    return 'id' in res ? { kind: 'created', request: res } : { kind: 'accepted', message: res.message };
  },
  update: (id: number, body: UpdateRequest) => request(`/request/${id}`, MediaRequest, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/request/${id}`, null, { method: 'DELETE' }),
  approve: (id: number, body: ApproveRequest = {}) => request(`/request/${id}/approve`, MediaRequest, { method: 'POST', json: body }),
  decline: (id: number, reason?: string) =>
    request(`/request/${id}/decline`, MediaRequest, { method: 'POST', json: reason ? { reason } : {} }),
  retry: (id: number) => request(`/request/${id}/retry`, MediaRequest, { method: 'POST', json: {} }),
  /** Why the approval policies hold (or would approve) a request, evaluated now. */
  policy: (id: number) => request(`/request/${id}/policy`, RequestPolicyExplanation),
  bulkApprove: (ids: number[]) => request('/request/bulk/approve', BulkRequestResult, { method: 'POST', json: { ids } }),
  bulkDecline: (ids: number[]) => request('/request/bulk/decline', BulkRequestResult, { method: 'POST', json: { ids } }),
  /** Send the admin digest of pending requests and open issues now. */
  digest: () => request('/request/digest', RequestsDigestResult, { method: 'POST', json: {} }),
};

export const discoverApi = {
  movies: (query: DiscoverQuery = {}) => request('/discover/movies', DiscoverPage, { query: q(query) }),
  tv: (query: DiscoverQuery = {}) => request('/discover/tv', DiscoverPage, { query: q(query) }),
  trending: (query: TrendingQuery = {}) => request('/discover/trending', DiscoverPage, { query: q(query) }),
  upcoming: (query: DiscoverKindQuery = {}) => request('/discover/upcoming', DiscoverPage, { query: q(query) }),
  search: (query: string, page = 1) => request('/discover/search', DiscoverPage, { query: { query, page } }),
  genres: (mediaType: DiscoverKind) => request('/discover/genres', DiscoverGenre.array(), { query: { mediaType } }),
  genre: (id: number, query: DiscoverKindQuery = {}) => request(`/discover/genre/${id}`, DiscoverPage, { query: q(query) }),
  network: (id: number, page = 1) => request(`/discover/network/${id}`, DiscoverPage, { query: { page } }),
  studio: (id: number, page = 1) => request(`/discover/studio/${id}`, DiscoverPage, { query: { page } }),
  keyword: (id: number, query: DiscoverKindQuery = {}) => request(`/discover/keyword/${id}`, DiscoverPage, { query: q(query) }),
  person: (id: number) => request(`/discover/person/${id}`, PersonDetail),
  title: (kind: DiscoverKind, tmdbId: number) => request(`/discover/${kind}/${tmdbId}`, TitleDetail),
  slider: (id: number, page = 1) => request(`/discover/slider/${id}`, DiscoverPage, { query: { page } }),
};

export const slidersApi = {
  list: () => request('/discoverslider', DiscoverSlider.array()),
  create: (body: DiscoverSliderInput) => request('/discoverslider', DiscoverSlider, { method: 'POST', json: body }),
  order: (body: DiscoverSliderOrder) => request('/discoverslider/order', DiscoverSlider.array(), { method: 'PUT', json: body }),
  reset: () => request('/discoverslider/reset', DiscoverSlider.array(), { method: 'POST', json: {} }),
  update: (id: number, body: DiscoverSliderUpdate) => request(`/discoverslider/${id}`, DiscoverSlider, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/discoverslider/${id}`, null, { method: 'DELETE' }),
};

export const issuesApi = {
  list: (query: IssueListQuery = {}) => request('/issue', IssuePage, { query: q(query) }),
  count: () => request('/issue/count', IssueCount),
  get: (id: number) => request(`/issue/${id}`, Issue),
  create: (body: CreateIssue) => request('/issue', Issue, { method: 'POST', json: body }),
  comment: (id: number, message: string) => request(`/issue/${id}/comment`, Issue, { method: 'POST', json: { message } }),
  setStatus: (id: number, status: IssueStatus) => request(`/issue/${id}/status`, Issue, { method: 'POST', json: { status } }),
  remove: (id: number) => request(`/issue/${id}`, null, { method: 'DELETE' }),
  editComment: (commentId: number, message: string) => request(`/issuecomment/${commentId}`, Issue, { method: 'PUT', json: { message } }),
  deleteComment: (commentId: number) => request(`/issuecomment/${commentId}`, null, { method: 'DELETE' }),
};

export const overrideRulesApi = {
  list: () => request('/overriderule', OverrideRule.array()),
  create: (body: OverrideRuleInput) => request('/overriderule', OverrideRule, { method: 'POST', json: body }),
  update: (id: number, body: OverrideRuleInput) => request(`/overriderule/${id}`, OverrideRule, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/overriderule/${id}`, null, { method: 'DELETE' }),
};

export const watchlistApi = {
  list: (userId?: number) => request('/watchlist', WatchlistItem.array(), { query: { userId } }),
  add: (body: WatchlistCreate) => request('/watchlist', WatchlistItem, { method: 'POST', json: body }),
  remove: (id: number) => request(`/watchlist/${id}`, null, { method: 'DELETE' }),
  sync: () => request('/watchlist/sync', WatchlistSyncResult, { method: 'POST', json: {} }),
};

export const requestUsersApi = {
  permissions: (id: number) => request(`/user/${id}/permissions`, UserPermissions),
  setPermissions: (id: number, permissions: number) =>
    request(`/user/${id}/permissions`, UserPermissions, { method: 'PUT', json: { permissions } }),
  /** PUT with content caps and/or the approval override (`permissions` is required by the route). */
  setPolicy: (id: number, body: UserPermissions) => request(`/user/${id}/permissions`, UserPermissions, { method: 'PUT', json: body }),
  quota: (id: number) => request(`/user/${id}/quota`, UserQuotaResponse),
  setQuota: (id: number, body: UserQuota) => request(`/user/${id}/quota`, UserQuotaResponse, { method: 'PUT', json: body }),
  settings: (id: number) => request(`/user/${id}/requestsettings`, UserRequestSettings),
  setSettings: (id: number, body: UserRequestSettings) =>
    request(`/user/${id}/requestsettings`, UserRequestSettings, { method: 'PUT', json: body }),
  testNotifications: (id: number) =>
    request(`/user/${id}/requestsettings/test`, UserNotificationTestResult, { method: 'POST', json: {} }),
};

export const requestsSettingsApi = {
  get: () => request('/settings/requests', RequestsSettings),
  update: (body: RequestsSettings) => request('/settings/requests', RequestsSettings, { method: 'PUT', json: body }),
};

/** The public request portal (GET /public/portal: public while the portal is enabled). */
export const publicPortalApi = {
  get: () => request('/public/portal', PublicPortal),
};
