import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { jobsApi } from '../api/jobs.js';
import { upsertJob } from '../live.js';
import { queryKeys } from './query-keys.js';

export function useJobs() {
  return useQuery({ queryKey: queryKeys.jobs.recent, queryFn: jobsApi.recent });
}

export function useScheduledJobs() {
  return useQuery({ queryKey: queryKeys.jobs.scheduled, queryFn: jobsApi.scheduled });
}

/** Queue a job by name. Failures surface as an error toast via the MutationCache. */
export function useRunJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: jobsApi.run,
    meta: { errorTitle: 'Could not run job' },
    onSuccess: (job) => {
      upsertJob(qc, job);
      void qc.invalidateQueries({ queryKey: queryKeys.jobs.scheduled });
    },
  });
}
