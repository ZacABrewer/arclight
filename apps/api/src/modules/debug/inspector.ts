import type { Runtime } from 'node:inspector';
import { Session } from 'node:inspector/promises';

// In-process V8 inspector probes: a forced GC and a census of every live ArrayBuffer
// (Runtime.queryObjects on ArrayBuffer.prototype). The inspector session talks to this same
// isolate; node:inspector/promises answers these domains without a second thread. One probe at
// a time: concurrent console runs queue behind each other.

let chain: Promise<unknown> = Promise.resolve();

async function withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const session = new Session();
    session.connect();
    try {
      return await fn(session);
    } finally {
      session.disconnect();
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

async function collectGarbage(s: Session): Promise<void> {
  await s.post('HeapProfiler.enable');
  try {
    await s.post('HeapProfiler.collectGarbage');
  } finally {
    await s.post('HeapProfiler.disable');
  }
}

/** Forces a full GC through the inspector (works without --expose-gc). */
export function forceGc(): Promise<void> {
  return withSession(collectGarbage);
}

export interface BufferGroup {
  size: number;
  /** First 4 bytes as hex: the grouping key next to the size. */
  head: string;
  count: number;
  totalBytes: number;
  /** First 12 bytes of one buffer in the group, as hex. */
  sampleHex: string;
}

export interface BufferBucket {
  label: string;
  count: number;
  totalBytes: number;
}

export interface BufferCensus {
  count: number;
  totalBytes: number;
  detached: number;
  buckets: BufferBucket[];
  /** Top groups by total bytes. */
  groups: BufferGroup[];
}

/**
 * Runs inside the isolate with `this` bound to the array queryObjects returned. A plain string
 * (not fn.toString()) so no bundler or test transform can rewrite it.
 */
const CENSUS_FN = `function (topN) {
  const LIMITS = [1024, 16384, 65536, 262144, 1048576, 16777216, Infinity];
  const LABELS = ['< 1 KiB', '1-16 KiB', '16-64 KiB', '64-256 KiB', '256 KiB-1 MiB', '1-16 MiB', '>= 16 MiB'];
  const buckets = LABELS.map(function (label) { return { label: label, count: 0, totalBytes: 0 }; });
  const groups = new Map();
  let total = 0;
  let detached = 0;
  for (let n = 0; n < this.length; n++) {
    const ab = this[n];
    let size = 0;
    try { size = ab.byteLength; } catch (e) { size = 0; }
    if (size === 0 && ab.detached === true) detached++;
    total += size;
    let i = 0;
    while (size >= LIMITS[i]) i++;
    buckets[i].count++;
    buckets[i].totalBytes += size;
    let sample = '';
    if (size > 0) {
      try {
        const bytes = new Uint8Array(ab, 0, Math.min(12, size));
        for (let k = 0; k < bytes.length; k++) sample += bytes[k].toString(16).padStart(2, '0');
      } catch (e) { sample = ''; }
    }
    const head = sample.slice(0, 8);
    const key = size + '|' + head;
    const g = groups.get(key);
    if (g) { g.count++; g.totalBytes += size; }
    else groups.set(key, { size: size, head: head, count: 1, totalBytes: size, sampleHex: sample });
  }
  const top = Array.from(groups.values())
    .sort(function (a, b) { return b.totalBytes - a.totalBytes || b.count - a.count; })
    .slice(0, topN);
  return JSON.stringify({
    count: this.length,
    totalBytes: total,
    detached: detached,
    buckets: buckets.filter(function (b) { return b.count > 0; }),
    groups: top,
  });
}`;

/** GC, then count and group every ArrayBuffer still reachable. */
export function arrayBufferCensus(topN = 15): Promise<BufferCensus> {
  return withSession(async (s) => {
    await collectGarbage(s);
    const group = 'arclight-debug-census';
    try {
      const proto = await s.post('Runtime.evaluate', { expression: 'ArrayBuffer.prototype', objectGroup: group });
      const protoId = proto.result.objectId;
      if (!protoId) throw new Error('could not resolve ArrayBuffer.prototype');
      const found = (await s.post('Runtime.queryObjects', { prototypeObjectId: protoId, objectGroup: group })) as unknown as Runtime.QueryObjectsReturnType;
      const arrayId = found.objects.objectId;
      if (!arrayId) throw new Error('queryObjects returned no array');
      const res = (await s.post('Runtime.callFunctionOn', {
        objectId: arrayId,
        functionDeclaration: CENSUS_FN,
        arguments: [{ value: topN }],
        returnByValue: true,
        objectGroup: group,
      })) as unknown as Runtime.CallFunctionOnReturnType;
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
      return JSON.parse(String(res.result.value)) as BufferCensus;
    } finally {
      await s.post('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
    }
  });
}
