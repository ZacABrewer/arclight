import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { HealthResponse, Job, ScheduledJob } from '@arclight/shared';
import { applyServerEvent, handleStreamOpen, upsertJob } from './live.js';
import { queryKeys, RECENT_JOBS_LIMIT, subtitleKeys } from './hooks/query-keys.js';

function job(id: number, overrides: Partial<Job> = {}): Job {
  return {
    id,
    name: `job-${id}`,
    status: 'completed',
    trigger: 'scheduled',
    message: null,
    queuedAt: '2026-10-25T10:00:00.000Z',
    startedAt: '2026-10-25T10:00:01.000Z',
    endedAt: '2026-10-25T10:00:02.000Z',
    durationMs: 1000,
    ...overrides,
  };
}

const scheduled: ScheduledJob[] = [
  { name: 'rss-sync', interval: 'PT15M', lastRun: null, nextRun: null, enabled: true },
];

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('live cache layer', () => {
  it('creates the recent-jobs list when the cache is empty', () => {
    const qc = client();
    applyServerEvent(qc, { type: 'job', job: job(1) });
    expect(qc.getQueryData<Job[]>(queryKeys.jobs.recent)).toEqual([job(1)]);
  });

  it('puts a new job at the head of the list', () => {
    const qc = client();
    qc.setQueryData(queryKeys.jobs.recent, [job(1), job(2)]);
    applyServerEvent(qc, { type: 'job', job: job(3) });
    expect(qc.getQueryData<Job[]>(queryKeys.jobs.recent)?.map((j) => j.id)).toEqual([3, 1, 2]);
  });

  it('replaces an existing job by id instead of duplicating it', () => {
    const qc = client();
    qc.setQueryData(queryKeys.jobs.recent, [job(2, { status: 'running' }), job(1)]);
    applyServerEvent(qc, { type: 'job', job: job(2, { status: 'failed', message: 'boom' }) });
    const list = qc.getQueryData<Job[]>(queryKeys.jobs.recent);
    expect(list).toHaveLength(2);
    expect(list?.[0]).toMatchObject({ id: 2, status: 'failed', message: 'boom' });
  });

  it(`caps the list at ${RECENT_JOBS_LIMIT} entries`, () => {
    const qc = client();
    qc.setQueryData(
      queryKeys.jobs.recent,
      Array.from({ length: RECENT_JOBS_LIMIT }, (_, i) => job(i + 1)),
    );
    upsertJob(qc, job(999));
    const list = qc.getQueryData<Job[]>(queryKeys.jobs.recent);
    expect(list).toHaveLength(RECENT_JOBS_LIMIT);
    expect(list?.[0]?.id).toBe(999);
  });

  it('invalidates the schedule when a job finishes but not while it runs', () => {
    const qc = client();
    qc.setQueryData(queryKeys.jobs.scheduled, scheduled);
    const spy = vi.spyOn(qc, 'invalidateQueries');

    applyServerEvent(qc, { type: 'job', job: job(1, { status: 'running' }) });
    expect(spy).not.toHaveBeenCalled();

    applyServerEvent(qc, { type: 'job', job: job(1, { status: 'completed' }) });
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.jobs.scheduled });
    expect(qc.getQueryState(queryKeys.jobs.scheduled)?.isInvalidated).toBe(true);
  });

  it('replaces the health query data on a health event', () => {
    const qc = client();
    qc.setQueryData<HealthResponse>(queryKeys.health, { status: 'ok', checks: [] });
    const health: HealthResponse = {
      status: 'warning',
      checks: [{ source: 'DiskSpace', status: 'warning', message: 'Low disk space on /tv' }],
    };
    applyServerEvent(qc, { type: 'health', health });
    expect(qc.getQueryData(queryKeys.health)).toEqual(health);
  });

  it('ignores hello and leaves the cache untouched', () => {
    const qc = client();
    qc.setQueryData(queryKeys.jobs.recent, [job(1)]);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyServerEvent(qc, { type: 'hello', serverTime: '2026-10-25T10:00:00.000Z' });
    expect(qc.getQueryData(queryKeys.jobs.recent)).toEqual([job(1)]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refetches everything after a reconnect, but not on the first open', () => {
    const qc = client();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    handleStreamOpen(qc, { reconnected: false });
    expect(spy).not.toHaveBeenCalled();
    handleStreamOpen(qc, { reconnected: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('invalidates the subtitles family, profiles on a profiles event, and the media family when given', () => {
    const qc = client();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyServerEvent(qc, { type: 'subtitle', action: 'downloaded', mediaType: 'series', mediaId: 3, mediaFileId: 9 });
    expect(spy).toHaveBeenCalledWith({ queryKey: subtitleKeys.all });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['series'] });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: subtitleKeys.languageProfiles });
    spy.mockClear();
    applyServerEvent(qc, { type: 'subtitle', action: 'profiles' });
    expect(spy).toHaveBeenCalledWith({ queryKey: subtitleKeys.languageProfiles });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetches the daily summaries when one is generated', () => {
    const qc = client();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyServerEvent(qc, { type: 'summary', action: 'generated', id: 4 });
    expect(spy).toHaveBeenCalledExactlyOnceWith({ queryKey: ['summary'] });
  });
});
