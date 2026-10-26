import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AgentClient, AgentFile, AgentTorrent } from '@arclight/engine-agent';

// Pull mode: finished downloads are copied from the agent into a local folder over HTTP
// range requests, verified against the agent's SHA-256, and only then reported as completed
// (at their local path), so the importer sees an ordinary finished download.

/** Folder (inside the local download path) holding one manifest per fetched torrent. */
export const PULL_STATE_DIR = '.arclight-pull';
/** Suffix of a file still being copied. */
export const PART_SUFFIX = '.arclight-part';

export type PullState = 'queued' | 'fetching' | 'verifying' | 'failed';

export interface PullProgress {
  state: PullState;
  bytesDone: number;
  totalBytes: number;
  /** Bytes/s over the current transfer. */
  rate: number;
  attempts: number;
  error?: string;
  /** Epoch ms before which a failed pull is not retried. */
  retryAt?: number;
}

/** Written once every file is copied and verified; its presence means "fetched". */
export interface PullManifest {
  version: 1;
  id: string;
  name: string;
  /** Local payload root (directory for multi-file torrents, the file for single-file ones). */
  contentPath: string;
  files: Array<{ index: number; path: string; length: number; sha256: string }>;
  completedAt: string;
}

export interface PullManagerOptions {
  client: AgentClient;
  root: string;
  /** Transfer limit in bytes/s; 0 = unlimited. Read per chunk so changes apply at once. */
  bandwidthBps?: () => number;
  /** Torrents copied at the same time. Default 2. */
  concurrency?: number;
  /** First retry delay after a failure; doubled per attempt up to 10 min. Default 30 s. */
  retryBaseMs?: number;
  now?: () => number;
}

const MAX_RETRY_MS = 10 * 60_000;

/** Local path for a protocol file path ('/'-separated, starting with the torrent name). */
export function localPathFor(root: string, protocolPath: string): string {
  const segments = protocolPath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || /^[a-zA-Z]:$/.test(s))) {
    throw new Error(`Refusing unsafe file path from the agent: ${protocolPath}`);
  }
  return join(root, ...segments);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Copies completed torrents from one agent into one local folder. */
export class PullManager {
  private readonly progressById = new Map<string, PullProgress>();
  private readonly jobs = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly waiting: Array<{ torrent: AgentTorrent; start: () => void }> = [];
  private readonly manifests = new Map<string, PullManifest | null>();
  private active = 0;
  private client: AgentClient;
  private bandwidth: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: PullManagerOptions) {
    this.client = opts.client;
    this.bandwidth = opts.bandwidthBps ?? (() => 0);
    this.now = opts.now ?? Date.now;
  }

  /** Swaps the agent client and bandwidth limit (settings changed) without losing transfers. */
  configure(options: Pick<PullManagerOptions, 'client' | 'bandwidthBps'>): void {
    this.client = options.client;
    this.bandwidth = options.bandwidthBps ?? (() => 0);
  }

  get root(): string {
    return this.opts.root;
  }

  private manifestPath(id: string): string {
    return join(this.opts.root, PULL_STATE_DIR, `${id}.json`);
  }

  /** The manifest of a fetched torrent, or null. Authoritative even after the importer moved the files. */
  async manifest(id: string): Promise<PullManifest | null> {
    if (this.manifests.has(id)) return this.manifests.get(id) ?? null;
    let value: PullManifest | null = null;
    try {
      const raw = JSON.parse(await readFile(this.manifestPath(id), 'utf8')) as PullManifest;
      if (raw.version === 1 && raw.id === id) value = raw;
    } catch {
      value = null;
    }
    // Only cache hits: a miss may turn into a hit once a job finishes (which caches it itself).
    if (value) this.manifests.set(id, value);
    return value;
  }

  progress(id: string): PullProgress | undefined {
    return this.progressById.get(id);
  }

  isRunning(id: string): boolean {
    return this.jobs.has(id);
  }

  /** Starts (or queues) copying a complete torrent unless it is fetched, running or backing off. */
  ensure(torrent: AgentTorrent): void {
    const id = torrent.id;
    if (this.jobs.has(id) || this.manifests.get(id)) return;
    const p = this.progressById.get(id);
    if (p?.state === 'queued') return;
    if (p?.state === 'failed' && p.retryAt !== undefined && this.now() < p.retryAt) return;
    const abort = new AbortController();
    let release!: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    this.progressById.set(id, {
      state: 'queued',
      bytesDone: 0,
      totalBytes: torrent.wantedBytes || torrent.totalBytes,
      rate: 0,
      attempts: p?.attempts ?? 0,
    });
    const done = (async () => {
      await started;
      try {
        if (abort.signal.aborted) throw abort.signal.reason;
        await this.run(torrent, abort.signal);
      } catch (error) {
        const prev = this.progressById.get(id);
        if (abort.signal.aborted) {
          this.progressById.delete(id);
        } else if (prev) {
          const attempts = prev.attempts + 1;
          this.progressById.set(id, {
            ...prev,
            state: 'failed',
            rate: 0,
            attempts,
            error: error instanceof Error ? error.message : String(error),
            retryAt: this.now() + Math.min(MAX_RETRY_MS, (this.opts.retryBaseMs ?? 30_000) * 2 ** (attempts - 1)),
          });
        }
      } finally {
        this.jobs.delete(id);
        this.active--;
        this.next();
      }
    })();
    this.jobs.set(id, { abort, done });
    this.waiting.push({ torrent, start: release });
    this.next();
  }

  private next(): void {
    const limit = this.opts.concurrency ?? 2;
    while (this.active < limit && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      this.active++;
      job.start();
    }
  }

  /** Waits for a running copy (tests, shutdown). */
  async settle(id: string): Promise<void> {
    await this.jobs.get(id)?.done;
  }

  /** Stops a running copy; partial files stay for a later resume. */
  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.abort.abort(new Error('cancelled'));
    const queued = this.waiting.findIndex((w) => w.torrent.id === id);
    if (queued >= 0) this.waiting.splice(queued, 1)[0]!.start();
    await job.done.catch(() => undefined);
  }

  /** Cancels and forgets a torrent; with `deleteData` the local copy (and partial files) go too. */
  async forget(id: string, deleteData: boolean, name?: string): Promise<void> {
    await this.cancel(id);
    const manifest = await this.manifest(id);
    this.manifests.delete(id);
    this.progressById.delete(id);
    await rm(this.manifestPath(id), { force: true });
    if (!deleteData) return;
    const contentName = manifest ? undefined : name;
    if (manifest) await rm(manifest.contentPath, { recursive: true, force: true, maxRetries: 3 });
    else if (contentName) {
      const target = localPathFor(this.opts.root, contentName);
      await rm(target, { recursive: true, force: true, maxRetries: 3 });
      await rm(target + PART_SUFFIX, { force: true });
    }
  }

  private async run(torrent: AgentTorrent, signal: AbortSignal): Promise<void> {
    const id = torrent.id;
    const files = (await this.client.files(id)).filter((f) => f.priority > 0);
    const missing = files.filter((f) => !f.complete);
    if (files.length === 0) throw new Error('The agent reports no files for this torrent.');
    if (missing.length > 0) throw new Error(`The agent has not finished ${missing.length} file(s) yet.`);
    const progress = this.progressById.get(id)!;
    progress.state = 'fetching';
    progress.totalBytes = files.reduce((n, f) => n + f.length, 0);
    progress.bytesDone = 0;

    const verified: PullManifest['files'] = [];
    for (const file of files) {
      if (signal.aborted) throw signal.reason;
      const sha256 = await this.fetchFile(id, file, progress, signal);
      verified.push({ index: file.index, path: file.path, length: file.length, sha256 });
    }
    // Protocol paths start with the payload root (the torrent's directory, or the single file).
    const contentPath = localPathFor(this.opts.root, files[0]!.path.split('/')[0]!);
    const manifest: PullManifest = { version: 1, id, name: torrent.name, contentPath, files: verified, completedAt: new Date(this.now()).toISOString() };
    await mkdir(join(this.opts.root, PULL_STATE_DIR), { recursive: true });
    await writeFile(this.manifestPath(id), `${JSON.stringify(manifest, null, 2)}\n`);
    this.manifests.set(id, manifest);
    this.progressById.delete(id);
  }

  /** Copies one file (resuming a partial copy) and verifies it; returns its SHA-256. */
  private async fetchFile(id: string, file: AgentFile, progress: PullProgress, signal: AbortSignal): Promise<string> {
    const local = localPathFor(this.opts.root, file.path);
    const part = local + PART_SUFFIX;
    const { sha256: expected } = await this.client.checksum(id, file.index);

    // Already copied (e.g. the manifest was lost): verify and keep.
    if ((await sizeOf(local)) === file.length) {
      progress.state = 'verifying';
      if ((await sha256File(local)) === expected) {
        progress.bytesDone += file.length;
        progress.state = 'fetching';
        return expected;
      }
      await rm(local, { force: true });
    }

    await mkdir(dirname(local), { recursive: true });
    let offset = (await sizeOf(part)) ?? 0;
    if (offset > file.length) {
      await rm(part, { force: true });
      offset = 0;
    }
    const before = progress.bytesDone;
    if (offset < file.length) {
      const res = await this.client.openFile(id, file.index, offset, signal);
      // An agent that ignored the Range header sends the whole file: start over.
      if (offset > 0 && res.status !== 206) offset = 0;
      progress.bytesDone = before + offset;
      if (!res.body) throw new Error(`The agent sent no content for ${file.path}.`);
      const startedAt = this.now();
      let received = 0;
      const limit = () => this.bandwidth();
      const now = this.now;
      const meter = new Transform({
        async transform(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          progress.bytesDone += chunk.length;
          const elapsed = Math.max(1, now() - startedAt);
          progress.rate = (received / elapsed) * 1000;
          const bps = limit();
          if (bps > 0) {
            const due = (received / bps) * 1000 - elapsed;
            if (due > 0) {
              try {
                await sleep(due, signal);
              } catch (error) {
                return cb(error as Error);
              }
            }
          }
          cb(null, chunk);
        },
      });
      const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
      await pipeline(body, meter, createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }), { signal });
    } else if (file.length === 0) {
      await writeFile(part, '');
    }

    if ((await sizeOf(part)) !== file.length) throw new Error(`Copy of ${file.path} is incomplete; it resumes on the next attempt.`);
    progress.state = 'verifying';
    const actual = await sha256File(part);
    if (actual !== expected) {
      await rm(part, { force: true });
      progress.bytesDone = before;
      throw new Error(`Checksum mismatch for ${file.path}; the copy was discarded and is fetched again.`);
    }
    await rename(part, local);
    progress.state = 'fetching';
    progress.bytesDone = before + file.length;
    return expected;
  }
}

const managers = new Map<string, PullManager>();

/**
 * One manager per (agent URL, local folder) for the whole process, so a client rebuilt after
 * a settings change keeps the transfers already running.
 */
export function pullManagerFor(options: PullManagerOptions & { url: string }): PullManager {
  const key = `${options.url}\n${options.root}`;
  const existing = managers.get(key);
  if (existing) {
    existing.configure(options);
    return existing;
  }
  const created = new PullManager(options);
  managers.set(key, created);
  return created;
}
