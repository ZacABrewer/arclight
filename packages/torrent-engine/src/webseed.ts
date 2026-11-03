/**
 * BEP 19 (GetRight-style `url-list`) web seeds: whole pieces are fetched with HTTP range
 * requests from plain web servers. A web seed behaves like an always-unchoked seed in the
 * picker. Each piece is assembled in memory and hashed before anything is written, so a bad
 * or hostile server never gets its bytes onto the disk.
 */
import http from 'node:http';
import https from 'node:https';
import { errorMessage, TorrentEngineError } from './errors.js';
import type { Metainfo, TorrentFileEntry } from './metainfo.js';
import { guardHop } from './net-guard.js';
import type { PickedBlock } from './picker.js';
import { RateMeter } from './rate.js';
import type { PieceLayout } from './storage/layout.js';

/** What a web seed needs from its torrent. */
export interface WebSeedHost {
  readonly metainfo: Metainfo;
  readonly layout: PieceLayout;
  /** Claims a whole piece to fetch (its free blocks are reserved for `key`), or null. */
  claimPiece(key: string): { index: number; blocks: PickedBlock[] } | null;
  /** Gives back blocks that were claimed (a no-op for blocks of a piece that got verified). */
  release(index: number, begin: number, key: string): void;
  /**
   * Hands over a whole piece held in memory. Resolves true once it passed the hash check and
   * was written, false when it failed the check (nothing was written) or was not needed.
   */
  deliverPiece(key: string, index: number, data: Buffer): Promise<boolean>;
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
  /**
   * Allow web seeds on loopback / LAN addresses. Off by default: the .torrent or magnet picks
   * the URL, so every hop (redirects included) must resolve to public addresses only.
   */
  allowPrivate?: boolean;
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
  allowPrivate?: boolean;
  /** Buffer of exactly `length` bytes to fill (default: a new one). */
  into?: Buffer;
}

const MAX_REDIRECTS = 3;
/** Largest piece web seeds fetch: each one is held in memory until its hash check. */
export const WEB_SEED_MAX_PIECE = 32 * 1024 * 1024;
/** Memory for web seed pieces in flight per torrent (caps concurrency at large piece sizes). */
export const WEB_SEED_BUFFER_BYTES = 64 * 1024 * 1024;

/** GET with a Range header; resolves with exactly `length` bytes (in `into` when given) or rejects. */
export async function fetchRange(req: RangeRequest, redirects = MAX_REDIRECTS): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    throw new TorrentEngineError('peer', 'invalid web seed url');
  }
  const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
  if (!mod) throw new TorrentEngineError('peer', `unsupported web seed protocol ${u.protocol}`);
  // Each hop is vetted on its own, so a public seed cannot redirect into the LAN.
  let guard: Awaited<ReturnType<typeof guardHop>>;
  try {
    guard = await guardHop(u, req.allowPrivate === true);
  } catch (err) {
    throw new TorrentEngineError('peer', `web seed refused: ${errorMessage(err)}`, { cause: err });
  }
  return new Promise((resolve, reject) => {
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
    if (guard.lookup) opts.lookup = guard.lookup;
    if (req.localAddress) opts.localAddress = req.localAddress;
    const r = mod.request(u, opts, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location && redirects > 0) {
        res.resume();
        let next: string;
        try {
          next = new URL(location, u).toString();
        } catch {
          reject(new TorrentEngineError('peer', 'web seed sent an invalid redirect'));
          return;
        }
        fetchRange({ ...req, url: next }, redirects - 1).then(resolve, reject);
        return;
      }
      // 200 means the server ignored Range: usable only when the range starts at 0.
      if (status !== 206 && !(status === 200 && req.start === 0)) {
        res.resume();
        reject(new TorrentEngineError('peer', `web seed returned HTTP ${status}`));
        return;
      }
      // Copied straight into the target: never more than `length` bytes held for one range.
      const body = req.into ?? Buffer.allocUnsafe(req.length);
      if (body.length !== req.length) {
        res.resume();
        reject(new TorrentEngineError('peer', 'web seed target buffer has the wrong size'));
        return;
      }
      let size = 0;
      let done = false;
      res.on('data', (c: Buffer) => {
        if (done) {
          r.destroy(); // more than was asked for
          return;
        }
        const n = Math.min(c.length, req.length - size);
        c.copy(body, size, 0, n);
        size += n;
        if (size >= req.length) {
          done = true;
          if (status === 200 || n < c.length) r.destroy();
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
  /** Turned off for good (it kept sending data that failed the hash check). */
  disabled = false;

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
  /** Pieces fetched at once: the connection cap, lowered so buffered pieces fit the budget. */
  private readonly maxActive: number;
  /** Why web seeds are not used at all for this torrent (null when they are). */
  private readonly unusable: string | null;

  constructor(
    private readonly host: WebSeedHost,
    urls: readonly string[],
    private readonly opts: WebSeedOptions,
  ) {
    const unique = [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))];
    this.seeds = unique.map((u) => new WebSeed(u, () => host.now()));
    const pieceLength = host.metainfo.pieceLength;
    this.unusable =
      pieceLength > WEB_SEED_MAX_PIECE
        ? `not used: pieces are over ${WEB_SEED_MAX_PIECE / (1024 * 1024)} MiB`
        : host.metainfo.pieceHashes.length === 0
          ? 'not used: the torrent has no v1 piece hashes'
          : null;
    if (this.unusable) for (const s of this.seeds) s.lastError = this.unusable;
    this.maxActive = Math.max(1, Math.min(opts.maxConnections, Math.floor(WEB_SEED_BUFFER_BYTES / Math.max(1, pieceLength))));
  }

  get count(): number {
    return this.seeds.length;
  }

  get activeRequests(): number {
    return this.seeds.reduce((n, s) => n + s.active, 0);
  }

  /** Starts piece fetches while there are free slots and pieces to claim. */
  tick(): void {
    if (this.closed || this.unusable || !this.host.wantsData()) return;
    const now = this.host.now();
    let progress = true;
    while (progress && this.activeRequests < this.maxActive) {
      progress = false;
      // spread requests: least busy usable seed first
      const usable = this.seeds.filter((s) => !s.disabled && s.retryAt <= now).sort((a, b) => a.active - b.active);
      for (const seed of usable) {
        if (this.activeRequests >= this.maxActive) break;
        const claim = this.host.claimPiece(seed.key);
        if (!claim) return;
        progress = true;
        void this.run(seed, claim.index, claim.blocks);
      }
    }
  }

  private async run(seed: WebSeed, index: number, blocks: PickedBlock[]): Promise<void> {
    seed.active++;
    const ac = new AbortController();
    this.aborts.add(ac);
    try {
      const size = this.host.layout.pieceSize(index);
      // The whole piece stays in memory until its hash check: bad bytes never reach the disk.
      const data = Buffer.allocUnsafe(size);
      await this.fetchTorrentRange(seed, index * this.host.metainfo.pieceLength, data, ac.signal);
      const wait = this.host.consumeDownload(size);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (this.closed) return;
      seed.meter.add(size);
      const ok = await this.host.deliverPiece(seed.key, index, data);
      seed.failures = 0;
      if (!seed.disabled) seed.lastError = ok ? null : `piece ${index} failed the hash check`;
    } catch (err) {
      if (!this.closed && !seed.disabled) {
        seed.failures++;
        seed.lastError = errorMessage(err);
        seed.retryAt = this.host.now() + this.opts.retryMs * 2 ** Math.min(seed.failures - 1, 6);
      }
    } finally {
      for (const b of blocks) this.host.release(b.index, b.begin, seed.key);
      seed.active--;
      this.aborts.delete(ac);
      if (!this.closed) queueMicrotask(() => this.tick());
    }
  }

  /** Fills `out` with the torrent bytes at `offset`, split across files (padding files are zeros). */
  private async fetchTorrentRange(seed: WebSeed, offset: number, out: Buffer, signal: AbortSignal): Promise<void> {
    let at = 0;
    for (const span of this.host.layout.spans(offset, out.length)) {
      const target = out.subarray(at, at + span.length);
      at += span.length;
      if (span.file.padding) {
        target.fill(0);
        continue;
      }
      const req: RangeRequest = {
        url: webSeedFileUrl(seed.url, this.host.metainfo, span.file),
        start: span.fileOffset,
        length: span.length,
        timeoutMs: this.opts.timeoutMs ?? 30_000,
        userAgent: this.opts.userAgent ?? 'Arclight',
        signal,
        into: target,
      };
      if (this.opts.allowPrivate) req.allowPrivate = true;
      const local = this.host.localAddress();
      if (local) req.localAddress = local;
      await fetchRange(req);
    }
    if (at !== out.length) throw new TorrentEngineError('peer', 'web seed returned a short range');
  }

  /** Stops using the web seed with this key (its data failed the hash check too often). */
  disable(key: string): boolean {
    const seed = this.seeds.find((s) => s.key === key);
    if (!seed || seed.disabled) return false;
    seed.disabled = true;
    seed.lastError = 'disabled: its data failed the hash check';
    return true;
  }

  stats(): WebSeedStats[] {
    const now = this.host.now();
    return this.seeds.map((s) => ({
      url: s.url,
      downloadRate: s.meter.rate(),
      downloaded: s.meter.total,
      activeRequests: s.active,
      failures: s.failures,
      retryAt: !s.disabled && !this.unusable && s.retryAt > now ? s.retryAt : null,
      lastError: s.lastError,
    }));
  }

  close(): void {
    this.closed = true;
    for (const ac of this.aborts) ac.abort();
    this.aborts.clear();
  }
}
