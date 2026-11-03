import http from 'node:http';
import tls from 'node:tls';
import net, { type Socket } from 'node:net';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { openHttpConnectTunnel, openSocks5Tunnel, proxyDialHost, ProxyError, type NetworkProxy } from '@arclight/indexers';
import { createSafeFetch, isBlockedAddress, isPrivateHostname, normalizeHost, type ResolveAll, type SafeFetch } from '@arclight/net';
import { redactFeedUrl, redactUrlsInText } from '@arclight/shared';
import { VERSION } from '../../version.js';

// HTTP for podcasts: feeds, artwork, chapters, transcripts and episode files, all fetched
// straight from the publisher over plain HTTP(S). Never through the VPN or a download client,
// but through the indexer proxy the podcasts settings (or the podcast's tags) pick, when one
// applies. Redirects are followed by hand so a permanent move (301/308) can update the stored
// feed URL, and credentials in a URL (private / premium feeds) become a Basic Authorization
// header that is dropped when a redirect leaves the origin. URLs in errors are masked.

export const USER_AGENT = `Arclight/${VERSION} (podcasts; +https://arclight.moviemethat.com)`;
const MAX_REDIRECTS = 8;
const FEED_TIMEOUT_MS = 45_000;
const MAX_FEED_BYTES = 40 * 1024 * 1024;
const DOWNLOAD_IDLE_MS = 90_000;

/** One HTTP request, redirects not followed (status 3xx comes back as is). */
export type Transport = (url: string, init: { method?: 'GET' | 'HEAD'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export class PodcastHttpError extends Error {
  constructor(
    message: string,
    /** HTTP status, or null for network errors. */
    readonly status: number | null = null,
  ) {
    super(redactUrlsInText(message));
    this.name = 'PodcastHttpError';
  }

  /** 410 Gone: the publisher removed the feed for good. */
  get gone(): boolean {
    return this.status === 410;
  }
}

// ---------------------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------------------

/**
 * Where a transport may connect (DATA-06). Feed hosts, enclosure hosts and redirects are all
 * chosen by the publisher (or by whoever suggested the feed), so local and reserved addresses
 * are refused on every hop. The one exception is `trustedHost`: the host of a feed an admin
 * added under a LAN name or address (`nas.lan`, `10.0.0.5`), which keeps self-hosted feeds and
 * their same-host episode files working. Any other private host stays blocked.
 *
 * Through a proxy the name is resolved and vetted here and the proxy is handed the address,
 * so a public name that resolves to a LAN address is refused too (see `proxyDialHost` for the
 * `.onion` / proxy-only-DNS fallback). The trusted host still goes to the proxy by name.
 */
export interface TransportPolicy {
  trustedHost?: string;
  /** Test seam: resolver for the proxied path. */
  resolve?: ResolveAll;
}

/** The host to trust for a stored feed URL: only a LAN name or address, never a public name. */
export function lanFeedHost(feedUrl: string): string | undefined {
  try {
    const host = normalizeHost(new URL(feedUrl).hostname);
    return host && isPrivateHostname(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

function hostAllowed(policy: TransportPolicy, host: string): boolean {
  return policy.trustedHost !== undefined && normalizeHost(host) === policy.trustedHost;
}

// Callers set their own deadlines (feed timeout, download idle timer) and size caps, so the
// safe fetch adds neither; it pins every connection to a vetted address.
const publicFetch = createSafeFetch({ timeoutMs: 0, maxBytes: Number.POSITIVE_INFINITY, maxRedirects: 0 });
const trustedFetches = new Map<string, SafeFetch>();

function directFetch(policy: TransportPolicy): SafeFetch {
  const host = policy.trustedHost;
  if (host === undefined) return publicFetch;
  let f = trustedFetches.get(host);
  if (!f) {
    if (trustedFetches.size >= 64) trustedFetches.delete(trustedFetches.keys().next().value as string);
    f = createSafeFetch({
      timeoutMs: 0,
      maxBytes: Number.POSITIVE_INFINITY,
      maxRedirects: 0,
      allowAddress: (address, hostname) => !isBlockedAddress(address) || hostAllowed(policy, hostname),
    });
    trustedFetches.set(host, f);
  }
  return f;
}

/**
 * Direct (address-checked safe fetch) or through an HTTP CONNECT / SOCKS5 proxy (node http +
 * tunnel). `fetchImpl` is a test seam that bypasses the address check.
 */
export function transportFor(proxy: NetworkProxy | undefined, fetchImpl?: typeof fetch, policy: TransportPolicy = {}): Transport {
  // LAN names are refused before any lookup; both paths then vet the resolved address (the
  // direct path through the safe fetch, the proxied path before the tunnel is opened).
  const refuse = (url: string): Promise<never> | null => {
    const host = new URL(url).hostname;
    if (!isPrivateHostname(host) || hostAllowed(policy, host)) return null;
    return Promise.reject(new PodcastHttpError(`${redactFeedUrl(url)}: local network addresses are not allowed for podcasts`));
  };
  if (!proxy) {
    const f: SafeFetch | typeof fetch = fetchImpl ?? directFetch(policy);
    return (url, init) =>
      (fetchImpl ? null : refuse(url)) ?? f(url, { method: init.method ?? 'GET', headers: init.headers, redirect: 'manual', ...(init.signal ? { signal: init.signal } : {}) });
  }
  return (url, init) => refuse(url) ?? proxiedRequest(proxy, url, init, policy);
}

async function proxiedRequest(proxy: NetworkProxy, raw: string, init: Parameters<Transport>[1], policy: TransportPolicy): Promise<Response> {
  const url = new URL(raw);
  const secure = url.protocol === 'https:';
  const port = Number(url.port) || (secure ? 443 : 80);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (init.signal?.aborted) throw init.signal.reason;
  // Resolve and vet the target here and tunnel to that address (DNS rebinding through the
  // proxy); the admin's trusted LAN feed host keeps going to the proxy by name.
  let dial = host;
  if (!hostAllowed(policy, host)) {
    try {
      dial = await proxyDialHost(host, policy.resolve ? { resolve: policy.resolve } : {});
    } catch (err) {
      if (err instanceof ProxyError && err.code === 'blocked') throw new PodcastHttpError(`${redactFeedUrl(raw)}: local network addresses are not allowed for podcasts`);
      throw err;
    }
  }
  // Open the tunnel (and TLS on top) first, then hand that socket to node's HTTP client.
  const open = proxy.type === 'socks5' ? openSocks5Tunnel : openHttpConnectTunnel;
  const tunnel = await open(proxy, dial, port, 30_000);
  let socket: Socket = tunnel;
  if (secure) {
    socket = await new Promise<Socket>((resolve, reject) => {
      // The certificate is checked against the URL's name (`host`), not the dialled address.
      const t = tls.connect({ socket: tunnel, host, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] });
      t.once('secureConnect', () => resolve(t));
      t.once('error', (err) => {
        tunnel.destroy();
        reject(err);
      });
    });
  }
  socket.resume();
  return new Promise<Response>((resolve, reject) => {
    const req = http.request(
      {
        method: init.method ?? 'GET',
        host,
        port,
        path: `${url.pathname}${url.search}`,
        headers: { ...init.headers, host: url.host },
        // A createConnection without an agent: node uses this socket and never dials directly.
        createConnection: () => socket,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const item of v) headers.append(k, item);
          else if (v !== undefined) headers.set(k, v);
        }
        const status = res.statusCode ?? 502;
        const noBody = init.method === 'HEAD' || status === 204 || status === 304;
        const body = noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
        if (noBody) res.resume();
        res.once('end', () => socket.destroy());
        resolve(new Response(body, { status, statusText: res.statusMessage ?? '', headers }));
      },
    );
    req.on('error', (err) => {
      socket.destroy();
      reject(err);
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------------------
// Requests with redirects and credentials
// ---------------------------------------------------------------------------------------

interface Prepared {
  url: string;
  auth: string | null;
}

/** Move user info out of the URL into a Basic Authorization value (fetch refuses URLs with credentials). */
export function splitCredentials(raw: string): Prepared {
  const u = new URL(raw);
  if (!u.username && !u.password) return { url: u.toString(), auth: null };
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  return { url: u.toString(), auth: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

export interface FollowResult {
  response: Response;
  /** Final URL (credentials removed). */
  url: string;
  /** Every hop was 301/308: the resource moved for good to `url`. */
  permanent: boolean;
  redirected: boolean;
}

/** GET with manual redirects. Credentials only go to the origin they were given for. */
export async function follow(
  transport: Transport,
  raw: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal; method?: 'GET' | 'HEAD' } = {},
): Promise<FollowResult> {
  const first = splitCredentials(raw);
  const origin = new URL(first.url).origin;
  let url = first.url;
  let permanent = true;
  let redirected = false;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: '*/*', ...init.headers };
    if (first.auth && new URL(url).origin === origin) headers.authorization = first.auth;
    let response: Response;
    try {
      response = await transport(url, { headers, ...(init.signal ? { signal: init.signal } : {}), ...(init.method ? { method: init.method } : {}) });
    } catch (err) {
      if (err instanceof PodcastHttpError) throw err;
      throw new PodcastHttpError(`${redactFeedUrl(url)}: ${networkMessage(err)}`);
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new PodcastHttpError(`${redactFeedUrl(url)}: redirect without a Location`, response.status);
      const next = new URL(location, url);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new PodcastHttpError(`${redactFeedUrl(url)}: redirect to a non-http address`, response.status);
      if (response.status !== 301 && response.status !== 308) permanent = false;
      next.username = '';
      next.password = '';
      url = next.toString();
      redirected = true;
      continue;
    }
    return { response, url, permanent: redirected && permanent, redirected };
  }
  throw new PodcastHttpError(`${redactFeedUrl(raw)}: too many redirects`);
}

function networkMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timed out';
    if ((err as { code?: string }).code === 'blocked') return 'local network addresses are not allowed for podcasts';
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ?? cause?.message ?? err.message;
  }
  return String(err);
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return `HTTP ${status} (access denied: check the credentials in the feed address)`;
  if (status === 404) return 'HTTP 404 (not found)';
  if (status === 410) return 'HTTP 410 (the feed was removed by its publisher)';
  if (status === 429) return 'HTTP 429 (rate limited)';
  return `HTTP ${status}`;
}

/** Read a body as text, honouring the charset (Content-Type or the XML declaration). */
async function readText(res: Response, maxBytes: number): Promise<string> {
  const buf = await readLimited(res, maxBytes);
  const ct = res.headers.get('content-type') ?? '';
  let charset = /charset\s*=\s*"?([\w-]+)/i.exec(ct)?.[1];
  if (!charset) charset = /^<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(buf.subarray(0, 200).toString('latin1'))?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PodcastHttpError(`response larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// ---------------------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------------------

export interface ConditionalHeaders {
  etag?: string | null;
  lastModified?: string | null;
}

export type FeedFetchResult =
  | { status: 'notModified'; url: string; permanent: boolean }
  | { status: 'ok'; url: string; permanent: boolean; body: string; etag: string | null; lastModified: string | null };

/** Conditional GET of a feed (If-None-Match / If-Modified-Since). 4xx/5xx throw PodcastHttpError. */
export async function fetchFeed(transport: Transport, feedUrl: string, cond: ConditionalHeaders = {}, signal?: AbortSignal): Promise<FeedFetchResult> {
  const headers: Record<string, string> = {
    accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
  };
  if (cond.etag) headers['if-none-match'] = cond.etag;
  if (cond.lastModified) headers['if-modified-since'] = cond.lastModified;
  const sig = timeoutSignal(FEED_TIMEOUT_MS, signal);
  const { response, url, permanent } = await follow(transport, feedUrl, { headers, signal: sig });
  if (response.status === 304) return { status: 'notModified', url, permanent };
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new PodcastHttpError(`${redactFeedUrl(url)}: ${statusMessage(response.status)}`, response.status);
  }
  let body: string;
  try {
    body = await readText(response, MAX_FEED_BYTES);
  } catch (err) {
    if (err instanceof PodcastHttpError) throw err;
    throw new PodcastHttpError(`${redactFeedUrl(url)}: ${networkMessage(err)}`);
  }
  return { status: 'ok', url, permanent, body, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
}

/** GET a small text resource (chapters JSON, transcripts, directory APIs). */
export async function fetchText(
  transport: Transport,
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<{ body: string; contentType: string | null }> {
  const { response, url: final } = await follow(transport, url, { ...(opts.headers ? { headers: opts.headers } : {}), signal: timeoutSignal(FEED_TIMEOUT_MS, opts.signal) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new PodcastHttpError(`${redactFeedUrl(final)}: ${statusMessage(response.status)}`, response.status);
  }
  return { body: await readText(response, opts.maxBytes ?? 10 * 1024 * 1024), contentType: response.headers.get('content-type') };
}

/** GET a small binary resource (cover art). */
export async function fetchBytes(transport: Transport, url: string, signal?: AbortSignal, maxBytes = 15 * 1024 * 1024): Promise<{ data: Buffer; contentType: string | null }> {
  const { response, url: final } = await follow(transport, url, { signal: timeoutSignal(FEED_TIMEOUT_MS, signal) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new PodcastHttpError(`${redactFeedUrl(final)}: ${statusMessage(response.status)}`, response.status);
  }
  return { data: await readLimited(response, maxBytes), contentType: response.headers.get('content-type') };
}

// ---------------------------------------------------------------------------------------
// Episode files
// ---------------------------------------------------------------------------------------

export interface DownloadResult {
  bytes: number;
  contentType: string | null;
  url: string;
}

/** Stream an enclosure into `dest`. Fails when no data arrives for 90 s. */
export async function downloadFile(transport: Transport, url: string, dest: string, signal?: AbortSignal): Promise<DownloadResult> {
  const ctrl = new AbortController();
  const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  const { response, url: final } = await follow(transport, url, { signal: sig });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new PodcastHttpError(`${redactFeedUrl(final)}: ${statusMessage(response.status)}`, response.status);
  }
  const ct = response.headers.get('content-type');
  if (ct && /^text\/html/i.test(ct)) {
    await response.body.cancel().catch(() => undefined);
    throw new PodcastHttpError(`${redactFeedUrl(final)}: the server sent a web page instead of the episode`);
  }
  // Episode files are audio or video (often served as octet-stream); text, JSON and XML
  // answers are never kept as an episode (DATA-06).
  if (ct && !isMediaContentType(ct)) {
    await response.body.cancel().catch(() => undefined);
    throw new PodcastHttpError(`${redactFeedUrl(final)}: the server sent ${ct.split(';')[0]!.trim()} instead of an audio or video file`);
  }
  let bytes = 0;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new PodcastHttpError(`${redactFeedUrl(final)}: no data for ${DOWNLOAD_IDLE_MS / 1000} s`)), DOWNLOAD_IDLE_MS);
  };
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      arm();
      cb(null, chunk);
    },
  });
  arm();
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), counter, createWriteStream(dest), { signal: sig });
  } catch (err) {
    if (err instanceof PodcastHttpError) throw err;
    const reason = ctrl.signal.aborted ? ctrl.signal.reason : err;
    if (reason instanceof PodcastHttpError) throw reason;
    throw new PodcastHttpError(`${redactFeedUrl(final)}: ${networkMessage(reason)}`);
  } finally {
    clearTimeout(timer);
  }
  const expected = Number(response.headers.get('content-length'));
  if (Number.isFinite(expected) && expected > 0 && bytes < expected) {
    throw new PodcastHttpError(`${redactFeedUrl(final)}: download ended early (${bytes} of ${expected} bytes)`);
  }
  if (bytes === 0) throw new PodcastHttpError(`${redactFeedUrl(final)}: the server sent an empty file`);
  return { bytes, contentType: ct, url: final };
}

/** Content types an episode file may arrive as. */
export function isMediaContentType(ct: string): boolean {
  const type = ct.split(';')[0]!.trim().toLowerCase();
  if (!type) return true;
  if (/^(audio|video)\//.test(type)) return true;
  if (/^text\//.test(type)) return false;
  if (/^application\/(json|xml|javascript|x-www-form-urlencoded|xhtml)|[+](xml|json)$/.test(type)) return false;
  // application/octet-stream, binary/octet-stream, application/ogg, application/mp4, ...
  return true;
}
