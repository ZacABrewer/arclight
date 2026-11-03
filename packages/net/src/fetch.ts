import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import zlib from 'node:zlib';
import { BlockedAddressError, guardedLookup, resolveAllowed, type TargetPolicy } from './lookup.js';

// A drop-in `fetch` for outbound requests whose target someone other than the admin can
// influence. Compared with the global fetch it:
//  - resolves the host itself and connects only to vetted addresses (the socket uses the
//    address that was checked, so DNS rebinding cannot swap it afterwards);
//  - follows redirects by hand and vets every hop the same way;
//  - drops Authorization / Cookie (and any listed header) when a redirect leaves the origin,
//    and refuses to resend a request body to another origin;
//  - caps the decoded response body (`maxBytes`) and keeps the timeout running until the
//    body has been read, so a slow endless body cannot hold memory or the caller forever.
// With `allowPrivate: true` it is the same client for hosts an admin configured (LAN targets
// allowed), still with the body cap, timeout and redirect hygiene.

export type SafeFetchErrorCode = 'blocked' | 'redirect' | 'tooLarge' | 'timeout' | 'protocol';

export class SafeFetchError extends TypeError {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause ?? Object.assign(new Error(message), { code: `E${code.toUpperCase()}` }) });
    this.name = code === 'timeout' ? 'TimeoutError' : 'SafeFetchError';
  }
}

export interface SafeFetchOptions extends TargetPolicy {
  /** Largest decoded body accepted, in bytes. Default 16 MiB; `Infinity` for streamed downloads. */
  maxBytes?: number;
  /** Deadline for the whole exchange, body included. Default 30 s; 0 disables it. */
  timeoutMs?: number;
  /** Redirect hops followed (each one vetted). Default 5. */
  maxRedirects?: number;
  /** Extra request headers to drop when a redirect leaves the origin (Authorization, Cookie and Proxy-Authorization always are). */
  sensitiveHeaders?: readonly string[];
  /** Bind outgoing sockets to this local address (VPN interface). */
  localAddress?: string | (() => string | undefined);
  /** Default User-Agent when the request sets none. */
  userAgent?: string;
}

export type SafeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REDIRECTS = 5;
const ALWAYS_SENSITIVE = ['authorization', 'cookie', 'proxy-authorization'];

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function createSafeFetch(options: SafeFetchOptions = {}): SafeFetch {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_REDIRECTS;
  const sensitive = new Set([...ALWAYS_SENSITIVE, ...(options.sensitiveHeaders ?? []).map((h) => h.toLowerCase())]);
  const policy: TargetPolicy = {
    ...(options.allowPrivate !== undefined ? { allowPrivate: options.allowPrivate } : {}),
    ...(options.allowAddress ? { allowAddress: options.allowAddress } : {}),
    ...(options.resolve ? { resolve: options.resolve } : {}),
  };
  const lookup = guardedLookup(policy);
  // Per-client pools: a socket vetted under one policy is never reused under another.
  const agents = {
    'http:': new http.Agent({ keepAlive: true, maxSockets: 16 }),
    'https:': new https.Agent({ keepAlive: true, maxSockets: 16 }),
  };

  return async (input, init = {}) => {
    const ctrl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => ctrl.abort(new SafeFetchError('timeout', `Request timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      timer.unref();
    }
    const done = () => clearTimeout(timer);
    const signal = init.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal;
    const fail = (err: unknown): never => {
      done();
      if (signal.aborted) throw signal.reason;
      throw err;
    };

    let url: URL;
    let method: string;
    let headers: Headers;
    let body: Buffer | null = null;
    try {
      url = new URL(input);
      method = (init.method ?? 'GET').toUpperCase();
      headers = new Headers(init.headers);
      if (init.body !== undefined && init.body !== null) {
        // Let the platform serialise any BodyInit (string, URLSearchParams, FormData, Blob, ...).
        const probe = new Request('http://body.invalid/', { method: 'POST', body: init.body, duplex: 'half' } as RequestInit);
        body = Buffer.from(await probe.arrayBuffer());
        const ct = probe.headers.get('content-type');
        if (ct && !headers.has('content-type')) headers.set('content-type', ct);
      }
    } catch (err) {
      return fail(err);
    }
    if (!headers.has('user-agent') && options.userAgent) headers.set('user-agent', options.userAgent);
    if (!headers.has('accept')) headers.set('accept', '*/*');
    if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br');

    let redirected = false;
    for (let hop = 0; ; hop += 1) {
      let res: IncomingMessage;
      try {
        res = await requestOnce(url, method, headers, body, signal);
      } catch (err) {
        return fail(err);
      }
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (isRedirect(status) && location && init.redirect !== 'manual') {
        res.resume();
        res.destroy();
        if (init.redirect === 'error') return fail(new SafeFetchError('redirect', 'The server answered with a redirect'));
        if (hop >= maxRedirects) return fail(new SafeFetchError('redirect', 'Too many redirects'));
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return fail(new SafeFetchError('redirect', 'The server sent an invalid redirect'));
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') return fail(new SafeFetchError('redirect', 'Redirect to a non-HTTP address'));
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          if (method !== 'HEAD') method = 'GET';
          body = null;
          headers.delete('content-type');
          headers.delete('content-length');
        }
        if (next.origin !== url.origin) {
          if (body) return fail(new SafeFetchError('redirect', 'Refusing to resend the request body to another origin'));
          for (const h of sensitive) headers.delete(h);
        }
        url = next;
        redirected = true;
        continue;
      }
      try {
        return toResponse(res, method, url, redirected, maxBytes, done);
      } catch (err) {
        res.destroy();
        return fail(err);
      }
    }
  };

  async function requestOnce(url: URL, method: string, headers: Headers, body: Buffer | null, signal: AbortSignal): Promise<IncomingMessage> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError('protocol', `Unsupported protocol ${url.protocol}`);
    if (url.username || url.password) throw new SafeFetchError('protocol', 'Request URL must not contain credentials');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    // Node does not call `lookup` for IP literals, so vet those up front.
    if (isIP(hostname)) {
      try {
        await resolveAllowed(hostname, policy);
      } catch (err) {
        throw blocked(err);
      }
    }
    if (signal.aborted) throw signal.reason;
    const plain: Record<string, string> = {};
    headers.forEach((v, k) => {
      plain[k] = v;
    });
    const local = typeof options.localAddress === 'function' ? options.localAddress() : options.localAddress;
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method,
          headers: plain,
          agent: agents[url.protocol as 'http:' | 'https:'] as http.Agent,
          lookup,
          signal,
          ...(local ? { localAddress: local } : {}),
        },
        resolve,
      );
      req.on('error', (err) => reject(blocked(err)));
      req.end(body ?? undefined);
    });
  }
}

function blocked(err: unknown): unknown {
  if (err instanceof BlockedAddressError) return new SafeFetchError('blocked', err.message, { cause: err });
  if (err instanceof Error && 'cause' in err && err.cause instanceof BlockedAddressError) return blocked(err.cause);
  return err;
}

function toResponse(res: IncomingMessage, method: string, url: URL, redirected: boolean, maxBytes: number, done: () => void): Response {
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599) throw new SafeFetchError('protocol', `Unexpected HTTP status ${status}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else if (v !== undefined) headers.set(k, v);
  }
  const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
  let stream: Readable | null = null;
  if (noBody) {
    res.resume();
    res.once('end', done);
    res.once('close', done);
  } else {
    let current: Readable = res;
    const encodings = (res.headers['content-encoding'] ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e && e !== 'identity');
    const decoders: Transform[] = [];
    for (const enc of encodings.reverse()) {
      // Each decoder is itself capped, so a compression bomb stops at `maxBytes` of output.
      const limit = Number.isFinite(maxBytes) ? { maxOutputLength: Math.max(1, Math.min(maxBytes + 1, 2 ** 31 - 1)) } : {};
      if (enc === 'gzip' || enc === 'x-gzip') decoders.push(zlib.createGunzip(limit));
      else if (enc === 'deflate') decoders.push(zlib.createInflate(limit));
      else if (enc === 'br') decoders.push(zlib.createBrotliDecompress(limit));
      else {
        decoders.length = 0;
        break; // Unknown coding: hand the bytes over as they are, like fetch.
      }
    }
    if (decoders.length > 0) {
      headers.delete('content-encoding');
      headers.delete('content-length');
      for (const d of decoders) {
        const from: Readable = current;
        from.on('error', (err: Error) => d.destroy(err));
        current = from.pipe(d);
      }
    }
    let total = 0;
    const counted: Readable = current;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        if (total > maxBytes) {
          cb(new SafeFetchError('tooLarge', `Response is larger than ${formatBytes(maxBytes)}`));
          return;
        }
        cb(null, chunk);
      },
    });
    counted.on('error', (err) => cap.destroy(err));
    stream = counted.pipe(cap);
    stream.once('close', () => {
      done();
      if (!res.complete) res.destroy();
    });
  }
  const response = new Response(stream ? (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>) : null, {
    status,
    statusText: res.statusMessage ?? '',
    headers,
  });
  Object.defineProperty(response, 'url', { value: url.toString() });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/**
 * Read a response body into a Buffer, cancelling the stream as soon as it passes `maxBytes`
 * (the check runs per chunk, not after buffering). Throws `SafeFetchError('tooLarge')`.
 */
export async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new SafeFetchError('tooLarge', `Response is larger than ${formatBytes(maxBytes)}`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SafeFetchError('tooLarge', `Response is larger than ${formatBytes(maxBytes)}`);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/** `readLimited` decoded as UTF-8 text. */
export async function readLimitedText(res: Response, maxBytes: number): Promise<string> {
  return (await readLimited(res, maxBytes)).toString('utf8');
}
