import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';

// How fast the box can encode, and whether one more HLS job fits. Each job class (pipeline,
// source class, output rung) has a single-job speed: the median of measured runs (recorded only
// when the job had its resource to itself for 30 s or more), else a seed from the 0.24
// measurements. Jobs on one resource (the CPU, or the GPU) share it: with single speeds s_i the
// jobs run together at about 1 / Σ(1 / s_i) each. A rung is offered only when that stays ≥ 1.3x
// for every job on the resource, the new one included. Copy jobs cost (almost) nothing.

export const SAFE_SPEED = 1.3;

export type CapacityPipeline = 'qsv' | 'vaapi' | 'software' | 'nvenc' | 'videotoolbox';
export type CapacityResource = 'cpu' | 'gpu';

export interface JobClass {
  pipeline: CapacityPipeline;
  /** Decode on the GPU (qsv/vaapi only). */
  hwDecode: boolean;
  srcCodec: string;
  srcHeight: number;
  srcHdr: boolean;
  outHeight: number;
  outCodec: 'h264' | 'hevc';
  tonemap: boolean;
  /** Software tone-map with tonemapx (else the slower zscale chain). */
  tonemapx: boolean;
  burn: boolean;
}

export const resourceOf = (jc: Pick<JobClass, 'pipeline'>): CapacityResource => (jc.pipeline === 'software' ? 'cpu' : 'gpu');

const heightClass = (h: number) => (h > 1440 ? 2160 : h > 800 ? 1080 : h > 600 ? 720 : 480);

/** The history key: jobs with the same key cost the same. */
export function jobKey(jc: JobClass): string {
  return [jc.pipeline, jc.hwDecode ? 'hd' : 'sd', jc.srcCodec, heightClass(jc.srcHeight), jc.srcHdr ? 'hdr' : 'sdr', jc.outHeight, jc.outCodec, jc.tonemap ? 'tm' : '', jc.burn ? 'burn' : ''].join('|');
}

/** CPU size relative to the 4 vCPU the seeds were measured on (capped: x264 does not scale forever). */
export function cpuFactor(cpus = availableParallelism()): number {
  return Math.min(2, Math.max(0.25, cpus / 4));
}

/**
 * Seed speed (media s per wall s) of one job alone, or null when there is no safe guess (2160
 * outputs: offered only once measured). Software figures are libx264 veryfast at 4 vCPU (§2.2);
 * GPU figures are conservative estimates for an i3-1315U class iGPU until the NAS probe replaces them.
 */
export function seedSpeed(jc: JobClass, cpus = availableParallelism()): number | null {
  if (jc.outHeight > 1440) return null;
  if (jc.pipeline === 'software') {
    const byHeight: Record<number, number> = { 1080: 2.6, 720: 5.8, 480: 9, 360: 12 };
    let s = byHeight[jc.outHeight] ?? (jc.outHeight > 720 ? 2.6 : jc.outHeight > 480 ? 5.8 : 9);
    // A 4K source costs its decode and the downscale; tone-mapping costs more (tonemapx 4K HDR → 1080 = 1.2x).
    if (jc.srcHeight > 1440) s *= jc.outHeight >= 1080 ? 0.6 : 0.5;
    if (jc.srcHdr && jc.tonemap) s *= jc.tonemapx ? 0.75 : 0.4;
    if (jc.burn) s /= 2.5;
    return round2(s * cpuFactor(cpus));
  }
  let s = jc.outHeight >= 1080 ? (jc.srcHeight > 1440 ? 5 : 8) : jc.outHeight >= 720 ? 10 : 12;
  if (jc.pipeline === 'nvenc' || jc.pipeline === 'videotoolbox') s *= 0.6; // filters on the CPU
  if ((jc.pipeline === 'qsv' || jc.pipeline === 'vaapi') && !jc.hwDecode) s *= 0.5; // software decode + upload
  if (jc.burn) s *= 0.8;
  return round2(s);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Speed of jobs sharing one resource (time-sliced): 1 / Σ(1 / s_i). */
export function sharedSpeed(singles: readonly number[]): number {
  if (singles.length === 0) return Infinity;
  return 1 / singles.reduce((acc, s) => acc + 1 / Math.max(s, 0.01), 0);
}

export interface CapacityOptions {
  /** configDir/cache/player/capacity.json (null: memory only). */
  file: string | null;
  cpus?: number;
}

const HISTORY_RUNS = 9;

export class CapacityModel {
  private history = new Map<string, number[]>();
  private readonly running = new Map<string, JobClass>();
  private loaded: Promise<void> | null = null;

  constructor(private readonly opts: CapacityOptions) {}

  async load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.opts.file) return;
      try {
        const raw = JSON.parse(await readFile(this.opts.file, 'utf8')) as { v?: number; history?: Record<string, unknown> };
        if (raw.v !== 1 || !raw.history) return;
        for (const [k, v] of Object.entries(raw.history)) {
          if (Array.isArray(v)) this.history.set(k, v.filter((x): x is number => typeof x === 'number' && x > 0).slice(-HISTORY_RUNS));
        }
      } catch {
        // no history yet
      }
    })();
    return this.loaded;
  }

  /** Single-job speed and whether it was measured here. */
  single(jc: JobClass): { speed: number | null; measured: boolean } {
    const runs = this.history.get(jobKey(jc));
    if (runs && runs.length > 0) return { speed: round2(median(runs)), measured: true };
    return { speed: seedSpeed(jc, this.opts.cpus), measured: false };
  }

  /** A measured run of a job that had its resource to itself. */
  async record(jc: JobClass, speed: number): Promise<void> {
    if (!(speed > 0) || !Number.isFinite(speed)) return;
    const key = jobKey(jc);
    const runs = [...(this.history.get(key) ?? []), round2(speed)].slice(-HISTORY_RUNS);
    this.history.set(key, runs);
    if (!this.opts.file) return;
    try {
      await mkdir(dirname(this.opts.file), { recursive: true });
      const tmp = `${this.opts.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ v: 1, history: Object.fromEntries(this.history) }));
      await rename(tmp, this.opts.file).catch(async () => rm(tmp, { force: true }));
    } catch {
      // the next run records again
    }
  }

  /** A job starts (`id` = session id): it now shares its resource. */
  begin(id: string, jc: JobClass): void {
    this.running.set(id, jc);
  }

  end(id: string): void {
    this.running.delete(id);
  }

  /** Other jobs on the same resource as `jc` (excluding `exceptId`). */
  othersOn(resource: CapacityResource, exceptId?: string): JobClass[] {
    return [...this.running.entries()].filter(([id, j]) => id !== exceptId && resourceOf(j) === resource).map(([, j]) => j);
  }

  /**
   * Predicted speed of `jc` with the running jobs (the session's own job, `exceptId`, is replaced
   * by it). Null: no estimate (not offered).
   */
  predict(jc: JobClass, exceptId?: string): { speed: number | null; measured: boolean } {
    const mine = this.single(jc);
    if (mine.speed === null) return mine;
    const singles = [mine.speed];
    for (const other of this.othersOn(resourceOf(jc), exceptId)) {
      const s = this.single(other).speed;
      if (s !== null) singles.push(s);
    }
    return { speed: round2(sharedSpeed(singles)), measured: mine.measured };
  }
}
