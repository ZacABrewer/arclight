import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bookmark,
  ContinueResponse,
  PlayableItem,
  PlayQueue,
  PlaybackProgress,
  PlayerCapabilities,
  PlayerSettings,
  ProgressListResponse,
  type BookmarkInput,
  type PlayerSettingsInput,
  type ProgressBeacon,
  type ProgressReport,
  type ProgressUpdate,
  type StreamFormat,
} from '@arclight/shared';
import { buildUrl, request } from '../../api/client.js';
import { useInvalidatingMutation } from '../../hooks/settings-keys.js';
import { t } from '../../i18n/index.js';

// The player's side of the playback contract (packages/shared/src/playback.ts): plain request
// functions plus React Query hooks. Browse endpoints (/playback/music/..., /playback/audiobooks/...)
// live with the browse pages; this file covers what the player itself needs. Kept free of the
// engine so the admin app can import the capability and settings hooks without the player code.

export const playerKeys = {
  all: ['playback'] as const,
  me: ['playback', 'me'] as const,
  item: (key: string) => ['playback', 'item', key] as const,
  progress: (keys: readonly string[]) => ['playback', 'progress', [...keys].sort().join(',')] as const,
  continue: ['playback', 'continue'] as const,
  queue: ['playback', 'queue'] as const,
  bookmarks: (itemKey: string) => ['playback', 'bookmarks', itemKey] as const,
  /** Under ['settings'] so settings events refresh it. */
  settings: ['settings', 'player'] as const,
};

/** Query options of a stream request (GET /stream/audio/:fileId). */
export interface StreamOptions {
  format?: StreamFormat | undefined;
  bitrateKbps?: number | undefined;
  startMs?: number | undefined;
}

/** URL of one file's bytes: the original (range requests) or a live transcode (seek with startMs). */
export function streamUrl(fileId: number, opts: StreamOptions = {}): string {
  const format = opts.format && opts.format !== 'original' ? opts.format : undefined;
  return buildUrl(`/stream/audio/${fileId}`, {
    format,
    bitrateKbps: format ? opts.bitrateKbps : undefined,
    startMs: opts.startMs && opts.startMs > 0 ? Math.floor(opts.startMs) : undefined,
  });
}

const enc = encodeURIComponent;

export const playbackApi = {
  me: () => request('/playback/me', PlayerCapabilities),
  item: (itemKey: string) => request(`/playback/item/${enc(itemKey)}`, PlayableItem),
  /** Effective progress (newest source wins) for up to 200 items. */
  progress: (itemKeys: readonly string[]) => request('/playback/progress', ProgressListResponse, { query: { itemKeys: itemKeys.join(',') } }),
  report: (itemKey: string, body: ProgressReport) => request(`/playback/progress/${enc(itemKey)}`, null, { method: 'PUT', json: body }),
  updateProgress: (itemKey: string, body: ProgressUpdate) => request(`/playback/progress/${enc(itemKey)}`, PlaybackProgress, { method: 'PATCH', json: body }),
  continue: () => request('/playback/continue', ContinueResponse),
  queue: () => request('/playback/queue', PlayQueue),
  saveQueue: (body: PlayQueue) => request('/playback/queue', PlayQueue, { method: 'PUT', json: body }),
  bookmarks: (itemKey: string) => request('/playback/bookmarks', z.array(Bookmark), { query: { itemKey } }),
  addBookmark: (body: BookmarkInput) => request('/playback/bookmarks', Bookmark, { method: 'POST', json: body }),
  updateBookmark: (id: number, body: BookmarkInput) => request(`/playback/bookmarks/${id}`, Bookmark, { method: 'PUT', json: body }),
  removeBookmark: (id: number) => request(`/playback/bookmarks/${id}`, null, { method: 'DELETE' }),
  settings: () => request('/settings/player', PlayerSettings),
  saveSettings: (body: PlayerSettingsInput) => request('/settings/player', PlayerSettings, { method: 'PUT', json: body }),
};

/** URL sendBeacon posts to (text/plain JSON, so no CORS preflight and it survives page close). */
export const BEACON_PATH = '/playback/progress/beacon';

/**
 * Send a progress report that has to outlive the page (pagehide, tab hidden). Falls back to a
 * keepalive fetch where sendBeacon is missing or refuses the payload. Never throws.
 */
export function sendProgressBeacon(body: ProgressBeacon): boolean {
  const url = buildUrl(BEACON_PATH);
  const payload = JSON.stringify(body);
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' }))) return true;
    }
  } catch {
    // Fall through to fetch.
  }
  try {
    void fetch(url, { method: 'POST', body: payload, headers: { 'content-type': 'text/plain' }, credentials: 'same-origin', keepalive: true }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------

/**
 * What the signed-in user may do in the player (GET /playback/me). Not retried: a 404 (api
 * without the player) or 403 simply means "no player" to the entry points.
 */
export function usePlaybackCapabilities(enabled = true) {
  return useQuery({ queryKey: playerKeys.me, queryFn: playbackApi.me, enabled, retry: false, staleTime: 5 * 60_000 });
}

/** The player is on and this user may use it (entry points in the admin nav and the portal). */
export function useCanOpenPlayer(enabled = true): boolean {
  const caps = usePlaybackCapabilities(enabled);
  return Boolean(caps.data?.enabled && caps.data.allowed);
}

/** Everything needed to start an item. Items rarely change, so they stay fresh for a while. */
export function usePlayableItem(itemKey: string | null | undefined) {
  return useQuery({
    queryKey: playerKeys.item(itemKey ?? ''),
    queryFn: () => playbackApi.item(itemKey ?? ''),
    enabled: Boolean(itemKey),
    staleTime: 10 * 60_000,
  });
}

export function useProgress(itemKeys: readonly string[]) {
  return useQuery({
    queryKey: playerKeys.progress(itemKeys),
    queryFn: () => playbackApi.progress(itemKeys),
    enabled: itemKeys.length > 0,
  });
}

/** PUT a report (the provider's reporter calls the api directly; this is for one-off reports). */
export function useReportProgress() {
  return useMutation({
    mutationFn: ({ itemKey, report }: { itemKey: string; report: ProgressReport }) => playbackApi.report(itemKey, report),
    meta: { silent: true },
  });
}

/** Mark played/unplayed, favourite, per-item prefs. */
export function useUpdateProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemKey, update }: { itemKey: string; update: ProgressUpdate }) => playbackApi.updateProgress(itemKey, update),
    meta: { errorTitle: t('player.api.couldNotSaveProgress') },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: ['playback', 'progress'] });
      await qc.invalidateQueries({ queryKey: playerKeys.continue });
    },
  });
}

export function useContinueListening() {
  return useQuery({ queryKey: playerKeys.continue, queryFn: playbackApi.continue });
}

export function useServerQueue(enabled = true) {
  return useQuery({ queryKey: playerKeys.queue, queryFn: playbackApi.queue, enabled, retry: false, staleTime: Infinity });
}

export function useSaveQueue() {
  return useMutation({ mutationFn: (body: PlayQueue) => playbackApi.saveQueue(body), meta: { silent: true } });
}

export function useBookmarks(itemKey: string | null | undefined) {
  return useQuery({ queryKey: playerKeys.bookmarks(itemKey ?? ''), queryFn: () => playbackApi.bookmarks(itemKey ?? ''), enabled: Boolean(itemKey) });
}

export function useAddBookmark(itemKey: string) {
  return useInvalidatingMutation((body: BookmarkInput) => playbackApi.addBookmark(body), [playerKeys.bookmarks(itemKey)], {
    errorTitle: t('player.api.couldNotSaveBookmark'),
  });
}

export function useUpdateBookmark(itemKey: string) {
  return useInvalidatingMutation(({ id, body }: { id: number; body: BookmarkInput }) => playbackApi.updateBookmark(id, body), [playerKeys.bookmarks(itemKey)], {
    errorTitle: t('player.api.couldNotSaveBookmark'),
  });
}

export function useRemoveBookmark(itemKey: string) {
  return useInvalidatingMutation((id: number) => playbackApi.removeBookmark(id), [playerKeys.bookmarks(itemKey)], {
    errorTitle: t('player.api.couldNotRemoveBookmark'),
  });
}

/** Settings → Player (admins). */
export function usePlayerSettings() {
  return useQuery({ queryKey: playerKeys.settings, queryFn: playbackApi.settings });
}

export function useSavePlayerSettings() {
  return useInvalidatingMutation((body: PlayerSettingsInput) => playbackApi.saveSettings(body), [playerKeys.settings, playerKeys.me], {
    errorTitle: t('player.api.couldNotSaveSettings'),
  });
}
