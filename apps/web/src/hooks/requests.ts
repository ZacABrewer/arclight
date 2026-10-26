import { useInfiniteQuery, useQuery, type QueryKey } from '@tanstack/react-query';
import type {
  ApproveRequest,
  CreateIssue,
  CreateRequest,
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
  UserQuota,
  UserRequestSettings,
  WatchlistCreate,
} from '@media-tron/shared';
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
  return useInvalidatingMutation((id: number) => requestsApi.remove(id), REQUEST_AFFECTS, { errorTitle: 'Could not delete the request' });
}

export function useApproveRequest() {
  return useInvalidatingMutation(({ id, body }: { id: number; body?: ApproveRequest }) => requestsApi.approve(id, body ?? {}), REQUEST_AFFECTS, {
    errorTitle: 'Could not approve the request',
  });
}

export function useDeclineRequest() {
  return useInvalidatingMutation(({ id, reason }: { id: number; reason?: string }) => requestsApi.decline(id, reason), REQUEST_AFFECTS, {
    errorTitle: 'Could not decline the request',
  });
}

export function useRetryRequest() {
  return useInvalidatingMutation((id: number) => requestsApi.retry(id), REQUEST_AFFECTS, { errorTitle: 'Retry failed' });
}

export function useBulkRequestAction(action: 'approve' | 'decline') {
  return useInvalidatingMutation(
    (ids: number[]) => (action === 'approve' ? requestsApi.bulkApprove(ids) : requestsApi.bulkDecline(ids)),
    REQUEST_AFFECTS,
    { errorTitle: `Bulk ${action} failed` },
  );
}

// ---------------------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------------------

/** Infinite TMDB-backed grid: `fetchPage(page)` returns one DiscoverPage. */
export function useDiscoverInfinite(key: QueryKey, fetchPage: (page: number) => Promise<DiscoverPage>, enabled = true) {
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
    enabled,
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

export function useSliderItems(id: number) {
  return useQuery({ queryKey: requestKeys.discover.slider(id), queryFn: () => discoverApi.slider(id), staleTime: 60_000 });
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
  return useInvalidatingMutation((body: DiscoverSliderOrder) => slidersApi.order(body), SLIDER_AFFECTS, { errorTitle: 'Could not save slider order' });
}

export function useResetSliders() {
  return useInvalidatingMutation(() => slidersApi.reset(), SLIDER_AFFECTS, { errorTitle: 'Could not reset sliders' });
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
    errorTitle: 'Could not add the comment',
  });
}

export function useEditIssueComment() {
  return useInvalidatingMutation(
    ({ commentId, message }: { commentId: number; message: string }) => issuesApi.editComment(commentId, message),
    ISSUE_AFFECTS,
    { errorTitle: 'Could not edit the comment' },
  );
}

export function useDeleteIssueComment() {
  return useInvalidatingMutation((commentId: number) => issuesApi.deleteComment(commentId), ISSUE_AFFECTS, {
    errorTitle: 'Could not delete the comment',
  });
}

export function useSetIssueStatus() {
  return useInvalidatingMutation(({ id, status }: { id: number; status: IssueStatus }) => issuesApi.setStatus(id, status), ISSUE_AFFECTS, {
    errorTitle: 'Could not change the issue status',
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
    errorTitle: 'Could not add to the watchlist',
  });
}

export function useRemoveFromWatchlist() {
  return useInvalidatingMutation((id: number) => watchlistApi.remove(id), WATCHLIST_AFFECTS, {
    errorTitle: 'Could not remove from the watchlist',
  });
}

export function useSyncWatchlists() {
  return useInvalidatingMutation(() => watchlistApi.sync(), [...WATCHLIST_AFFECTS, requestKeys.requests.all], { errorTitle: 'Watchlist sync failed' });
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

export function useRequestsSettings() {
  return useQuery({ queryKey: requestKeys.settings, queryFn: requestsSettingsApi.get, staleTime: 60_000 });
}

export function useSaveRequestsSettings() {
  return useInvalidatingMutation((body: RequestsSettings) => requestsSettingsApi.update(body), [requestKeys.settings, requestKeys.discover.all], {
    silent: true,
  });
}
