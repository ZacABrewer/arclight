import type { IndexerStatsDay } from '@arclight/shared';

// Geometry for the indexer stats charts (plain SVG, no chart library). Pure so it is testable.

export interface Bar {
  label: string;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Vertical bars scaled to the largest value; zero values get no height. */
export function barLayout(items: readonly { label: string; value: number }[], width: number, height: number, gap = 8): Bar[] {
  if (items.length === 0) return [];
  const max = Math.max(1, ...items.map((i) => i.value));
  const slot = width / items.length;
  const barWidth = Math.max(1, slot - gap);
  return items.map((item, i) => {
    const h = (item.value / max) * height;
    return { label: item.label, value: item.value, x: i * slot + gap / 2, y: height - h, width: barWidth, height: h };
  });
}

export type DayMetric = 'queries' | 'grabs' | 'failures';

/** SVG path (`M x y L ...`) of one daily series across the chart width. */
export function linePath(days: readonly IndexerStatsDay[], metric: DayMetric, width: number, height: number, max?: number): string {
  if (days.length === 0) return '';
  const top = Math.max(1, max ?? Math.max(...days.map((d) => d[metric])));
  const step = days.length > 1 ? width / (days.length - 1) : 0;
  return days
    .map((d, i) => {
      const x = days.length > 1 ? i * step : width / 2;
      const y = height - (d[metric] / top) * height;
      return `${i === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`;
    })
    .join(' ');
}

/** Largest value of any of the metrics, so several lines share one scale. */
export function seriesMax(days: readonly IndexerStatsDay[], metrics: readonly DayMetric[]): number {
  let max = 0;
  for (const d of days) for (const m of metrics) max = Math.max(max, d[m]);
  return Math.max(1, max);
}

/** Failures as a share of queries + grabs, e.g. `4.2%`; `—` without traffic. */
export function failureRate(e: { queries: number; grabs: number; failures: number }): string {
  const total = e.queries + e.grabs;
  if (total === 0) return '—';
  return `${Math.round((e.failures / total) * 1000) / 10}%`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Evenly spaced whole-number axis ticks from 0 to `max` (at most `count` + 1, no repeats). */
export function axisTicks(max: number, count = 4): number[] {
  const top = Math.max(1, Math.ceil(max));
  const ticks = new Set<number>();
  for (let i = 0; i <= count; i++) ticks.add(Math.round((top * i) / count));
  return [...ticks].sort((a, b) => a - b);
}

/** Closed area path under a line path, down to the baseline (for a faint ≤12% fill). */
export function areaPath(line: string, width: number, height: number, points: number): string {
  if (!line) return '';
  const lastX = points > 1 ? width : width / 2;
  const firstX = points > 1 ? 0 : width / 2;
  return `${line} L${lastX} ${height} L${firstX} ${height} Z`;
}
