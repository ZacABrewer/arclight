import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { ProxyError } from './errors.js';
import { openTunnel, stripBrackets } from './tunnel.js';
import type { NetworkProxy } from './types.js';

/** Overall deadline for one fetchWithProxy call (all redirect hops). */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 10;
const MAX_HEAD_BYTES = 256 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
/** Request headers we always write ourselves (user values ignored). */
const MANAGED_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive', 'proxy-connection', 'upgrade', 'te',
]);

interface ResponseHead {
  status: number;
  statusText: string;
  headers: Headers;
}

interface RawResponse extends ResponseHead {
  body: Buffer;
}

/** Incremental decoder for `Transfer-Encoding: chunked`. */
class ChunkedDecoder {
  readonly parts: Buffer[] = [];
  private pending: Buffer = Buffer.alloc(0);
  private state: 'size' | 'data' | 'crlf' | 'trailer' | 'done' = 'size';
  private remaining = 0;

  get done(): boolean {
    return this.state === 'done';
  }

  feed(input: Buffer): void {
    const buf = this.pending.length > 0 ? Buffer.concat([this.pending, input]) : input;
    let pos = 0;
    while (this.state !== 'done') {
      if (this.state === 'data') {
        const take = Math.min(this.remaining, buf.length - pos);
        if (take === 0) break;
        this.parts.push(buf.subarray(pos, pos + take));
        pos += take;
        this.remaining -= take;
        if (this.remaining === 0) this.state = 'crlf';
        continue;
      }
      if (this.state === 'crlf') {
        if (buf.length - pos < 2) break;
        if (buf[pos] !== 0x0d || buf[pos + 1] !== 0x0a) throw new ProxyError('protocol', 'Malformed chunked body (missing CRLF after chunk)');
        pos += 2;
        this.state = 'size';
        continue;
      }
      const nl = buf.indexOf('\r\n', pos, 'latin1');
      if (nl < 0) {
        if (buf.length - pos > 8192) throw new ProxyError('protocol', 'Malformed chunked body (line too long)');
        break;
      }
      const line = buf.toString('latin1', pos, nl);
      pos = nl + 2;
      if (this.state === 'size') {
        const sizeText = (line.split(';', 1)[0] ?? '').trim();
        if (!/^[0-9a-fA-F]{1,12}$/.test(sizeText)) throw new ProxyError('protocol', `Malformed chunk size: ${sizeText.slice(0, 20)}`);
        const size = parseInt(sizeText, 16);
        if (size === 0) this.state = 'trailer';
        else {
          this.remaining = size;
          this.state = 'data';
        }
      } else if (line === '') {
        this.state = 'done';
      }
    }
    this.pending = buf.subarray(pos);
  }
}

function parseHead(text: string): ResponseHead {
  const lines = text.split('\r\n');
  const statusLine = lines[0] ?? '';
  const m = /^HTTP\/(\d)(?:\.(\d))?\s+(\d{3})(?:\s(.*))?$/.exec(statusLine);
  if (!m) throw new ProxyError('protocol', `Malformed HTTP status line: ${statusLine.slice(0, 100)}`);
  const headers = new Headers();
  let last: { name: string; value: string } | undefined;
  const flush = (): void => {
    if (!last) return;
    try {
      headers.append(last.name, last.value);
    } catch {
      // Invalid header name/value from the server: drop it rather than fail the response.
    }
    last = undefined;
  };
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    if ((line.startsWith(' ') || line.startsWith('\t')) && last) {
      last.value += ` ${line.trim()}`; // obsolete line folding
      continue;
    }
    flush();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    last = { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
  }
  flush();
  return { status: Number(m[3]), statusText: (m[4] ?? '').trim(), headers };
}

function buildRequestHead(url: URL, method: string, headers: Headers, body: Uint8Array | undefined): string {
  const lines = [`${method} ${url.pathname || '/'}${url.search} HTTP/1.1`, `Host: ${headers.get('host') ?? url.host}`];
  headers.forEach((value, name) => {
    if (!MANAGED_HEADERS.has(name)) lines.push(`${name}: ${value}`);
  });
  lines.push('Connection: close', 'Accept-Encoding: gzip, deflate');
  if (body !== undefined) lines.push(`Content-Length: ${body.byteLength}`);
  else if (method === 'POST' || method === 'PUT' || method === 'PATCH') lines.push('Content-Length: 0');
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function setDefaultHeader(headers: Headers, name: string, value: string): void {
  if (!headers.has(name)) headers.set(name, value);
}

async function encodeBody(body: RequestInit['body'] | null | undefined, headers: Headers): Promise<Uint8Array | undefined> {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') {
    setDefaultHeader(headers, 'content-type', 'text/plain;charset=UTF-8');
    return Buffer.from(body, 'utf8');
  }
  if (body instanceof URLSearchParams) {
    setDefaultHeader(headers, 'content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    return Buffer.from(body.toString(), 'utf8');
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) {
    if (body.type) setDefaultHeader(headers, 'content-type', body.type);
    return new Uint8Array(await body.arrayBuffer());
  }
  throw new TypeError('fetchWithProxy: unsupported body type (FormData and streams cannot be sent through a proxy tunnel)');
}

function zlibOp(fn: (buf: Buffer, opts: zlib.ZlibOptions, cb: (err: Error | null, out: Buffer) => void) => void, buf: Buffer, opts: zlib.ZlibOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => fn(buf, opts, (err, out) => (err ? reject(err) : resolve(out))));
}

async function decodeBody(body: Buffer, encoding: string | null): Promise<Buffer> {
  if (!encoding || body.length === 0) return body;
  const codings = encoding.toLowerCase().split(',').map((c) => c.trim()).filter((c) => c && c !== 'identity').reverse();
  let out = body;
  try {
    for (const coding of codings) {
      if (coding === 'gzip' || coding === 'x-gzip') {
        out = await zlibOp(zlib.gunzip, out, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } else if (coding === 'deflate') {
        try {
          out = await zlibOp(zlib.inflate, out, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        } catch {
          out = await zlibOp(zlib.inflateRaw, out, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        }
      } else if (coding === 'br') {
        out = await new Promise<Buffer>((resolve, reject) => zlib.brotliDecompress(out, (err, r) => (err ? reject(err) : resolve(r))));
      } else {
        throw new ProxyError('protocol', `Unsupported Content-Encoding: ${coding}`);
      }
    }
  } catch (err) {
    if (err instanceof ProxyError) throw err;
    throw new ProxyError('protocol', `Failed to decode ${encoding} response body: ${(err as Error).message}`, { cause: err });
  }
  return out;
}

function startTls(socket: net.Socket, host: string, signal: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const options: tls.ConnectionOptions = { socket, ALPNProtocols: ['http/1.1'] };
    if (net.isIP(host) === 0) options.servername = host;
    const secure = tls.connect(options);
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      secure.removeListener('error', onError);
      secure.removeListener('secureConnect', onSecure);
    };
    const onAbort = (): void => {
      cleanup();
      secure.destroy();
      reject(signal.reason);
    };
    const onError = (err: Error): void => {
      cleanup();
      secure.destroy();
      reject(new ProxyError('connect', `TLS handshake with ${host} failed: ${err.message}`, { cause: err }));
    };
    const onSecure = (): void => {
      cleanup();
      secure.on('error', () => {}); // see HandshakeReader.detach: the consumer attaches its own
      resolve(secure);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    secure.once('error', onError);
    secure.once('secureConnect', onSecure);
  });
}

/** Write one request on `socket` and read one response (Connection: close semantics). */
function exchange(socket: net.Socket, head: string, body: Uint8Array | undefined, isHead: boolean, signal: AbortSignal): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    let headBuf: Buffer = Buffer.alloc(0);
    let parsed: ResponseHead | undefined;
    let framing: 'none' | 'length' | 'chunked' | 'close' = 'close';
    let expected = 0;
    let received = 0;
    const parts: Buffer[] = [];
    let chunked: ChunkedDecoder | undefined;
    let settled = false;

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onEnd);
      socket.removeListener('error', onError);
      socket.destroy();
    };
    const done = (): void => {
      if (settled || !parsed) return;
      settled = true;
      cleanup();
      resolve({ ...parsed, body: Buffer.concat(chunked ? chunked.parts : parts) });
    };
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAbort = (): void => fail(signal.reason);
    const onBody = (chunk: Buffer): void => {
      if (framing === 'chunked' && chunked) {
        chunked.feed(chunk);
        if (chunked.done) done();
      } else if (framing === 'length') {
        const take = Math.min(chunk.length, expected - received);
        parts.push(chunk.subarray(0, take));
        received += take;
        if (received >= expected) done();
      } else {
        parts.push(chunk);
      }
    };
    const onData = (chunk: Buffer): void => {
      try {
        if (parsed) {
          onBody(chunk);
          return;
        }
        headBuf = headBuf.length === 0 ? chunk : Buffer.concat([headBuf, chunk]);
        for (;;) {
          const end = headBuf.indexOf('\r\n\r\n', 0, 'latin1');
          if (end < 0) {
            if (headBuf.length > MAX_HEAD_BYTES) throw new ProxyError('protocol', 'HTTP response head too large');
            return;
          }
          const h = parseHead(headBuf.toString('latin1', 0, end));
          const rest = headBuf.subarray(end + 4);
          if (h.status >= 100 && h.status < 200 && h.status !== 101) {
            headBuf = rest; // interim response (100 Continue, 103 Early Hints): skip
            continue;
          }
          parsed = h;
          const te = h.headers.get('transfer-encoding');
          const cl = h.headers.get('content-length');
          if (isHead || NULL_BODY_STATUSES.has(h.status)) framing = 'none';
          else if (te && te.toLowerCase().split(',').map((s) => s.trim()).includes('chunked')) {
            framing = 'chunked';
            chunked = new ChunkedDecoder();
          } else if (cl !== null) {
            const first = (cl.split(',')[0] ?? '').trim();
            if (!/^\d+$/.test(first)) throw new ProxyError('protocol', `Invalid Content-Length: ${cl}`);
            framing = 'length';
            expected = Number(first);
          } else framing = 'close';
          if (framing === 'none' || (framing === 'length' && expected === 0)) {
            done();
            return;
          }
          if (rest.length > 0) onBody(rest);
          return;
        }
      } catch (err) {
        fail(err);
      }
    };
    const onEnd = (): void => {
      if (settled) return;
      if (!parsed) fail(new ProxyError('protocol', 'Connection closed before a complete HTTP response head was received'));
      else if (framing === 'close') done();
      else fail(new ProxyError('protocol', 'Connection closed before the response body was complete'));
    };
    const onError = (err: Error): void => fail(new ProxyError('connect', `Connection error: ${err.message}`, { cause: err }));

    if (signal.aborted) {
      fail(signal.reason);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
    socket.on('error', onError);
    socket.resume();
    socket.write(head);
    if (body !== undefined && body.byteLength > 0) socket.write(body);
  });
}

async function requestOnce(url: URL, method: string, headers: Headers, body: Uint8Array | undefined, proxy: NetworkProxy, signal: AbortSignal): Promise<RawResponse> {
  const isHttps = url.protocol === 'https:';
  if (!isHttps && url.protocol !== 'http:') throw new TypeError(`fetchWithProxy: unsupported protocol ${url.protocol}`);
  const host = stripBrackets(url.hostname);
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const tunnel = await openTunnel(proxy, host, port, { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS, signal });
  let socket: net.Socket = tunnel;
  if (isHttps) {
    try {
      socket = await startTls(tunnel, host, signal);
    } catch (err) {
      tunnel.destroy();
      throw err;
    }
  }
  return exchange(socket, buildRequestHead(url, method, headers, body), body, method === 'HEAD', signal);
}

async function toResponse(raw: RawResponse, url: URL, redirected: boolean): Promise<Response> {
  if (raw.status < 200 || raw.status > 599) throw new ProxyError('protocol', `Unsupported HTTP status ${raw.status}`);
  const body = NULL_BODY_STATUSES.has(raw.status) ? null : new Uint8Array(await decodeBody(raw.body, raw.headers.get('content-encoding')));
  let response: Response;
  try {
    response = new Response(body, { status: raw.status, statusText: raw.statusText, headers: raw.headers });
  } catch {
    response = new Response(body, { status: raw.status, headers: raw.headers }); // reason phrase not a valid token
  }
  Object.defineProperty(response, 'url', { value: url.href, enumerable: true });
  Object.defineProperty(response, 'redirected', { value: redirected, enumerable: true });
  return response;
}

/**
 * fetch-compatible call that tunnels through `proxy` (HTTP CONNECT or SOCKS5 CONNECT with remote
 * DNS); without a proxy, delegates to `fetchImpl ?? globalThis.fetch`. Bodies are buffered in
 * memory; supported request bodies are string, URLSearchParams, ArrayBuffer(View) and Blob.
 */
export async function fetchWithProxy(input: string | URL, init?: RequestInit, proxy?: NetworkProxy, fetchImpl?: typeof fetch): Promise<Response> {
  if (!proxy) {
    const f = fetchImpl ?? globalThis.fetch;
    return init === undefined ? f(input) : f(input, init);
  }
  const userSignal = init?.signal ?? undefined;
  if (userSignal?.aborted) throw userSignal.reason;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new ProxyError('timeout', `Request timed out after ${DEFAULT_FETCH_TIMEOUT_MS} ms`));
  }, DEFAULT_FETCH_TIMEOUT_MS);
  const onUserAbort = (): void => controller.abort(userSignal?.reason);
  userSignal?.addEventListener('abort', onUserAbort, { once: true });
  try {
    let url = new URL(input);
    let method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body = await encodeBody(init?.body, headers);
    const mode = init?.redirect ?? 'follow';
    for (let hop = 0; ; hop++) {
      const raw = await requestOnce(url, method, headers, body, proxy, controller.signal);
      const location = raw.headers.get('location');
      if (mode !== 'manual' && REDIRECT_STATUSES.has(raw.status) && location !== null) {
        if (mode === 'error') throw new TypeError(`Redirect to ${location} blocked (redirect: 'error')`);
        if (hop >= MAX_REDIRECTS) throw new TypeError(`Too many redirects (more than ${MAX_REDIRECTS})`);
        const next = new URL(location, url);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new TypeError(`Redirect to unsupported protocol ${next.protocol}`);
        if ((raw.status === 303 && method !== 'HEAD') || ((raw.status === 301 || raw.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          headers.delete('content-type');
        }
        if (next.origin !== url.origin) headers.delete('authorization');
        url = next;
        continue;
      }
      return await toResponse(raw, url, hop > 0);
    }
  } finally {
    clearTimeout(timer);
    userSignal?.removeEventListener('abort', onUserAbort);
  }
}
