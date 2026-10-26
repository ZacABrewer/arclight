/**
 * BEP 19 (GetRight-style `url-list`) web seeds: blocks are fetched with HTTP range requests
 * from plain web servers. A web seed behaves like an always-unchoked seed in the picker.
 */
import http from 'node:http';
import https from 'node:https';
import { errorMessage, TorrentEngineError } from './errors.js';
import type { Metainfo, TorrentFileEntry } from './metainfo.js';
import type { PickedBlock } from './picker.js';
import { RateMeter } from './rate.js';
import type { PieceLayout } from './storage/layout.js';

/** What a web seed needs from its torrent. */
export interface WebSeedHost {
  readonly metainfo: Metainfo;
  readonly layout: PieceLayout;
  /** Free blocks to fetch (the picker with "has every piece"). */
  pick(key: string, count: number): PickedBlock[];
  /** Gives back blocks that could not be fetched. */
  release(index: number, begin: number, key: string): void;
  /** Hands over a received block. */
  deliver(key: string, index: number, begin: number, data: Buffer): void;
  /** True while blocks are still wanted. */
  wantsData(): boolean;
  /** ms to wait before using `bytes` of download budget (rate limits). */
  consumeDownload(bytes: number): number;
  localAddress(): string | undefined;
  now(): number;
}

export interface WebSeedOptions {
  /** Max concurrent HTTP requests across all web seeds of the torrent. */
  maxConnections: number;
  /** Base back-off after an error, doubled per consecutive failure (capped at 64x). */
  retryMs: number;
  timeoutMs?: number;
  userAgent?: string;
}

export interface WebSeedStats {
  url: string;
  downloadRate: number;
  downloaded: number;
  activeRequests: number;
  failures: number;
  /** Next attempt time (ms epoch) while backing off. */
  retryAt: number | null;
  lastError: string | null;
}

/** Full URL of one file for a GetRight-style web seed (`pathSegments` include the root name). */
export function webSeedFileUrl(base: string, meta: Pick<Metainfo, 'name' | 'isMultiFile'>, file: Pick<TorrentFileEntry, 'pathSegments'>): string {
  const enc = (s: string): string => encodeURIComponent(s);
  if (!meta.isMultiFile) return base.endsWith('/') ? `${base}${enc(meta.name)}` : base;
  const dir = base.endsWith('/') ? base : `${base}/`;
  // pathSegments already start with the torrent name (the root directory)
  return `${dir}${file.pathSegments.map(enc).join('/')}`;
}

interface RangeRequest {
  url: string;
  start: number;
  length: number;
  localAddress?: string;
  timeoutMs: number;
  userAgent: string;
  signal: AbortSignal;
}

const MAX_REDIRECTS = 3;

/** GET with a Range header; resolves with exactly `length` bytes or rejects. */
export function fetchRange(req: RangeRequest, redirects = MAX_REDIRECTS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      reject(new TorrentEngineError('peer', `invalid web seed url ${req.url}`));
      return;
    }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) {
      reject(new TorrentEngineError('peer', `unsupported web seed protocol ${u.protocol}`));
      return;
    }
    const opts: http.RequestOptions = {
      method: 'GET',
      timeout: req.timeoutMs,
      signal: req.signal,
      headers: {
        range: `bytes=${req.start}-${req.start + req.length - 1}`,
        'user-agent': req.userAgent,
        'accept-encoding': 'identity',
      },
    };
    if (req.localAddress) opts.localAddress = req.localAddress;
    const r = mod.request(u, opts, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location && redirects > 0) {
        res.resume();
        fetchRange({ ...req, url: new URL(location, u).toString() }, redirects - 1).then(resolve, reject);
        return;
      }
      // 200 means the server ignored Range: usable only when the range starts at 0.
      if (status !== 206 && !(status === 200 && req.start === 0)) {
        res.resume();
        reject(new TorrentEngineError('peer', `web seed returned HTTP ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      res.on('data', (c: Buffer) => {
        if (done) return;
        chunks.push(c);
        size += c.length;
        if (size >= req.length) {
          done = true;
          const body = Buffer.concat(chunks).subarray(0, req.length);
          if (status === 200 || size > req.length) r.destroy();
          resolve(body);
        }
      });
      res.on('end', () => {
        if (!done) reject(new TorrentEngineError('peer', `web seed response too short (${size}/${req.length})`));
      });
      res.on('error', (err) => {
        if (!done) reject(err);
      });
    });
    r.on('timeout', () => r.destroy(new TorrentEngineError('timeout', 'web seed request timed out')));
    r.on('error', reject);
    r.end();
  });
}

class WebSeed {
  readonly key: string;
  readonly meter: RateMeter;
  active = 0;
  failures = 0;
  retryAt = 0;
  lastError: string | null = null;

  constructor(
    readonly url: string,
    now: () => number,
  ) {
    this.key = `web:${url}`;
    this.meter = new RateMeter(5000, now);
  }
}

/** Drives all web seeds of one torrent. Call `tick()` periodically. */
export class WebSeedManager {
  private readonly seeds: WebSeed[];
  private readonly aborts = new Set<AbortController>();
  private closed = false;

  constructor(
    private readonly host: WebSeedHost,
    urls: readonly string[],
    private readonly opts: WebSeedOptions,
  ) {
    const unique = [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))];
    this.seeds = unique.map((u) => new WebSeed(u, () => host.now()));
  }

  get count(): number {
    return this.seeds.length;
  }

  get activeRequests(): number {
    return this.seeds.reduce((n, s) => n + s.active, 0);
  }

  /** Starts requests while there are free connection slots and wanted blocks. */
  tick(): void {
    if (this.closed || !this.host.wantsData()) return;
    const now = this.host.now();
    let progress = true;
    while (progress && this.activeRequests < this.opts.maxConnections) {
      progress = false;
      // spread requests: least busy usable seed first
      const usable = this.seeds.filter((s) => s.retryAt <= now).sort((a, b) => a.active - b.active);
      for (const seed of usable) {
        if (this.activeRequests >= this.opts.maxConnections) break;
        const blocks = this.host.pick(seed.key, this.host.layout.blocksInPiece(0) || 1);
        if (blocks.length === 0) return;
        progress = true;
        void this.run(seed, blocks);
      }
    }
  }

  private async run(seed: WebSeed, blocks: PickedBlock[]): Promise<void> {
    seed.active++;
    const ac = new AbortController();
    this.aborts.add(ac);
    // contiguous runs inside one piece become one byte range
    const runs: PickedBlock[][] = [];
    for (const b of [...blocks].sort((x, y) => x.index - y.index || x.begin - y.begin)) {
      const last = runs.at(-1)?.at(-1);
      if (last && last.index === b.index && last.begin + last.length === b.begin) runs.at(-1)?.push(b);
      else runs.push([b]);
    }
    let pending = blocks.slice();
    try {
      for (const run of runs) {
        const first = run[0] as PickedBlock;
        const length = run.reduce((n, b) => n + b.length, 0);
        const data = await this.fetchTorrentRange(seed, first.index * this.host.metainfo.pieceLength + first.begin, length, ac.signal);
        const wait = this.host.consumeDownload(length);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (this.closed) return;
        let off = 0;
        for (const b of run) {
          this.host.deliver(seed.key, b.index, b.begin, data.subarray(off, off + b.length));
          off += b.length;
          pending = pending.filter((p) => p !== b);
        }
        seed.meter.add(length);
      }
      seed.failures = 0;
      seed.lastError = null;
    } catch (err) {
      if (!this.closed) {
        seed.failures++;
        seed.lastError = errorMessage(err);
        seed.retryAt = this.host.now() + this.opts.retryMs * 2 ** Math.min(seed.failures - 1, 6);
      }
    } finally {
      for (const b of pending) this.host.release(b.index, b.begin, seed.key);
      seed.active--;
      this.aborts.delete(ac);
      if (!this.closed) queueMicrotask(() => this.tick());
    }
  }

  /** Fetches a torrent byte range, splitting it across files (padding files are zeros). */
  private async fetchTorrentRange(seed: WebSeed, offset: number, length: number, signal: AbortSignal): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (const span of this.host.layout.spans(offset, length)) {
      if (span.file.padding) {
        parts.push(Buffer.alloc(span.length));
        continue;
      }
      const req: RangeRequest = {
        url: webSeedFileUrl(seed.url, this.host.metainfo, span.file),
        start: span.fileOffset,
        length: span.length,
        timeoutMs: this.opts.timeoutMs ?? 30_000,
        userAgent: this.opts.userAgent ?? 'Arclight',
        signal,
      };
      const local = this.host.localAddress();
      if (local) req.localAddress = local;
      parts.push(await fetchRange(req));
    }
    const out = Buffer.concat(parts);
    if (out.length !== length) throw new TorrentEngineError('peer', 'web seed returned a short range');
    return out;
  }

  stats(): WebSeedStats[] {
    const now = this.host.now();
    return this.seeds.map((s) => ({
      url: s.url,
      downloadRate: s.meter.rate(),
      downloaded: s.meter.total,
      activeRequests: s.active,
      failures: s.failures,
      retryAt: s.retryAt > now ? s.retryAt : null,
      lastError: s.lastError,
    }));
  }

  close(): void {
    this.closed = true;
    for (const ac of this.aborts) ac.abort();
    this.aborts.clear();
  }
}
