import { useQuery, type QueryKey } from '@tanstack/react-query';
import type { ApproveLanguageRequest, CreateLanguageRequest, LanguageRequestListQuery, LanguageRequestOptionsQuery } from '@arclight/shared';
import { languageRequestsApi, type LanguageBulkAction } from '../api/language-requests.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Subtitle and language requests. Keys sit under the request family (hooks/request-keys.ts), so
// live `request` events (`language: true` ones included) refresh them with the other lists.

export const languageRequestKeys = {
  all: ['requests', 'language'] as const,
  list: (query: LanguageRequestListQuery) => ['requests', 'language', 'list', query] as const,
  count: ['requests', 'language', 'count'] as const,
  options: (query: LanguageRequestOptionsQuery) => ['requests', 'language', 'options', query] as const,
  /** The language list never changes while the app runs. */
  languages: ['languageRequestLanguages'] as const,
};

/** A change to a language request moves its lists, counts and the title's dialog options. */
const AFFECTS: readonly QueryKey[] = [languageRequestKeys.all];

export function useLanguageRequests(query: LanguageRequestListQuery, enabled = true) {
  return useQuery({ queryKey: languageRequestKeys.list(query), queryFn: () => languageRequestsApi.list(query), enabled });
}

export function useLanguageRequestCount(enabled = true) {
  return useQuery({ queryKey: languageRequestKeys.count, queryFn: languageRequestsApi.count, enabled, retry: false });
}

export function useLanguageRequestOptions(query: LanguageRequestOptionsQuery, enabled = true) {
  return useQuery({ queryKey: languageRequestKeys.options(query), queryFn: () => languageRequestsApi.options(query), enabled, retry: false });
}

export function useRequestableLanguages(enabled = true) {
  return useQuery({ queryKey: languageRequestKeys.languages, queryFn: languageRequestsApi.languages, enabled, staleTime: Infinity, retry: false });
}

/** Errors are shown in the dialog (409 duplicates explain themselves), so no toast here. */
export function useCreateLanguageRequest() {
  return useInvalidatingMutation((body: CreateLanguageRequest) => languageRequestsApi.create(body), AFFECTS, { silent: true });
}

export function useApproveLanguageRequest() {
  return useInvalidatingMutation(({ id, body }: { id: number; body?: ApproveLanguageRequest }) => languageRequestsApi.approve(id, body), AFFECTS, {
    errorTitle: t('hooks.requests.couldNotApproveTheRequest'),
  });
}

export function useDeclineLanguageRequest() {
  return useInvalidatingMutation(({ id, reason }: { id: number; reason?: string }) => languageRequestsApi.decline(id, reason), AFFECTS, {
    errorTitle: t('hooks.requests.couldNotDeclineTheRequest'),
  });
}

export function useRetryLanguageRequest() {
  return useInvalidatingMutation((id: number) => languageRequestsApi.retry(id), AFFECTS, { errorTitle: t('hooks.requests.retryFailed') });
}

export function useDeleteLanguageRequest() {
  return useInvalidatingMutation((id: number) => languageRequestsApi.remove(id), AFFECTS, { errorTitle: t('hooks.requests.couldNotDeleteTheRequest') });
}

/** Approve, decline, retry or delete several language requests; answers per id. */
export function useBulkLanguageRequestAction() {
  return useInvalidatingMutation(({ ids, action }: { ids: number[]; action: LanguageBulkAction }) => languageRequestsApi.bulk(action, ids), AFFECTS, {
    errorTitle: t('hooks.requests.bulkActionFailed', { action: t('components.bulkActions.title') }),
  });
}
