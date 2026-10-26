import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { jobsApi } from '../api/jobs.js';
import { useToast } from '../components/toast.js';
import { upsertJob } from '../live.js';
import { queryKeys } from './query-keys.js';
import { t } from '../i18n/index.js';

export function useJobs() {
  return useQuery({ queryKey: queryKeys.jobs.recent, queryFn: jobsApi.recent });
}

export function useScheduledJobs() {
  return useQuery({ queryKey: queryKeys.jobs.scheduled, queryFn: jobsApi.scheduled });
}

/** Queue a job by name. Success raises a confirmation toast; failures an error toast via the MutationCache. */
export function useRunJob() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: jobsApi.run,
    meta: { errorTitle: t('hooks.jobs.couldNotRunJob') },
    onSuccess: (job) => {
      toast.push({ tone: 'ok', title: t('hooks.jobs.startedName', { name: job.name }), message: t('hooks.jobs.runIdIsStatus', { id: job.id, status: job.status }), durationMs: 4_000 });
      upsertJob(qc, job);
      void qc.invalidateQueries({ queryKey: queryKeys.jobs.scheduled });
    },
  });
}
