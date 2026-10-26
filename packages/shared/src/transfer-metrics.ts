import { z } from 'zod';
import { DownloadEventType, QueueSeverity } from './download-clients.js';

// Transfer history: rates, peers and VPN state sampled every few seconds, kept as 1-minute points
// (7 days) and hourly roll-ups (90 days), with the timeline events that explain them (kill-switch
// pauses, stalls, VPN drops) as annotations. GET /metrics/downloads/:queueId, /metrics/engine,
// /metrics/vpn.

const int = () => z.number().int();

export const MetricsRange = z.enum(['1h', '6h', '24h', '7d']);
export type MetricsRange = z.infer<typeof MetricsRange>;

export const MetricsRangeQuery = z.object({ range: MetricsRange.default('1h') });
export type MetricsRangeQuery = z.infer<typeof MetricsRangeQuery>;

/** Width of each range in milliseconds. */
export const METRICS_RANGE_MS: Readonly<Record<MetricsRange, number>> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
};

/** Point spacing the server returns per range (1 min, 1 min, 5 min, 1 h). */
export const METRICS_RANGE_STEP_MS: Readonly<Record<MetricsRange, number>> = {
  '1h': 60_000,
  '6h': 60_000,
  '24h': 300_000,
  '7d': 3_600_000,
};

/** VPN transitions the sampler records (between two observations of the VPN status). */
export const VpnMetricEventType = z.enum([
  'disconnected',
  'connected',
  'killSwitchEngaged',
  'killSwitchReleased',
  'portChanged',
  'warning',
  'warningCleared',
]);
export type VpnMetricEventType = z.infer<typeof VpnMetricEventType>;

/** One marker on a chart: a download timeline entry or a VPN transition. */
export const MetricAnnotation = z.object({
  /** ISO-8601 */
  time: z.string(),
  source: z.enum(['download', 'vpn']),
  type: z.union([DownloadEventType, VpnMetricEventType]),
  severity: QueueSeverity,
  message: z.string().optional(),
  /** Download entries: why (e.g. `killSwitch` on a pause). */
  reason: z.string().optional(),
  trackedDownloadId: int().optional(),
  title: z.string().optional(),
  /** `portChanged`: the new forwarded port (absent when the forward went away). */
  port: int().optional(),
});
export type MetricAnnotation = z.infer<typeof MetricAnnotation>;

const window = {
  range: MetricsRange,
  /** ISO-8601 window start and end (end = now). */
  from: z.string(),
  to: z.string(),
  /** Spacing of `points`; missing points are gaps (nothing was sampled). */
  stepMs: int(),
  /** Oldest first; capped at the most recent 200. */
  annotations: z.array(MetricAnnotation),
};

/** Averages over the point's step; rates in bytes per second. */
export const DownloadMetricPoint = z.object({
  /** ISO-8601 start of the step. */
  time: z.string(),
  downloadRate: z.number(),
  uploadRate: z.number(),
  peers: z.number(),
  seeds: z.number(),
  /** 0..1, the highest seen in the step. */
  progress: z.number(),
});
export type DownloadMetricPoint = z.infer<typeof DownloadMetricPoint>;

export const DownloadMetrics = z.object({
  trackedDownloadId: int(),
  ...window,
  points: z.array(DownloadMetricPoint),
});
export type DownloadMetrics = z.infer<typeof DownloadMetrics>;

export const EngineMetricPoint = z.object({
  time: z.string(),
  downloadRate: z.number(),
  uploadRate: z.number(),
  peers: z.number(),
  activeTorrents: z.number(),
});
export type EngineMetricPoint = z.infer<typeof EngineMetricPoint>;

export const EngineMetrics = z.object({
  ...window,
  points: z.array(EngineMetricPoint),
});
export type EngineMetrics = z.infer<typeof EngineMetrics>;

export const VpnMetricPoint = z.object({
  time: z.string(),
  /** Share of samples in the step (0..1) with the VPN connected / kill switch engaged / a warning. */
  connected: z.number(),
  killSwitch: z.number(),
  warning: z.number(),
  /** Forwarded port at the end of the step, null when none. */
  forwardedPort: int().nullable(),
});
export type VpnMetricPoint = z.infer<typeof VpnMetricPoint>;

export const VpnMetrics = z.object({
  ...window,
  points: z.array(VpnMetricPoint),
  /** Share of sampled time the VPN was connected (0..1); null when nothing was sampled. */
  uptime: z.number().nullable(),
});
export type VpnMetrics = z.infer<typeof VpnMetrics>;
