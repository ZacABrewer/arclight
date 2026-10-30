import {
  BulkRequestResult,
  LanguageRequest,
  LanguageRequestCount,
  LanguageRequestLanguages,
  LanguageRequestOptions,
  LanguageRequestPage,
  type ApproveLanguageRequest,
  type CreateLanguageRequest,
  type LanguageRequestListQuery,
  type LanguageRequestOptionsQuery,
} from '@arclight/shared';
import { request, type QueryParams } from './client.js';

// Subtitle and language requests (docs/API.md "Subtitle and language requests"): subtitles or an
// additional audio language for a title already in the library. Responses are parsed with the
// shared contract.

const q = (v: object | undefined): QueryParams | undefined => v as QueryParams | undefined;

export type LanguageBulkAction = 'approve' | 'decline' | 'retry' | 'delete';

export const languageRequestsApi = {
  list: (query: LanguageRequestListQuery = {}) => request('/request/language', LanguageRequestPage, { query: q(query) }),
  count: () => request('/request/language/count', LanguageRequestCount),
  options: (query: LanguageRequestOptionsQuery) => request('/request/language/options', LanguageRequestOptions, { query: q(query) }),
  languages: () => request('/request/language/languages', LanguageRequestLanguages),
  get: (id: number) => request(`/request/language/${id}`, LanguageRequest),
  create: (body: CreateLanguageRequest) => request('/request/language', LanguageRequest, { method: 'POST', json: body }),
  approve: (id: number, body: ApproveLanguageRequest = {}) => request(`/request/language/${id}/approve`, LanguageRequest, { method: 'POST', json: body }),
  decline: (id: number, reason?: string) => request(`/request/language/${id}/decline`, LanguageRequest, { method: 'POST', json: reason ? { reason } : {} }),
  retry: (id: number) => request(`/request/language/${id}/retry`, LanguageRequest, { method: 'POST', json: {} }),
  remove: (id: number) => request(`/request/language/${id}`, null, { method: 'DELETE' }),
  /** Approve, decline, retry or delete several requests; answers per id. */
  bulk: (action: LanguageBulkAction, ids: number[]) => request(`/request/language/bulk/${action}`, BulkRequestResult, { method: 'POST', json: { ids } }),
};
