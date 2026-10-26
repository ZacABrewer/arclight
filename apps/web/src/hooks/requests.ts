import { useInfiniteQuery, useQuery, type QueryKey } from '@tanstack/react-query';
import type {
  ApproveRequest,
  CreateIssue,
  CreateRequest,
  DiscoverEntityKind,
  DiscoverPage,
  DiscoverSliderInput,
  DiscoverSliderOrder,
  DiscoverSliderUpdate,
  IssueListQuery,
  IssueStatus,
  OverrideRuleInput,
  RequestListQuery,
  RequestsSettings,
  UpdateRequest,
  UserPermissions,
  UserQuota,
  UserRequestSettings,
  WatchlistCreate,
} from '@arclight/shared';
import {
  discoverApi,
  issuesApi,
  overrideRulesApi,
  requestsApi,
  requestsSettingsApi,
  requestUsersApi,
  slidersApi,
  watchlistApi,
  type DiscoverKind,
} from '../api/requests.js';
import { authKeys } from '../auth/guard.js';
import { requestKeys } from './request-keys.js';
import { useInvalidatingMutation, type MutationOptions } from './settings-keys.js';
import { t } from '../i18n/index.js';

// ---------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------

/** Everything a request change can move: lists, counts, title badges, watchlist badges. */
const REQUEST_AFFECTS: readonly QueryKey[] = [requestKeys.requests.all, requestKeys.discover.all, requestKeys.watchlist.all];

export function useRequests(query: RequestListQuery, enabled = true) {
  return useQuery({ queryKey: requestKeys.requests.list(query), queryFn: () => requestsApi.list(query), enabled });
}

export function useRequestCount(enabled = true) {
  return useQuery({ queryKey: requestKeys.requests.count, queryFn: requestsApi.count, enabled });
}

export function useCreateRequest(options: MutationOptions = { silent: true }) {
  return useInvalidatingMutation((body: CreateRequest) => requestsApi.create(body), REQUEST_AFFECTS, options);
}

export function useUpdateRequest() {
  return useInvalidatingMutation(({ id, body }: { id: number; body: UpdateRequest }) => requestsApi.update(id, body), REQUEST_AFFECTS, {
    silent: true,
  });
}

export function useDeleteRequest() {
  return useInvalidatingMutation((id: number) => requestsApi.remove(id), REQUEST_AFFECTS, { errorTitle: t('hooks.requests.couldNotDeleteTheRequest') });
}

export function useApproveRequest() {
  return useInvalidatingMutation(({ id, body }: { id: number; body?: ApproveRequest }) => requestsApi.approve(id, body ?? {}), REQUEST_AFFECTS, {
    errorTitle: t('hooks.requests.couldNotApproveTheRequest'),
  });
}

export function useDeclineRequest() {
  return useInvalidatingMutation(({ id, reason }: { id: number; reason?: string }) => requestsApi.decline(id, reason), REQUEST_AFFECTS, {
    errorTitle: t('hooks.requests.couldNotDeclineTheRequest'),
  });
}

export function useRetryRequest() {
  return useInvalidatingMutation((id: number) => requestsApi.retry(id), REQUEST_AFFECTS, { errorTitle: t('hooks.requests.retryFailed') });
}

export function useBulkRequestAction(action: 'approve' | 'decline') {
  return useInvalidatingMutation(
    (ids: number[]) => (action === 'approve' ? requestsApi.bulkApprove(ids) : requestsApi.bulkDecline(ids)),
    REQUEST_AFFECTS,
    { errorTitle: t('hooks.requests.bulkActionFailed', { action }) },
  );
}

// ---------------------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------------------

/** Infinite TMDB-backed grid: `fetchPage(page)` returns one DiscoverPage. */
export function useDiscoverInfinite<P extends { page: number; totalPages: number } = DiscoverPage>(key: QueryKey, fetchPage: (page: number) => Promise<P>, enabled = true) {
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: 1,
    // TMDB stops at page 500.
    getNextPageParam: (last) => (last.page < Math.min(last.totalPages, 500) ? last.page + 1 : undefined),
    enabled,
    // Pages already seen stay put on Back, so the grid (and the scroll position) comes back at once.
    staleTime: 5 * 60_000,
  });
}

export function useDiscoverGenres(kind: DiscoverKind) {
  return useQuery({ queryKey: requestKeys.discover.genres(kind), queryFn: () => discoverApi.genres(kind), staleTime: 3_600_000 });
}

export function useTitle(kind: DiscoverKind, tmdbId: number) {
  return useQuery({
    queryKey: requestKeys.discover.title(kind, tmdbId),
    queryFn: () => discoverApi.title(kind, tmdbId),
    enabled: Number.isInteger(tmdbId) && tmdbId > 0,
  });
}

export function usePerson(id: number) {
  return useQuery({ queryKey: requestKeys.discover.person(id), queryFn: () => discoverApi.person(id), enabled: id > 0 });
}

export function useSliders() {
  return useQuery({ queryKey: requestKeys.sliders, queryFn: slidersApi.list });
}

export function useSliderItems(id: number, timeWindow?: 'day' | 'week') {
  return useQuery({ queryKey: requestKeys.discover.slider(id, timeWindow), queryFn: () => discoverApi.slider(id, 1, timeWindow), staleTime: 60_000 });
}

/** Home page tiles: genres with backdrops, studio/network logos, streaming services. */
export function useDiscoverTiles(source: 'genres' | 'companies' | 'providers', kind: DiscoverKind, region?: string) {
  return useQuery({
    queryKey: requestKeys.discover.tiles(source, { kind, region: region ?? null }),
    queryFn: () => (source === 'genres' ? discoverApi.genreTiles(kind) : source === 'companies' ? discoverApi.companies(kind) : discoverApi.providers(kind, region)),
    staleTime: 3_600_000,
  });
}

/** Filter vocabularies (regions, languages, certifications) and the instance region. */
export function useDiscoverOptions() {
  return useQuery({ queryKey: requestKeys.discover.options, queryFn: discoverApi.options, staleTime: 3_600_000 });
}

export function useDiscoverEntity(kind: DiscoverEntityKind, id: number) {
  return useQuery({ queryKey: requestKeys.discover.entity(kind, id), queryFn: () => discoverApi.entity(kind, id), enabled: id > 0, staleTime: 3_600_000 });
}

export function useCollection(id: number) {
  return useQuery({ queryKey: requestKeys.discover.collection(id), queryFn: () => discoverApi.collection(id), enabled: id > 0 });
}

export function useRequestCollection() {
  return useInvalidatingMutation(({ id, is4k }: { id: number; is4k: boolean }) => discoverApi.requestCollection(id, is4k), REQUEST_AFFECTS, { silent: true });
}

const SLIDER_AFFECTS: readonly QueryKey[] = [requestKeys.sliders, requestKeys.discover.all];

export function useCreateSlider() {
  return useInvalidatingMutation((body: DiscoverSliderInput) => slidersApi.create(body), SLIDER_AFFECTS, { silent: true });
}

export function useUpdateSlider() {
  return useInvalidatingMutation(({ id, body }: { id: number; body: DiscoverSliderUpdate }) => slidersApi.update(id, body), SLIDER_AFFECTS, {
    silent: true,
  });
}

export function useOrderSliders() {
  return useInvalidatingMutation((body: DiscoverSliderOrder) => slidersApi.order(body), SLIDER_AFFECTS, { errorTitle: t('hooks.requests.couldNotSaveSliderOrder') });
}

export function useResetSliders() {
  return useInvalidatingMutation(() => slidersApi.reset(), SLIDER_AFFECTS, { errorTitle: t('hooks.requests.couldNotResetSliders') });
}

export function useDeleteSlider() {
  return useInvalidatingMutation((id: number) => slidersApi.remove(id), SLIDER_AFFECTS, { silent: true });
}

// ---------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------

const ISSUE_AFFECTS: readonly QueryKey[] = [requestKeys.issues.all, requestKeys.discover.titles];

export function useIssues(query: IssueListQuery) {
  return useQuery({ queryKey: requestKeys.issues.list(query), queryFn: () => issuesApi.list(query) });
}

export function useIssueCount() {
  return useQuery({ queryKey: requestKeys.issues.count, queryFn: issuesApi.count });
}

export function useIssue(id: number) {
  return useQuery({ queryKey: requestKeys.issues.detail(id), queryFn: () => issuesApi.get(id), enabled: id > 0 });
}

export function useCreateIssue() {
  return useInvalidatingMutation((body: CreateIssue) => issuesApi.create(body), ISSUE_AFFECTS, { silent: true });
}

export function useIssueComment() {
  return useInvalidatingMutation(({ id, message }: { id: number; message: string }) => issuesApi.comment(id, message), ISSUE_AFFECTS, {
    errorTitle: t('hooks.requests.couldNotAddTheComment'),
  });
}

export function useEditIssueComment() {
  return useInvalidatingMutation(
    ({ commentId, message }: { commentId: number; message: string }) => issuesApi.editComment(commentId, message),
    ISSUE_AFFECTS,
    { errorTitle: t('hooks.requests.couldNotEditTheComment') },
  );
}

export function useDeleteIssueComment() {
  return useInvalidatingMutation((commentId: number) => issuesApi.deleteComment(commentId), ISSUE_AFFECTS, {
    errorTitle: t('hooks.requests.couldNotDeleteTheComment'),
  });
}

export function useSetIssueStatus() {
  return useInvalidatingMutation(({ id, status }: { id: number; status: IssueStatus }) => issuesApi.setStatus(id, status), ISSUE_AFFECTS, {
    errorTitle: t('hooks.requests.couldNotChangeTheIssue'),
  });
}

export function useDeleteIssue() {
  return useInvalidatingMutation((id: number) => issuesApi.remove(id), ISSUE_AFFECTS, { silent: true });
}

// ---------------------------------------------------------------------------------------
// Override rules, watchlist
// ---------------------------------------------------------------------------------------

export function useOverrideRules() {
  return useQuery({ queryKey: requestKeys.overrideRules, queryFn: overrideRulesApi.list });
}

export function useSaveOverrideRule() {
  return useInvalidatingMutation(
    ({ id, body }: { id: number | null; body: OverrideRuleInput }) => (id === null ? overrideRulesApi.create(body) : overrideRulesApi.update(id, body)),
    [requestKeys.overrideRules],
    { silent: true },
  );
}

export function useDeleteOverrideRule() {
  return useInvalidatingMutation((id: number) => overrideRulesApi.remove(id), [requestKeys.overrideRules], { silent: true });
}

const WATCHLIST_AFFECTS: readonly QueryKey[] = [requestKeys.watchlist.all, requestKeys.discover.titles];

export function useWatchlist(userId?: number, enabled = true) {
  return useQuery({ queryKey: requestKeys.watchlist.list(userId), queryFn: () => watchlistApi.list(userId), enabled });
}

export function useAddToWatchlist() {
  return useInvalidatingMutation((body: WatchlistCreate) => watchlistApi.add(body), WATCHLIST_AFFECTS, {
    errorTitle: t('hooks.requests.couldNotAddToThe'),
  });
}

export function useRemoveFromWatchlist() {
  return useInvalidatingMutation((id: number) => watchlistApi.remove(id), WATCHLIST_AFFECTS, {
    errorTitle: t('hooks.requests.couldNotRemoveFromThe'),
  });
}

export function useSyncWatchlists() {
  return useInvalidatingMutation(() => watchlistApi.sync(), [...WATCHLIST_AFFECTS, requestKeys.requests.all], { errorTitle: t('hooks.requests.watchlistSyncFailed') });
}

// ---------------------------------------------------------------------------------------
// Users (permissions, quotas, personal request settings) and the settings section
// ---------------------------------------------------------------------------------------

export function useUserPermissions(id: number | null) {
  return useQuery({
    queryKey: requestKeys.users.permissions(id ?? 0),
    queryFn: () => requestUsersApi.permissions(id ?? 0),
    enabled: id !== null,
  });
}

export function useSetUserPermissions(id: number) {
  return useInvalidatingMutation(
    (permissions: number) => requestUsersApi.setPermissions(id, permissions),
    [requestKeys.users.permissions(id), requestKeys.users.quota(id), authKeys.users, authKeys.me],
    { silent: true },
  );
}

/** PUT /user/:id/permissions with content caps and the approval override. */
export function useSetUserPolicy(id: number) {
  return useInvalidatingMutation((body: UserPermissions) => requestUsersApi.setPolicy(id, body), [requestKeys.users.permissions(id)], { silent: true });
}

export function useUserQuota(id: number | null) {
  return useQuery({ queryKey: requestKeys.users.quota(id ?? 0), queryFn: () => requestUsersApi.quota(id ?? 0), enabled: id !== null });
}

export function useSetUserQuota(id: number) {
  return useInvalidatingMutation((body: UserQuota) => requestUsersApi.setQuota(id, body), [requestKeys.users.quota(id)], { silent: true });
}

export function useUserRequestSettings(id: number | null) {
  return useQuery({
    queryKey: requestKeys.users.settings(id ?? 0),
    queryFn: () => requestUsersApi.settings(id ?? 0),
    enabled: id !== null,
  });
}

export function useSetUserRequestSettings(id: number) {
  return useInvalidatingMutation((body: UserRequestSettings) => requestUsersApi.setSettings(id, body), [requestKeys.users.settings(id)], {
    silent: true,
  });
}

export function useTestUserNotifications(id: number) {
  return useInvalidatingMutation(() => requestUsersApi.testNotifications(id), [], { silent: true });
}

export function useRequestsSettings(enabled = true) {
  return useQuery({ queryKey: requestKeys.settings, queryFn: requestsSettingsApi.get, staleTime: 60_000, enabled });
}

export function useSaveRequestsSettings() {
  return useInvalidatingMutation((body: RequestsSettings) => requestsSettingsApi.update(body), [requestKeys.settings, requestKeys.discover.all], {
    silent: true,
  });
}

/** Why a request is held: GET /request/:id/policy (read when the policy drawer opens). */
export function useRequestPolicy(id: number, enabled = true) {
  return useQuery({ queryKey: [...requestKeys.requests.detail(id), 'policy'], queryFn: () => requestsApi.policy(id), enabled: enabled && id > 0, retry: false });
}

/** One request by id (deep links from notifications). */
export function useRequest(id: number) {
  return useQuery({ queryKey: requestKeys.requests.detail(id), queryFn: () => requestsApi.get(id), enabled: id > 0, retry: false });
}

export function useSendDigest() {
  return useInvalidatingMutation(() => requestsApi.digest(), [], { errorTitle: t('hooks.requests.couldNotSendTheDigest') });
}
