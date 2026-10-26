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

/**
 * POST /command/refresh: re-fetch metadata for one series, one movie, or the whole library.
 * Exactly one of `seriesId`, `movieId` or `all: true`. `rescan` also re-reads the item's
 * folder from disk afterwards. Answered 202 with the started Job.
 */
export const RefreshCommand = z
  .object({
    seriesId: z.number().int().positive().optional(),
    movieId: z.number().int().positive().optional(),
    all: z.literal(true).optional(),
    rescan: z.boolean().default(false),
  })
  .refine((c) => [c.seriesId !== undefined, c.movieId !== undefined, c.all === true].filter(Boolean).length === 1, {
    message: 'give exactly one of seriesId, movieId or all: true',
  });
export type RefreshCommand = z.infer<typeof RefreshCommand>;
