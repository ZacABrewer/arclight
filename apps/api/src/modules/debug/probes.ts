import { readFileSync } from 'node:fs';
import type { DebugCgroup, DebugHandleGroup, DebugHandles } from '@arclight/shared';

// Low-level process probes for the debug console: cgroup memory, active handles.

export type ReadText = (path: string) => string | null;

export const readTextFile: ReadText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

function num(text: string | null): number | null {
  if (text === null) return null;
  const v = Number(text.trim());
  return Number.isFinite(v) ? v : null;
}

function statField(stat: string | null, ...names: string[]): number | null {
  if (!stat) return null;
  for (const name of names) {
    const m = new RegExp(`^${name} (\\d+)$`, 'm').exec(stat);
    if (m) return Number(m[1]);
  }
  return null;
}

/** cgroup v1 reports "no limit" as a huge page-aligned number. */
const V1_UNLIMITED = 2 ** 60;

/**
 * Container memory limit and usage. cgroup v2 (`/sys/fs/cgroup/memory.max`, `memory.current`,
 * `memory.stat` anon/file), then cgroup v1 (`/sys/fs/cgroup/memory/memory.limit_in_bytes`, ...).
 * Every field is null when nothing is readable (Windows, macOS, no cgroup mount).
 */
export function readCgroup(read: ReadText = readTextFile): DebugCgroup {
  const max = read('/sys/fs/cgroup/memory.max');
  const current = read('/sys/fs/cgroup/memory.current');
  if (max !== null || current !== null) {
    const stat = read('/sys/fs/cgroup/memory.stat');
    return {
      version: 2,
      limit: max === null || max.trim() === 'max' ? null : num(max),
      usage: num(current),
      anon: statField(stat, 'anon'),
      file: statField(stat, 'file'),
    };
  }
  const base = '/sys/fs/cgroup/memory';
  const limit = num(read(`${base}/memory.limit_in_bytes`));
  const usage = num(read(`${base}/memory.usage_in_bytes`));
  if (limit !== null || usage !== null) {
    const stat = read(`${base}/memory.stat`);
    return {
      version: 1,
      limit: limit !== null && limit < V1_UNLIMITED ? limit : null,
      usage,
      anon: statField(stat, 'total_rss', 'rss'),
      file: statField(stat, 'total_cache', 'cache'),
    };
  }
  return { version: null, limit: null, usage: null, anon: null, file: null };
}

export type ActiveHandles = () => readonly unknown[] | undefined;

/** process._getActiveHandles() when the runtime has it (undocumented, but present in Node 24). */
export const activeHandles: ActiveHandles = () => {
  const fn = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  return typeof fn === 'function' ? fn.call(process) : undefined;
};

function typeName(h: unknown): string {
  if (h === null || typeof h !== 'object') return typeof h;
  const name = (h as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name !== '' ? name : 'Object';
}

function queued(h: unknown): number {
  if (h === null || typeof h !== 'object') return 0;
  try {
    const v = (h as { writableLength?: unknown }).writableLength;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** Active handles by constructor name with the bytes queued for writing. */
export function handleCensus(get: ActiveHandles = activeHandles): DebugHandles {
  const list = get();
  if (!list) return { available: false, total: 0, queuedBytes: 0, byType: [] };
  const groups = new Map<string, DebugHandleGroup>();
  let total = 0;
  for (const h of list) {
    const type = typeName(h);
    const q = queued(h);
    const g = groups.get(type) ?? { type, count: 0, queuedBytes: 0, maxQueuedBytes: 0 };
    g.count++;
    g.queuedBytes += q;
    g.maxQueuedBytes = Math.max(g.maxQueuedBytes, q);
    groups.set(type, g);
    total += q;
  }
  const byType = [...groups.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  return { available: true, total: list.length, queuedBytes: total, byType };
}
