import type { MetricAnnotation, MetricsRange, QueueSeverity, VpnMetricPoint } from '@arclight/shared';

// Pure geometry and summaries for the transfer history charts (transfer-charts.tsx).

/** One chart sample: download/upload rates in bytes/s and an optional secondary value (peers). */
export interface RatePoint {
  time: string;
  down: number;
  up: number;
  aux?: number | undefined;
}

/** X position of a time inside [fromMs, toMs] mapped onto [0, width]. */
export function timeX(time: string | number, fromMs: number, toMs: number, width: number): number {
  const ms = typeof time === 'number' ? time : Date.parse(time);
  const span = Math.max(1, toMs - fromMs);
  return Math.min(width, Math.max(0, ((ms - fromMs) / span) * width));
}

/**
 * SVG path through the points, starting a new sub-path ("M") wherever two neighbours are more
 * than 1.5 steps apart, so time with no samples shows as a gap rather than a straight line.
 */
export function gapPath<P extends { time: string }>(
  points: readonly P[],
  value: (p: P) => number,
  x: (p: P) => number,
  y: (v: number) => number,
  stepMs: number,
): string {
  let d = '';
  let prev: number | null = null;
  for (const p of points) {
    const ms = Date.parse(p.time);
    const cmd = prev === null || ms - prev > stepMs * 1.5 ? 'M' : 'L';
    d += `${d ? ' ' : ''}${cmd}${round(x(p))} ${round(y(value(p)))}`;
    prev = ms;
  }
  return d;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Smallest 1/2/5 × 10^k at or above `n` (at least `floor`), for a tidy axis maximum. */
export function niceCeil(n: number, floor = 1): number {
  const v = Math.max(floor, n);
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) if (m * base >= v) return m * base;
  return 10 * base;
}

export interface RateSummary {
  avgDown: number;
  peakDown: number;
  avgUp: number;
  peakUp: number;
  peakAux: number | null;
  /** Points with any traffic or a secondary value. */
  points: number;
}

/** Averages and peaks over the window; null when there are no points. */
export function summarizeRates(points: readonly RatePoint[]): RateSummary | null {
  if (points.length === 0) return null;
  let down = 0;
  let up = 0;
  let peakDown = 0;
  let peakUp = 0;
  let peakAux: number | null = null;
  for (const p of points) {
    down += p.down;
    up += p.up;
    peakDown = Math.max(peakDown, p.down);
    peakUp = Math.max(peakUp, p.up);
    if (p.aux !== undefined) peakAux = Math.max(peakAux ?? 0, p.aux);
  }
  return { avgDown: down / points.length, peakDown, avgUp: up / points.length, peakUp, peakAux, points: points.length };
}

const SEVERITY_RANK: Readonly<Record<QueueSeverity, number>> = { ok: 0, info: 1, warning: 2, error: 3 };

export interface MarkerCluster {
  x: number;
  time: string;
  severity: QueueSeverity;
  items: MetricAnnotation[];
}

/** Annotations grouped when closer than `minGapPx` on the x axis; a cluster takes its worst severity. */
export function clusterAnnotations(
  annotations: readonly MetricAnnotation[],
  fromMs: number,
  toMs: number,
  width: number,
  minGapPx = 6,
): MarkerCluster[] {
  const out: MarkerCluster[] = [];
  const sorted = [...annotations].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  for (const a of sorted) {
    const ms = Date.parse(a.time);
    if (ms < fromMs || ms > toMs) continue;
    const x = timeX(ms, fromMs, toMs, width);
    const last = out[out.length - 1];
    if (last && x - last.x < minGapPx) {
      last.items.push(a);
      if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[last.severity]) last.severity = a.severity;
      continue;
    }
    out.push({ x, time: a.time, severity: a.severity, items: [a] });
  }
  return out;
}

export type VpnState = 'up' | 'warning' | 'down';

/** A step is down when the VPN was down for at least half its samples, warning when anything was off. */
export function vpnState(p: Pick<VpnMetricPoint, 'connected' | 'killSwitch' | 'warning'>): VpnState {
  if (p.connected < 0.5) return 'down';
  if (p.connected < 1 || p.killSwitch > 0 || p.warning > 0) return 'warning';
  return 'up';
}

export interface VpnSegment {
  state: VpnState;
  startMs: number;
  endMs: number;
}

/** Consecutive steps of the same state merged into segments; gaps between points stay empty. */
export function vpnSegments(points: readonly VpnMetricPoint[], stepMs: number): VpnSegment[] {
  const out: VpnSegment[] = [];
  for (const p of points) {
    const startMs = Date.parse(p.time);
    const state = vpnState(p);
    const last = out[out.length - 1];
    if (last && last.state === state && last.endMs === startMs) last.endMs = startMs + stepMs;
    else out.push({ state, startMs, endMs: startMs + stepMs });
  }
  return out;
}

/** Milliseconds per state among sampled steps. */
export function vpnTotals(segments: readonly VpnSegment[]): Record<VpnState, number> {
  const totals: Record<VpnState, number> = { up: 0, warning: 0, down: 0 };
  for (const s of segments) totals[s.state] += s.endMs - s.startMs;
  return totals;
}

/** Axis label for a time: hours and minutes up to a day, day and hour for a week. */
export function formatAxisTime(ms: number, range: MetricsRange, locale?: string): string {
  const opts: Intl.DateTimeFormatOptions =
    range === '7d' ? { weekday: 'short', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat(locale, opts).format(ms);
}
