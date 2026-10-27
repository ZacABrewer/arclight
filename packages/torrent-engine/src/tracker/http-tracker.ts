import http from 'node:http';
import https from 'node:https';
import { type BDict, decode, getBytes, getInt, getList, getString, isDict } from '../bencode.js';
import { decodeCompactPeers, decodeCompactPeers6, normalizeHost, type PeerAddress } from '../compact.js';
import { errorMessage, TorrentEngineError } from '../errors.js';
import { trackerRequests } from './limiter.js';
import type { AnnounceParams, AnnounceResponse, ScrapeResponse, TrackerClient } from './types.js';

export interface HttpRequestOptions {
  timeoutMs: number;
  /** Local address to bind the outgoing connection to (VPN interface binding). */
  localAddress?: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  body: Buffer;
}

/** Performs a GET request. Injected in tests; the default uses `node:http(s)`. */
export type HttpRequester = (url: string, opts: HttpRequestOptions) => Promise<HttpResponse>;

const MAX_BODY = 4 * 1024 * 1024;

/** Default requester: node:http/https with `localAddress` support and up to 3 redirects. */
export const nodeHttpRequester: HttpRequester = (url, opts) => request(url, opts, 3);

function request(url: string, opts: HttpRequestOptions, redirects: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) {
      reject(new TorrentEngineError('tracker', `unsupported protocol ${u.protocol}`));
      return;
    }
    const reqOpts: http.RequestOptions = { method: 'GET', headers: opts.headers, timeout: opts.timeoutMs };
    if (opts.localAddress) reqOpts.localAddress = opts.localAddress;
    if (opts.signal) reqOpts.signal = opts.signal;
    const req = mod.request(u, reqOpts, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location && redirects > 0) {
        res.resume();
        request(new URL(location, u).toString(), opts, redirects - 1).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy(new TorrentEngineError('tracker', 'tracker response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new TorrentEngineError('timeout', `tracker request timed out`)));
    req.on('error', reject);
    req.end();
  });
}

/** Percent-encodes raw bytes the way trackers expect for info_hash and peer_id. */
export function percentEncodeBytes(b: Buffer): string {
  let out = '';
  for (const byte of b) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9.\-_~]/.test(c)) out += c;
    else out += `%${byte.toString(16).padStart(2, '0').toUpperCase()}`;
  }
  return out;
}

function parsePeers(d: BDict): PeerAddress[] {
  const compact = getBytes(d, 'peers');
  const compact6 = getBytes(d, 'peers6');
  const v6 = compact6 ? decodeCompactPeers6(compact6) : [];
  if (compact) return [...decodeCompactPeers(compact), ...v6];
  const list = getList(d, 'peers') ?? [];
  const out: PeerAddress[] = [...v6];
  for (const p of list) {
    if (!isDict(p)) continue;
    const ip = getString(p, 'ip');
    const port = getInt(p, 'port');
    if (ip && port && port > 0 && port < 65536) out.push({ host: normalizeHost(ip), port });
  }
  return out;
}

export interface HttpTrackerOptions {
  requester?: HttpRequester;
  timeoutMs?: number;
  localAddress?: string;
  userAgent?: string;
}

/** HTTP(S) tracker client (BEP 3 + BEP 23 compact peers). */
export class HttpTracker implements TrackerClient {
  private trackerId: string | undefined;
  private readonly requester: HttpRequester;

  constructor(
    readonly url: string,
    private readonly opts: HttpTrackerOptions = {},
  ) {
    this.requester = opts.requester ?? nodeHttpRequester;
  }

  private async get(url: string, signal?: AbortSignal): Promise<BDict> {
    const reqOpts: HttpRequestOptions = {
      timeoutMs: this.opts.timeoutMs ?? 15_000,
      headers: { 'user-agent': this.opts.userAgent ?? 'Arclight/0.1', 'accept-encoding': 'identity' },
    };
    if (this.opts.localAddress) reqOpts.localAddress = this.opts.localAddress;
    if (signal) reqOpts.signal = signal;
    let res: HttpResponse;
    try {
      res = await trackerRequests.run(() => this.requester(url, reqOpts), signal);
    } catch (err) {
      if (err instanceof TorrentEngineError) throw err;
      throw new TorrentEngineError('tracker', `tracker unreachable: ${errorMessage(err)}`, { cause: err });
    }
    let body: BDict;
    try {
      const v = decode(res.body);
      if (!isDict(v)) throw new Error('not a dictionary');
      body = v;
    } catch (err) {
      throw new TorrentEngineError('tracker', `tracker returned HTTP ${res.status} with an invalid body`, { cause: err });
    }
    const failure = getString(body, 'failure reason');
    if (failure !== undefined) throw new TorrentEngineError('tracker', `tracker failure: ${failure}`);
    if (res.status !== 200) throw new TorrentEngineError('tracker', `tracker returned HTTP ${res.status}`);
    return body;
  }

  buildAnnounceUrl(p: AnnounceParams): string {
    const q = [
      `info_hash=${percentEncodeBytes(p.infoHash)}`,
      `peer_id=${percentEncodeBytes(p.peerId)}`,
      `port=${p.port}`,
      `uploaded=${p.uploaded}`,
      `downloaded=${p.downloaded}`,
      `left=${p.left}`,
      'compact=1',
      'no_peer_id=1',
      `numwant=${p.numwant ?? 50}`,
      `key=${(p.key >>> 0).toString(16).padStart(8, '0')}`,
    ];
    if (p.event) q.push(`event=${p.event}`);
    if (this.trackerId !== undefined) q.push(`trackerid=${encodeURIComponent(this.trackerId)}`);
    return `${this.url}${this.url.includes('?') ? '&' : '?'}${q.join('&')}`;
  }

  async announce(p: AnnounceParams, signal?: AbortSignal): Promise<AnnounceResponse> {
    const body = await this.get(this.buildAnnounceUrl(p), signal);
    const res: AnnounceResponse = {
      intervalSec: getInt(body, 'interval') ?? 1800,
      peers: parsePeers(body),
    };
    const min = getInt(body, 'min interval');
    if (min !== undefined) res.minIntervalSec = min;
    const complete = getInt(body, 'complete');
    if (complete !== undefined) res.complete = complete;
    const incomplete = getInt(body, 'incomplete');
    if (incomplete !== undefined) res.incomplete = incomplete;
    const tid = getString(body, 'tracker id');
    if (tid !== undefined) {
      this.trackerId = tid;
      res.trackerId = tid;
    }
    const warning = getString(body, 'warning message');
    if (warning !== undefined) res.warning = warning;
    return res;
  }

  /** Scrape URL per the announce→scrape convention, or null when the tracker has none. */
  scrapeUrl(): string | null {
    const idx = this.url.lastIndexOf('/');
    if (idx < 0 || !this.url.slice(idx + 1).startsWith('announce')) return null;
    return `${this.url.slice(0, idx + 1)}scrape${this.url.slice(idx + 1 + 'announce'.length)}`;
  }

  async scrape(infoHash: Buffer, signal?: AbortSignal): Promise<ScrapeResponse> {
    const base = this.scrapeUrl();
    if (!base) throw new TorrentEngineError('tracker', 'tracker does not support scrape');
    const body = await this.get(`${base}${base.includes('?') ? '&' : '?'}info_hash=${percentEncodeBytes(infoHash)}`, signal);
    const files = body.files;
    if (!isDict(files)) throw new TorrentEngineError('tracker', 'scrape response without files');
    const entry = files[infoHash.toString('latin1')];
    if (!isDict(entry)) throw new TorrentEngineError('tracker', 'scrape response does not include the torrent');
    return {
      complete: getInt(entry, 'complete') ?? 0,
      incomplete: getInt(entry, 'incomplete') ?? 0,
      downloaded: getInt(entry, 'downloaded') ?? 0,
    };
  }

  close(): void {}
}
