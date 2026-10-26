import type { ActivityDay, StatsBucket, StatsRootFolder } from '@arclight/shared';
import { formatSize } from '../../../lib/format.js';
import { t } from '../../../i18n/index.js';

// Pure helpers for System → Stats: storage meters, bucket shares and the chart geometry.

/** Below this share of free space a root folder's meter turns orange (needs attention). */
export const LOW_FREE_RATIO = 0.1;

export interface RootUsage {
  /** Used share of the volume, 0–100 (null when the volume size is unknown). */
  usedPct: number | null;
  tone: 'default' | 'warn';
  /** "1.2 TiB free of 4.0 TiB" or "Not reachable". */
  text: string;
}

export function rootUsage(root: Pick<StatsRootFolder, 'accessible' | 'totalBytes' | 'freeBytes'>): RootUsage {
  if (!root.accessible) return { usedPct: null, tone: 'warn', text: t('common.notReachable') };
  if (root.totalBytes == null || root.freeBytes == null || root.totalBytes <= 0) return { usedPct: null, tone: 'default', text: t('system.stats.volumeSizeUnknown') };
  const used = Math.max(0, root.totalBytes - root.freeBytes);
  const usedPct = Math.min(100, (used / root.totalBytes) * 100);
  const low = root.freeBytes / root.totalBytes < LOW_FREE_RATIO;
  return { usedPct, tone: low ? 'warn' : 'default', text: t('system.stats.sizeFreeOfSize2', { size: formatSize(root.freeBytes), size2: formatSize(root.totalBytes) }) };
}

export interface BucketShare {
  key: string;
  label: string;
  count: number;
  sizeBytes: number;
  /** Share of the total size, 0–100. */
  pct: number;
}

/** Buckets largest first with their share of the total size; empty buckets are dropped. */
export function bucketShares(buckets: readonly StatsBucket[]): BucketShare[] {
  const total = buckets.reduce((n, b) => n + b.sizeBytes, 0);
  return buckets
    .filter((b) => b.count > 0 || b.sizeBytes > 0)
    .map((b) => ({ key: b.key, label: b.key || t('system.stats.unknown'), count: b.count, sizeBytes: b.sizeBytes, pct: total > 0 ? (b.sizeBytes / total) * 100 : 0 }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes || b.count - a.count);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * One entry per UTC day from `since` for `days` days; days the api left out count as zero.
 * Keeps the chart's x axis evenly spaced.
 */
export function fillDays(perDay: readonly ActivityDay[], since: string, days: number): ActivityDay[] {
  const byDate = new Map(perDay.map((d) => [d.date.slice(0, 10), d]));
  const start = new Date(`${since.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return [...perDay];
  const out: ActivityDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = isoDay(new Date(start.getTime() + i * 86_400_000));
    out.push(byDate.get(date) ?? { date, grabbed: 0, imported: 0, failed: 0 });
  }
  return out;
}

export type ActivityMetric = 'grabbed' | 'imported' | 'failed';

export interface GroupedBar {
  date: string;
  metric: ActivityMetric;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Largest single value across the metrics (the y-axis top). */
export function activityMax(days: readonly ActivityDay[], metrics: readonly ActivityMetric[]): number {
  return Math.max(1, ...days.flatMap((d) => metrics.map((m) => d[m])));
}

/** Grouped bars: one slot per day, one bar per metric inside it, scaled to the largest value. */
export function groupedBars(days: readonly ActivityDay[], metrics: readonly ActivityMetric[], width: number, height: number, gap = 2): GroupedBar[] {
  if (days.length === 0 || metrics.length === 0) return [];
  const max = activityMax(days, metrics);
  const slot = width / days.length;
  const inner = Math.max(metrics.length, slot - gap);
  const barWidth = inner / metrics.length;
  return days.flatMap((d, i) =>
    metrics.map((metric, j) => {
      const h = (d[metric] / max) * height;
      return { date: d.date, metric, value: d[metric], x: i * slot + gap / 2 + j * barWidth, y: height - h, width: barWidth, height: h };
    }),
  );
}

/** SVG path through `values`, spread over `width`, scaled between their min and max. */
export function seriesPath(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = values.length > 1 ? i * step : width / 2;
      const y = max === min ? height / 2 : height - ((v - min) / span) * height;
      return `${i === 0 ? 'M' : 'L'}${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
    })
    .join(' ');
}

/** "+12.4 GiB", "−3.0 GiB", "No change", or "—" without a baseline. */
export function formatDelta(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes === 0) return t('system.stats.noChange');
  return `${bytes > 0 ? '+' : '−'}${formatSize(Math.abs(bytes))}`;
}
