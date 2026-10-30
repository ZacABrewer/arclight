import { z } from 'zod';
import {
  LanguageProfile,
  MediaFileSubtitles,
  SubtitleBlacklistPage,
  SubtitleBlacklistRecord,
  SubtitleHistoryPage,
  SubtitleLanguageOption,
  SubtitleManualSearchResponse,
  SubtitleProvidersResponse,
  SubtitleProviderTestResult,
  SubtitleSearchCommandResult,
  SubtitleSettings,
  SubtitleState,
  SubtitleSyncCheckResult,
  SubtitleSyncResult,
  SubtitleWhisperStatus,
  WantedSubtitlesPage,
  type LanguageProfileInput,
  type SubtitleBlacklistRequest,
  type SubtitleHistoryAction,
  type SubtitleMediaType,
  type SubtitleProviderId,
  type SubtitleSearchCommand,
} from '@arclight/shared';
import { request } from './client.js';

// Subtitles (Phase 3). Every response is parsed with the shared contract in
// packages/shared/src/subtitles.ts.

/** Which media files GET /subtitle/file and POST /subtitle/scan cover. */
export type SubtitleScope = { mediaFileId: number } | { seriesId: number } | { movieId: number };

export interface SubtitleHistoryFilter {
  page: number;
  pageSize: number;
  mediaType?: SubtitleMediaType | undefined;
  action?: SubtitleHistoryAction | undefined;
  provider?: string | undefined;
  seriesId?: number | undefined;
  movieId?: number | undefined;
  mediaFileId?: number | undefined;
}

export interface SubtitleUploadInput {
  mediaFileId: number;
  language: string;
  forced: boolean;
  hi: boolean;
  file: File | Blob;
  fileName?: string | undefined;
}

/** Multipart body for POST /subtitle/upload (fields first, then the one `file` part). */
export function uploadFormData(input: SubtitleUploadInput): FormData {
  const form = new FormData();
  form.set('mediaFileId', String(input.mediaFileId));
  form.set('language', input.language);
  form.set('forced', String(input.forced));
  form.set('hi', String(input.hi));
  const name = input.fileName ?? (input.file instanceof File ? input.file.name : 'subtitle.srt');
  form.set('file', input.file, name);
  return form;
}

export const languageProfilesApi = {
  list: () => request('/languageprofile', z.array(LanguageProfile)),
  get: (id: number) => request(`/languageprofile/${id}`, LanguageProfile),
  create: (body: LanguageProfileInput) => request('/languageprofile', LanguageProfile, { method: 'POST', json: body }),
  update: (id: number, body: LanguageProfileInput) => request(`/languageprofile/${id}`, LanguageProfile, { method: 'PUT', json: body }),
  remove: (id: number) => request(`/languageprofile/${id}`, null, { method: 'DELETE' }),
};

export const subtitlesApi = {
  languages: () => request('/subtitle/languages', z.array(SubtitleLanguageOption)),

  settings: () => request('/subtitle/settings', SubtitleSettings),
  saveSettings: (body: SubtitleSettings) => request('/subtitle/settings', SubtitleSettings, { method: 'PUT', json: body }),

  providers: () => request('/subtitle/providers', SubtitleProvidersResponse),
  testProvider: (id: SubtitleProviderId, settings: Record<string, unknown>) =>
    request('/subtitle/providers/test', SubtitleProviderTestResult, { method: 'POST', json: { id, settings } }),
  resetProviders: (onlyAuthOrConfig = false) =>
    request('/subtitle/providers/reset', SubtitleProvidersResponse, { method: 'POST', json: { onlyAuthOrConfig } }),

  wanted: (mediaType: SubtitleMediaType, page: number, pageSize: number, q?: string) =>
    request('/subtitle/wanted', WantedSubtitlesPage, { query: { mediaType, page, pageSize, q: q || undefined } }),
  history: (filter: SubtitleHistoryFilter) => request('/subtitle/history', SubtitleHistoryPage, { query: { ...filter } }),

  blacklist: (page: number, pageSize: number) => request('/subtitle/blacklist', SubtitleBlacklistPage, { query: { page, pageSize } }),
  addToBlacklist: (body: SubtitleBlacklistRequest) =>
    request('/subtitle/blacklist', SubtitleBlacklistRecord, { method: 'POST', json: body }),
  removeFromBlacklist: (id: number) => request(`/subtitle/blacklist/${id}`, null, { method: 'DELETE' }),
  clearBlacklist: () => request('/subtitle/blacklist', null, { method: 'DELETE' }),

  files: (scope: SubtitleScope) => request('/subtitle/file', z.array(MediaFileSubtitles), { query: { ...scope } }),
  scan: (scope: SubtitleScope) => request('/subtitle/scan', z.array(MediaFileSubtitles), { method: 'POST', json: scope }),

  manualSearch: (mediaFileId: number, language?: string) =>
    request('/subtitle/search', SubtitleManualSearchResponse, { query: { mediaFileId, language: language || undefined } }),
  download: (mediaFileId: number, key: string) => request('/subtitle/download', SubtitleState, { method: 'POST', json: { mediaFileId, key } }),
  /** FormData body: the client leaves content-type to fetch so the multipart boundary is set. */
  upload: (input: SubtitleUploadInput) => request('/subtitle/upload', SubtitleState, { method: 'POST', body: uploadFormData(input) }),
  remove: (id: number) => request(`/subtitle/${id}`, null, { method: 'DELETE' }),
  sync: (id: number) => request(`/subtitle/sync/${id}`, SubtitleSyncResult, { method: 'POST' }),
  /** Measure sync now (no auto actions); the result is stored on the subtitle and its history entry. */
  syncCheck: (id: number) => request(`/subtitle/${id}/synccheck`, SubtitleSyncCheckResult, { method: 'POST' }),
  whisperStatus: () => request('/subtitle/whisper/status', SubtitleWhisperStatus),
  extract: (id: number) => request(`/subtitle/extract/${id}`, SubtitleState, { method: 'POST' }),

  search: (scope: SubtitleSearchCommand) =>
    request('/command/subtitlesearch', SubtitleSearchCommandResult, { method: 'POST', json: scope }),
};
