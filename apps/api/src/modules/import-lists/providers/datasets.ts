import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { ImportListFetchError } from '../errors.js';
import { request } from './http.js';
import type { DatasetCache, FetchLike } from './types.js';

// Large, slowly changing downloads (the anime id mapping, IMDb's ratings dataset) are fetched at
// most once per max age and kept on disk under <config>/cache/import-lists, so a restart does not
// download them again and a failed refresh falls back to the last good copy.

interface Meta {
  fetchedAt: number;
  etag?: string;
}

interface Entry {
  data: Buffer;
  meta: Meta;
}

export interface DatasetCacheOptions {
  fetch: FetchLike;
  log: Logger;
  now: () => Date;
  /** Directory for the on-disk copies; null keeps them in memory only. */
  dir: string | null;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

export function createDatasetCache(opts: DatasetCacheOptions): DatasetCache {
  const memory = new Map<string, Entry>();
  const inflight = new Map<string, Promise<Buffer>>();

  const readDisk = async (name: string): Promise<Entry | null> => {
    if (!opts.dir) return null;
    try {
      const [data, meta] = await Promise.all([
        readFile(join(opts.dir, name)),
        readFile(join(opts.dir, `${name}.meta.json`), 'utf8').then((t) => JSON.parse(t) as Meta),
      ]);
      return typeof meta.fetchedAt === 'number' ? { data, meta } : null;
    } catch {
      return null;
    }
  };

  const writeDisk = async (name: string, entry: Entry): Promise<void> => {
    if (!opts.dir) return;
    try {
      await mkdir(opts.dir, { recursive: true });
      const tmp = join(opts.dir, `${name}.tmp`);
      await writeFile(tmp, entry.data);
      await rename(tmp, join(opts.dir, name));
      await writeFile(join(opts.dir, `${name}.meta.json`), JSON.stringify(entry.meta));
    } catch (err) {
      opts.log.warn({ err, name }, 'could not write import-list dataset cache');
    }
  };

  const load = async (name: string, url: string, maxAgeMs: number, signal?: AbortSignal): Promise<Buffer> => {
    const nowMs = opts.now().getTime();
    const cached = memory.get(name) ?? (await readDisk(name));
    if (cached) memory.set(name, cached);
    if (cached && nowMs - cached.meta.fetchedAt < maxAgeMs) return cached.data;
    try {
      const headers: Record<string, string> = {};
      if (cached?.meta.etag) headers['If-None-Match'] = cached.meta.etag;
      const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
      const res = await opts
        .fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
        .catch((cause: unknown) => {
          throw new ImportListFetchError('unreachable', `${name} download failed`, { cause });
        });
      if (res.status === 304 && cached) {
        const entry = { data: cached.data, meta: { ...cached.meta, fetchedAt: nowMs } };
        memory.set(name, entry);
        await writeDisk(name, entry);
        return entry.data;
      }
      // Reuse the shared status mapping for errors.
      if (!res.ok) await request({ fetch: async () => res }, name, url);
      const data = Buffer.from(await res.arrayBuffer());
      const etag = res.headers.get('etag');
      const entry: Entry = { data, meta: { fetchedAt: nowMs, ...(etag ? { etag } : {}) } };
      memory.set(name, entry);
      await writeDisk(name, entry);
      opts.log.info({ name, bytes: data.length }, 'downloaded import-list dataset');
      return data;
    } catch (err) {
      if (cached) {
        opts.log.warn({ err, name }, 'dataset refresh failed; using the cached copy');
        return cached.data;
      }
      if (err instanceof ImportListFetchError) throw err;
      throw new ImportListFetchError('unreachable', `${name} download failed`, { cause: err });
    }
  };

  return {
    get(name, url, { maxAgeMs, signal }) {
      // Several lists syncing at once share one download.
      let p = inflight.get(name);
      if (!p) {
        p = load(name, url, maxAgeMs, signal).finally(() => inflight.delete(name));
        inflight.set(name, p);
      }
      return p;
    },
  };
}
