// Bucketing for transfer history: folds sample-weighted points into wider steps (minutes into
// hours for roll-ups, minutes into 5-minute steps for a 24 h chart). Pure; no database.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** How a field combines across points: sample-weighted mean, maximum, or the latest value. */
export type FieldMode = 'avg' | 'max' | 'last';

export interface Weighted {
  /** ISO-8601 start of the point. */
  time: string;
  /** Samples the point averages (its weight). */
  samples: number;
}

export function floorTo(ms: number, stepMs: number): number {
  return Math.floor(ms / stepMs) * stepMs;
}

export function isoFloor(ms: number, stepMs: number): string {
  return new Date(floorTo(ms, stepMs)).toISOString();
}

/**
 * Groups `points` (oldest first) into buckets of `stepMs` starting at multiples of the step.
 * Fields named in `modes` are combined; any other field keeps the bucket's first value (keys
 * such as a tracked download id). A bucket's `time` is its start, `samples` the sum.
 */
export function bucketize<T extends Weighted>(points: readonly T[], stepMs: number, modes: Partial<Record<keyof T, FieldMode>>): T[] {
  const out: T[] = [];
  const fields = Object.entries(modes) as [keyof T & string, FieldMode][];
  let current: { start: number; acc: Record<string, unknown>; weight: number } | null = null;
  const finish = () => {
    if (!current) return;
    const row: Record<string, unknown> = { ...current.acc, time: new Date(current.start).toISOString(), samples: current.weight };
    for (const [key, mode] of fields) {
      if (mode === 'avg') row[key] = current.weight > 0 ? (current.acc[key] as number) / current.weight : 0;
    }
    out.push(row as T);
  };
  for (const p of points) {
    const start = floorTo(Date.parse(p.time), stepMs);
    const weight = Math.max(0, p.samples);
    if (!current || current.start !== start) {
      finish();
      const acc: Record<string, unknown> = { ...(p as unknown as Record<string, unknown>) };
      for (const [key, mode] of fields) if (mode === 'avg') acc[key] = ((p[key] as number | null) ?? 0) * weight;
      current = { start, acc, weight };
      continue;
    }
    for (const [key, mode] of fields) {
      const value = p[key] as number | null;
      if (mode === 'avg') current.acc[key] = (current.acc[key] as number) + (value ?? 0) * weight;
      else if (mode === 'max') current.acc[key] = Math.max(current.acc[key] as number, value ?? 0);
      else current.acc[key] = value;
    }
    current.weight += weight;
  }
  finish();
  return out;
}

/** Sample-weighted mean of one field across points; null when there are no samples. */
export function weightedMean<T extends Weighted>(points: readonly T[], field: keyof T): number | null {
  let sum = 0;
  let weight = 0;
  for (const p of points) {
    sum += ((p[field] as number | null) ?? 0) * p.samples;
    weight += p.samples;
  }
  return weight > 0 ? sum / weight : null;
}
