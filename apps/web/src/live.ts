import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Job, ServerEvent } from '@arclight/shared';
import { connectEvents } from './api/events.js';
import { queryKeys, RECENT_JOBS_LIMIT, subtitleKeys } from './hooks/query-keys.js';
import { profileMigrationKeys } from './hooks/profile-migration.js';
import { requestKeys } from './hooks/request-keys.js';
import { settingsKeys } from './hooks/settings-keys.js';
import { connectionStore } from './lib/connection.js';

// The event-driven cache layer: every ServerEvent pushed over /api/v1/events is folded into
// the TanStack Query cache here. Adding a new event type to the shared contract makes the
// switch below non-exhaustive, so the compiler points at the one place to handle it.

/** Insert or replace a job run at the head of the recent-runs list. */
export function upsertJob(qc: QueryClient, job: Job): void {
  qc.setQueryData<Job[]>(queryKeys.jobs.recent, (prev = []) =>
    [job, ...prev.filter((j) => j.id !== job.id)].slice(0, RECENT_JOBS_LIMIT),
  );
}

export function applyServerEvent(qc: QueryClient, event: ServerEvent): void {
  switch (event.type) {
    case 'hello':
      return;
    case 'job':
      upsertJob(qc, event.job);
      // A finished run moves lastRun/nextRun on the schedule board.
      if (event.job.status !== 'running' && event.job.status !== 'queued') {
        void qc.invalidateQueries({ queryKey: queryKeys.jobs.scheduled });
      }
      return;
    case 'health':
      qc.setQueryData(queryKeys.health, event.health);
      return;
    // Resource-changed notifications: refetch the matching query families. Pages that
    // introduce finer keys refine these invalidations alongside their query-key additions.
    case 'library':
      void qc.invalidateQueries({ queryKey: [event.mediaType] });
      void qc.invalidateQueries({ queryKey: ['library'] });
      void qc.invalidateQueries({ queryKey: ['wanted'] });
      return;
    case 'queue':
    // A timeline entry (paused by the kill switch, stalled, imported, ...): rows and timelines.
    case 'download':
      void qc.invalidateQueries({ queryKey: ['queue'] });
      return;
    case 'torrent':
      // The engine entered or left lockdown: banner, engine status and the paused rows.
      void qc.invalidateQueries({ queryKey: ['torrent'] });
      void qc.invalidateQueries({ queryKey: ['queue'] });
      return;
    case 'release':
    case 'import':
    case 'history':
      void qc.invalidateQueries({ queryKey: ['queue'] });
      void qc.invalidateQueries({ queryKey: ['history'] });
      if (event.type !== 'history' && event.mediaType) {
        void qc.invalidateQueries({ queryKey: [event.mediaType] });
      }
      return;
    case 'indexer':
      void qc.invalidateQueries({ queryKey: ['indexers'] });
      return;
    case 'settings':
      void qc.invalidateQueries({ queryKey: ['settings'] });
      return;
    case 'vpn':
      void qc.invalidateQueries({ queryKey: ['vpn'] });
      return;
    case 'subtitle':
      void qc.invalidateQueries({ queryKey: subtitleKeys.all });
      if (event.action === 'profiles') void qc.invalidateQueries({ queryKey: subtitleKeys.languageProfiles });
      if (event.mediaType) void qc.invalidateQueries({ queryKey: [event.mediaType] });
      return;
    case 'request':
      // Lists, counts and the single request; title pages and watchlist items show request status.
      void qc.invalidateQueries({ queryKey: requestKeys.requests.all });
      void qc.invalidateQueries({ queryKey: requestKeys.discover.titles });
      void qc.invalidateQueries({ queryKey: requestKeys.watchlist.all });
      return;
    case 'issue':
      void qc.invalidateQueries({ queryKey: requestKeys.issues.all });
      // Title pages show the open-issue count.
      void qc.invalidateQueries({ queryKey: requestKeys.discover.titles });
      return;
    case 'profile':
      // Profiles and formats feed the profile pages; their files are re-judged server-side.
      void qc.invalidateQueries({ queryKey: settingsKeys.qualityProfiles });
      if (event.kind === 'customFormat') void qc.invalidateQueries({ queryKey: settingsKeys.customFormats });
      void qc.invalidateQueries({ queryKey: profileMigrationKeys.all });
      return;
    case 'profileMigration':
      void qc.invalidateQueries({ queryKey: profileMigrationKeys.all });
      return;
    default:
      assertNever(event);
  }
}

/** After a reconnect we may have missed events: refetch whatever is on screen. */
export function handleStreamOpen(qc: QueryClient, info: { reconnected: boolean }): void {
  if (info.reconnected) void qc.invalidateQueries();
}

/** Mount once (in the app shell) to keep the cache live for the whole session. */
export function useLiveEvents(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      connectEvents({
        onEvent: (event) => applyServerEvent(qc, event),
        onState: (state, info) => connectionStore.set(state, info),
        onOpen: (info) => handleStreamOpen(qc, info),
      }),
    [qc],
  );
}

function assertNever(value: never): void {
  // Unknown event from a newer server: ignore at runtime, fail at compile time.
  void value;
}
