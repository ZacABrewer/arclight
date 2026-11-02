import {
  Podcast,
  PodcastEpisode,
  PodcastEpisodeBulkResult,
  PodcastEpisodePage,
  PodcastListResponse,
  PodcastOpmlImportResult,
  PodcastPreview,
  PodcastSearchResponse,
  PodcastSettingsResponse,
  PodcastSuggestion,
  PodcastSuggestionList,
  type AddPodcastRequest,
  type CreatePodcastSuggestion,
  type PodcastEpisodeBulkAction,
  type PodcastEpisodeQuery,
  type PodcastOpmlImportRequest,
  type PodcastSearchSource,
  type PodcastSettingsInput,
  type PodcastSuggestionListQuery,
  type UpdatePodcastRequest,
} from '@arclight/shared';
import { buildUrl, request, type QueryParams } from './client.js';

// Podcasts (docs/using/podcasts.md). Paths mirror apps/api/src/modules/podcasts; shapes come from
// packages/shared/src/podcasts.ts. Every route answers 404 PODCASTS_DISABLED while the feature is
// off, so the pages sit behind PodcastGate. Calendar episodes ride on the shared CalendarItem union.

const q = (v: object | undefined): QueryParams | undefined => v as QueryParams | undefined;

export const podcastsApi = {
  list: () => request('/podcast', PodcastListResponse),
  get: (id: number) => request(`/podcast/${id}`, Podcast),
  add: (body: AddPodcastRequest) => request('/podcast', Podcast, { method: 'POST', json: body }),
  update: (id: number, body: UpdatePodcastRequest) => request(`/podcast/${id}`, Podcast, { method: 'PUT', json: body }),
  remove: (id: number, deleteFiles: boolean) => request(`/podcast/${id}`, null, { method: 'DELETE', query: { deleteFiles } }),
  refresh: (id: number) => request(`/podcast/${id}/refresh`, Podcast, { method: 'POST' }),
  /** Queues a poll of every monitored feed. */
  refreshAll: () => request('/podcast/refresh', null, { method: 'POST' }),
  episodes: {
    list: (query: PodcastEpisodeQuery) => request('/podcast/episode', PodcastEpisodePage, { query: q(query) }),
    setPlayed: (id: number, played: boolean) => request(`/podcast/episode/${id}`, PodcastEpisode, { method: 'PUT', json: { played } }),
    download: (id: number) => request(`/podcast/episode/${id}/download`, PodcastEpisode, { method: 'POST' }),
    deleteFile: (id: number) => request(`/podcast/episode/${id}/file`, PodcastEpisode, { method: 'DELETE' }),
    bulk: (ids: number[], action: PodcastEpisodeBulkAction) =>
      request('/podcast/episode/bulk', PodcastEpisodeBulkResult, { method: 'POST', json: { ids, action } }),
  },
  /** Directory search for admins (marks podcasts already subscribed). */
  lookup: (term: string, source?: PodcastSearchSource) => request('/podcast/lookup', PodcastSearchResponse, { query: { term, source } }),
  preview: (feedUrl: string) => request('/podcast/preview', PodcastPreview, { method: 'POST', json: { feedUrl } }),
  importOpml: (body: PodcastOpmlImportRequest) => request('/podcast/opml', PodcastOpmlImportResult, { method: 'POST', json: body }),
  /** The OPML export as a plain link (the browser downloads the attachment). */
  opmlUrl: (includePrivate = false) => buildUrl('/podcast/opml', { includePrivate }),
  settings: {
    get: () => request('/settings/podcasts', PodcastSettingsResponse),
    save: (body: PodcastSettingsInput) => request('/settings/podcasts', PodcastSettingsResponse, { method: 'PUT', json: body }),
  },
  // Request portal: any signed-in user.
  search: (term: string) => request('/podcast/search', PodcastSearchResponse, { query: { term } }),
  suggestions: {
    list: (query: PodcastSuggestionListQuery = {}) => request('/podcast/suggestion', PodcastSuggestionList, { query: q(query) }),
    create: (body: CreatePodcastSuggestion) => request('/podcast/suggestion', PodcastSuggestion, { method: 'POST', json: body }),
    approve: (id: number) => request(`/podcast/suggestion/${id}/approve`, PodcastSuggestion, { method: 'POST' }),
    decline: (id: number, reason?: string) =>
      request(`/podcast/suggestion/${id}/decline`, PodcastSuggestion, { method: 'POST', json: reason ? { reason } : {} }),
    remove: (id: number) => request(`/podcast/suggestion/${id}`, null, { method: 'DELETE' }),
  },
};
