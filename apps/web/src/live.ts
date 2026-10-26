import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Job, ServerEvent } from '@media-tron/shared';
import { connectEvents } from './api/events.js';
import { queryKeys, RECENT_JOBS_LIMIT } from './hooks/query-keys.js';
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
