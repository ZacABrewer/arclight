import { Job, ScheduledJob, type RunJobRequest } from '@arclight/shared';
import { request } from './client.js';

export const jobsApi = {
  recent: () => request('/jobs', Job.array()),
  scheduled: () => request('/jobs/scheduled', ScheduledJob.array()),
  run: (name: string) => request('/jobs/run', Job, { method: 'POST', json: { name } satisfies RunJobRequest }),
};
