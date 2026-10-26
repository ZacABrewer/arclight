import { z } from 'zod';

export const JobStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobTrigger = z.enum(['scheduled', 'manual', 'system']);
export type JobTrigger = z.infer<typeof JobTrigger>;

export const Job = z.object({
  id: z.number().int(),
  name: z.string(),
  status: JobStatus,
  trigger: JobTrigger,
  message: z.string().nullable(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nullable(),
});
export type Job = z.infer<typeof Job>;

export const ScheduledJob = z.object({
  name: z.string(),
  interval: z.string().describe('cron expression or ISO-8601 duration'),
  lastRun: z.string().datetime().nullable(),
  nextRun: z.string().datetime().nullable(),
  enabled: z.boolean(),
});
export type ScheduledJob = z.infer<typeof ScheduledJob>;

export const RunJobRequest = z.object({
  name: z.string().min(1),
});
export type RunJobRequest = z.infer<typeof RunJobRequest>;
