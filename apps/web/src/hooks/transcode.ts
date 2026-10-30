import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TranscodeJob, TranscodeJobStatus, TranscodeRuleInputRaw, TranscodeRunRequest, TranscodeSettings } from '@arclight/shared';
import { transcodeApi } from '../api/transcode.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

export const transcodeKeys = {
  all: ['transcode'] as const,
  rules: ['transcode', 'rules'] as const,
  jobsAll: ['transcode', 'jobs'] as const,
  jobs: (status: TranscodeJobStatus | undefined) => ['transcode', 'jobs', status ?? 'all'] as const,
  hwaccel: ['transcode', 'hwaccel'] as const,
  settings: ['transcode', 'settings'] as const,
};

export function useTranscodeRules() {
  return useQuery({ queryKey: transcodeKeys.rules, queryFn: transcodeApi.rules.list, retry: false });
}

export function useSaveTranscodeRule() {
  return useInvalidatingMutation(
    ({ id, body }: { id: number | undefined; body: TranscodeRuleInputRaw }) =>
      id === undefined ? transcodeApi.rules.create(body) : transcodeApi.rules.update(id, body),
    [transcodeKeys.rules],
    { silent: true },
  );
}

export function useDeleteTranscodeRule() {
  return useInvalidatingMutation((id: number) => transcodeApi.rules.remove(id), [transcodeKeys.all], {
    errorTitle: t('hooks.transcode.couldNotDeleteRule'),
  });
}

export function useTranscodeHwaccel() {
  return useQuery({ queryKey: transcodeKeys.hwaccel, queryFn: () => transcodeApi.hwaccel(), retry: false, staleTime: 5 * 60_000 });
}

/** "Test again": the server re-runs every backend's test encode; the result replaces the cache. */
export function useRetestTranscodeHwaccel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => transcodeApi.hwaccel(true),
    meta: { errorTitle: t('hooks.transcode.couldNotTestHardware') },
    onSuccess: (data) => qc.setQueryData(transcodeKeys.hwaccel, data),
  });
}

export function useTranscodeSettings() {
  return useQuery({ queryKey: transcodeKeys.settings, queryFn: transcodeApi.settings.get, retry: false });
}

export function useSaveTranscodeSettings() {
  return useInvalidatingMutation((body: TranscodeSettings) => transcodeApi.settings.save(body), [transcodeKeys.settings]);
}

/** True while any job may still change (polls faster then). */
export function hasActiveJobs(jobs: readonly TranscodeJob[] | undefined): boolean {
  return (jobs ?? []).some((j) => j.status === 'running' || j.status === 'queued');
}

/** Jobs, newest first; polled every 2 s while a job is queued or running, else every 30 s. */
export function useTranscodeJobs(status: TranscodeJobStatus | undefined) {
  return useQuery({
    queryKey: transcodeKeys.jobs(status),
    queryFn: () => transcodeApi.jobs(status ? { status } : {}),
    retry: false,
    refetchInterval: (q) => (hasActiveJobs(q.state.data) ? 2_000 : 30_000),
  });
}

/** POST /transcode/run; the caller reports the result. */
export function useRunTranscode(options: { silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TranscodeRunRequest) => transcodeApi.run(body),
    meta: options.silent ? { silent: true } : { errorTitle: t('hooks.transcode.couldNotQueue') },
    onSettled: () => void qc.invalidateQueries({ queryKey: transcodeKeys.jobsAll }),
  });
}

export function useCancelTranscodeJob() {
  return useInvalidatingMutation((id: number) => transcodeApi.cancel(id), [transcodeKeys.jobsAll], {
    errorTitle: t('hooks.transcode.couldNotCancel'),
  });
}
