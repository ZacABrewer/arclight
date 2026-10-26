import { z } from 'zod';

export const HealthStatus = z.enum(['ok', 'warning', 'error']);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const HealthCheck = z.object({
  source: z.string(),
  status: HealthStatus,
  message: z.string(),
  wikiUrl: z.string().optional(),
});
export type HealthCheck = z.infer<typeof HealthCheck>;

export const HealthResponse = z.object({
  status: HealthStatus,
  checks: z.array(HealthCheck),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const SystemStatus = z.object({
  appName: z.literal('Media-Tron'),
  version: z.string(),
  startTime: z.string().datetime(),
  uptimeSeconds: z.number().int().nonnegative(),
  runtime: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
  }),
  paths: z.object({
    config: z.string(),
    database: z.string(),
    logs: z.string(),
  }),
  isDocker: z.boolean(),
  /** A restore (or similar) changed state that only a restart picks up; POST /system/restart. */
  restartRequired: z.boolean().default(false),
});
export type SystemStatus = z.infer<typeof SystemStatus>;
