import net from 'node:net';
import { Buffer } from 'node:buffer';
import { ProxyError } from './errors.js';
import type { NetworkProxy } from './types.js';

export const DEFAULT_TUNNEL_TIMEOUT_MS = 30_000;
const MAX_CONNECT_RESPONSE_HEAD = 64 * 1024;
const CRLFCRLF = Buffer.from('\r\n\r\n', 'latin1');

const SOCKS5_REPLY_MESSAGES: Record<number, string> = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
};

export interface TunnelOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const noop = (): void => {};

/**
 * Accumulates socket data during a handshake and hands out exact byte counts or
 * delimiter-terminated blocks. On release, unread bytes are pushed back into the socket.
 */
class HandshakeReader {
  connected = false;
  private buffer: Buffer = Buffer.alloc(0);
  private waiter: { take: () => Buffer | undefined; resolve: (b: Buffer) => void; reject: (e: Error) => void } | undefined;
  private failure: Error | undefined;
  private readonly socket: net.Socket;
  private readonly onFailure: (err: Error) => void;

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.pump();
  };
  private readonly onClose = (): void => {
    this.fail(this.connected
      ? new ProxyError('protocol', 'Proxy closed the connection during the handshake')
      : new ProxyError('connect', 'Proxy closed the connection before it was established'));
  };
  private readonly onError = (err: Error): void => {
    const message = this.connected ? `Proxy connection error: ${err.message}` : `Cannot connect to proxy: ${err.message}`;
    this.fail(new ProxyError('connect', message, { cause: err }));
  };

  constructor(socket: net.Socket, onFailure: (err: Error) => void) {
    this.socket = socket;
    this.onFailure = onFailure;
    socket.on('data', this.onData);
    socket.on('end', this.onClose);
    socket.on('close', this.onClose);
    socket.on('error', this.onError);
  }

  read(n: number): Promise<Buffer> {
    return this.wait(() => {
      if (this.buffer.length < n) return undefined;
      const out = this.buffer.subarray(0, n);
      this.buffer = this.buffer.subarray(n);
      return out;
    });
  }

  /** Read through `delimiter`; the returned block excludes it. */
  readUntil(delimiter: Buffer, max: number): Promise<Buffer> {
    return this.wait(() => {
      const idx = this.buffer.indexOf(delimiter);
      if (idx < 0) {
        if (this.buffer.length > max) throw new ProxyError('protocol', 'Proxy response head too large');
        return undefined;
      }
      const out = this.buffer.subarray(0, idx);
      this.buffer = this.buffer.subarray(idx + delimiter.length);
      return out;
    });
  }

  private wait(take: () => Buffer | undefined): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      this.waiter = { take, resolve, reject };
      this.pump();
    });
  }

  private pump(): void {
    const w = this.waiter;
    if (!w) return;
    let out: Buffer | undefined;
    try {
      out = w.take();
    } catch (err) {
      this.waiter = undefined;
      w.reject(err as Error);
      return;
    }
    if (out !== undefined) {
      this.waiter = undefined;
      w.resolve(out);
    }
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    const w = this.waiter;
    this.waiter = undefined;
    w?.reject(err);
    this.onFailure(err);
  }

  private detach(): void {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('end', this.onClose);
    this.socket.removeListener('close', this.onClose);
    this.socket.removeListener('error', this.onError);
    // Keep one listener so an error emitted in the gap before a consumer attaches its own
    // handler cannot crash the process; consumers still observe errors via their handler.
    this.socket.on('error', noop);
  }

  /** Stop reading; leave the socket paused with any surplus bytes unshifted. */
  release(): void {
    this.detach();
    this.socket.pause();
    if (this.buffer.length > 0) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
  }

  dispose(): void {
    this.detach();
  }
}

type Handshake = (socket: net.Socket, reader: HandshakeReader) => Promise<void>;

function runHandshake(proxy: NetworkProxy, timeoutMs: number, signal: AbortSignal | undefined, handshake: Handshake): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    socket.setNoDelay(true);
    let settled = false;
    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err !== undefined) {
        reader.dispose();
        socket.destroy();
        reject(err);
      } else {
        reader.release();
        resolve(socket);
      }
    };
    const reader = new HandshakeReader(socket, (err) => finish(err));
    const timer = setTimeout(() => {
      finish(new ProxyError('timeout', `Proxy handshake with ${proxy.host}:${proxy.port} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const onAbort = (): void => finish(signal?.reason ?? new Error('Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => {
      reader.connected = true;
      handshake(socket, reader).then(
        () => finish(),
        (err: unknown) => finish(err ?? new ProxyError('protocol', 'Proxy handshake failed')),
      );
    });
  });
}

function hasCredentials(proxy: NetworkProxy): boolean {
  return proxy.username !== undefined && proxy.username !== '';
}

export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Parse an IPv6 literal (optional zone id, optional dotted IPv4 tail) into 16 bytes. */
export function ipv6ToBytes(address: string): Buffer {
  let a = address;
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const lastColon = a.lastIndexOf(':');
  const tail = a.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = tail.split('.').map(Number);
    const hi = (((o[0] ?? 0) << 8) | (o[1] ?? 0)).toString(16);
    const lo = (((o[2] ?? 0) << 8) | (o[3] ?? 0)).toString(16);
    a = `${a.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  let groups: string[];
  const dbl = a.indexOf('::');
  if (dbl >= 0) {
    const head = a.slice(0, dbl);
    const rest = a.slice(dbl + 2);
    const headParts = head ? head.split(':') : [];
    const restParts = rest ? rest.split(':') : [];
    const fill = Math.max(0, 8 - headParts.length - restParts.length);
    groups = [...headParts, ...Array.from({ length: fill }, () => '0'), ...restParts];
  } else {
    groups = a.split(':');
  }
  const out = Buffer.alloc(16);
  groups.slice(0, 8).forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16) & 0xffff, i * 2));
  return out;
}

function encodeSocksAddress(host: string): Buffer {
  const h = stripBrackets(host);
  const kind = net.isIP(h);
  if (kind === 4) return Buffer.from([0x01, ...h.split('.').map(Number)]);
  if (kind === 6) return Buffer.concat([Buffer.from([0x04]), ipv6ToBytes(h)]);
  const name = Buffer.from(h, 'utf8');
  if (name.length === 0 || name.length > 255) throw new ProxyError('protocol', `Host name not usable with SOCKS5: ${h}`);
  return Buffer.concat([Buffer.from([0x03, name.length]), name]);
}

async function socks5Handshake(proxy: NetworkProxy, host: string, port: number, socket: net.Socket, reader: HandshakeReader): Promise<void> {
  const creds = hasCredentials(proxy);
  socket.write(Buffer.from(creds ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
  const choice = await reader.read(2);
  if (choice.readUInt8(0) !== 0x05) throw new ProxyError('protocol', 'Proxy is not a SOCKS5 server');
  const method = choice.readUInt8(1);
  if (method === 0xff) {
    throw new ProxyError('auth', creds
      ? 'SOCKS5 proxy rejected all offered authentication methods'
      : 'SOCKS5 proxy requires authentication');
  }
  if (method === 0x02) {
    if (!creds) throw new ProxyError('protocol', 'SOCKS5 proxy selected username/password auth that was not offered');
    const user = Buffer.from(proxy.username ?? '', 'utf8');
    const pass = Buffer.from(proxy.password ?? '', 'utf8');
    if (user.length > 255 || pass.length > 255) throw new ProxyError('auth', 'SOCKS5 username or password longer than 255 bytes');
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    const status = await reader.read(2);
    if (status.readUInt8(1) !== 0x00) throw new ProxyError('auth', 'SOCKS5 authentication failed (bad username or password)');
  } else if (method !== 0x00) {
    throw new ProxyError('protocol', `SOCKS5 proxy selected unsupported auth method 0x${method.toString(16)}`);
  }

  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), encodeSocksAddress(host), portBytes]));
  const reply = await reader.read(4);
  if (reply.readUInt8(0) !== 0x05) throw new ProxyError('protocol', 'Malformed SOCKS5 CONNECT reply');
  const rep = reply.readUInt8(1);
  if (rep !== 0x00) {
    const reason = SOCKS5_REPLY_MESSAGES[rep] ?? `unknown reply code 0x${rep.toString(16)}`;
    throw new ProxyError('connect', `SOCKS5 proxy could not connect to ${host}:${port}: ${reason}`);
  }
  const atyp = reply.readUInt8(3);
  if (atyp === 0x01) await reader.read(4 + 2);
  else if (atyp === 0x04) await reader.read(16 + 2);
  else if (atyp === 0x03) {
    const len = (await reader.read(1)).readUInt8(0);
    await reader.read(len + 2);
  } else {
    throw new ProxyError('protocol', `SOCKS5 reply has unknown address type 0x${atyp.toString(16)}`);
  }
}

async function httpConnectHandshake(proxy: NetworkProxy, host: string, port: number, socket: net.Socket, reader: HandshakeReader): Promise<void> {
  const h = stripBrackets(host);
  const authority = net.isIPv6(h) ? `[${h}]:${port}` : `${h}:${port}`;
  let request = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
  if (hasCredentials(proxy)) {
    const token = Buffer.from(`${proxy.username ?? ''}:${proxy.password ?? ''}`, 'utf8').toString('base64');
    request += `Proxy-Authorization: Basic ${token}\r\n`;
  }
  socket.write(`${request}\r\n`);
  const head = (await reader.readUntil(CRLFCRLF, MAX_CONNECT_RESPONSE_HEAD)).toString('latin1');
  const statusLine = head.split('\r\n', 1)[0] ?? '';
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!m) throw new ProxyError('protocol', `Malformed CONNECT response from proxy: ${statusLine.slice(0, 100)}`);
  const status = Number(m[1]);
  const reason = (m[2] ?? '').trim();
  if (status === 407) throw new ProxyError('auth', `HTTP proxy authentication required (407${reason ? ` ${reason}` : ''})`);
  if (status < 200 || status > 299) {
    throw new ProxyError('connect', `HTTP proxy refused CONNECT to ${authority}: ${status}${reason ? ` ${reason}` : ''}`);
  }
}

/** Open a TCP socket to host:port through a SOCKS5 proxy (remote DNS for host names). */
export function openSocks5Tunnel(proxy: NetworkProxy, host: string, port: number, timeoutMs: number = DEFAULT_TUNNEL_TIMEOUT_MS): Promise<net.Socket> {
  return runHandshake(proxy, timeoutMs, undefined, (s, r) => socks5Handshake(proxy, host, port, s, r));
}

/** Open a TCP socket to host:port through an HTTP proxy using CONNECT. */
export function openHttpConnectTunnel(proxy: NetworkProxy, host: string, port: number, timeoutMs: number = DEFAULT_TUNNEL_TIMEOUT_MS): Promise<net.Socket> {
  return runHandshake(proxy, timeoutMs, undefined, (s, r) => httpConnectHandshake(proxy, host, port, s, r));
}

/** Dispatch on proxy type, with abort support (internal). */
export function openTunnel(proxy: NetworkProxy, host: string, port: number, options: TunnelOptions = {}): Promise<net.Socket> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS;
  const handshake: Handshake = proxy.type === 'socks5'
    ? (s, r) => socks5Handshake(proxy, host, port, s, r)
    : (s, r) => httpConnectHandshake(proxy, host, port, s, r);
  return runHandshake(proxy, timeoutMs, options.signal, handshake);
}
