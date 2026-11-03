import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import type { LookupAddress } from 'node:dns';
import { CookieJar } from './definitions/cookies.js';
import { createDefinitionIndexer } from './definitions/indexer.js';
import { ProxyError, fetchWithProxy, proxyDialHost } from './proxy.js';
import type { NetworkProxy } from './proxy.js';

// DNS rebinding through a proxy: for public-only targets the name is resolved and vetted in
// Arclight and the proxy is handed the vetted IP. Only loopback fakes; the "public" addresses
// below are never dialled (the fake proxies answer every tunnel themselves).

const PUBLIC_IP = '93.184.216.34';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const resolver = (map: Record<string, string | Error>) => async (host: string): Promise<LookupAddress[]> => {
  const v = map[host];
  if (v === undefined || v instanceof Error) throw v ?? Object.assign(new Error(`${host} not found`), { code: 'ENOTFOUND' });
  return [{ address: v, family: net.isIP(v) }];
};

interface Seen {
  /** CONNECT authority (HTTP) or the SOCKS5 target as `atyp:address`. */
  targets: string[];
  hostHeaders: string[];
  connections: number;
}

function listen(server: net.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

/** Answer the tunnelled HTTP request with a fixed body and record its Host header. */
function serveHttp(sock: net.Socket, buffered: Buffer, seen: Seen, body: string): void {
  let buf = buffered;
  const onData = (c: Buffer): void => {
    buf = Buffer.concat([buf, c]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    sock.removeListener('data', onData);
    const head = buf.subarray(0, end).toString('latin1');
    seen.hostHeaders.push(/\r\nHost: ([^\r\n]*)/i.exec(head)?.[1] ?? '');
    sock.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nContent-Type: text/plain\r\n\r\n${body}`);
  };
  sock.on('data', onData);
  onData(Buffer.alloc(0));
}

async function fakeConnectProxy(body = 'tunnelled'): Promise<{ proxy: NetworkProxy; seen: Seen }> {
  const seen: Seen = { targets: [], hostHeaders: [], connections: 0 };
  const server = net.createServer((sock) => {
    seen.connections++;
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      sock.removeListener('data', onData);
      const line = buf.subarray(0, end).toString('latin1').split('\r\n')[0] ?? '';
      seen.targets.push(/^CONNECT (\S+) /.exec(line)?.[1] ?? line);
      sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
      serveHttp(sock, buf.subarray(end + 4), seen, body);
    };
    sock.on('data', onData);
  });
  const port = await listen(server);
  return { proxy: { type: 'http', host: '127.0.0.1', port }, seen };
}

async function fakeSocks5Proxy(body = 'tunnelled'): Promise<{ proxy: NetworkProxy; seen: Seen }> {
  const seen: Seen = { targets: [], hostHeaders: [], connections: 0 };
  const server = net.createServer((sock) => {
    seen.connections++;
    let buf = Buffer.alloc(0);
    let stage: 'greet' | 'request' | 'done' = 'greet';
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      if (stage === 'greet') {
        if (buf.length < 2 || buf.length < 2 + buf[1]!) return;
        buf = buf.subarray(2 + buf[1]!);
        sock.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        const atyp = buf[3]!;
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1 + buf[4]!;
        if (buf.length < 4 + addrLen + 2) return;
        const addr = buf.subarray(4, 4 + addrLen);
        const shown = atyp === 0x01 ? [...addr].join('.') : atyp === 0x04 ? addr.toString('hex') : addr.subarray(1).toString('utf8');
        seen.targets.push(`${atyp}:${shown}`);
        const rest = buf.subarray(4 + addrLen + 2);
        stage = 'done';
        sock.removeListener('data', onData);
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        serveHttp(sock, rest, seen, body);
      }
    };
    sock.on('data', onData);
  });
  const port = await listen(server);
  return { proxy: { type: 'socks5', host: '127.0.0.1', port }, seen };
}

describe('proxyDialHost', () => {
  it('keeps the name without a policy or for admin-configured LAN targets', async () => {
    expect(await proxyDialHost('tracker.example.com', undefined)).toBe('tracker.example.com');
    expect(await proxyDialHost('nas.lan', { allowPrivate: true })).toBe('nas.lan');
  });

  it('resolves public names to the vetted IP, IPv4 first', async () => {
    const resolve = async (): Promise<LookupAddress[]> => [{ address: '2606:2800:220:1::1', family: 6 }, { address: PUBLIC_IP, family: 4 }];
    expect(await proxyDialHost('tracker.example.com', { resolve })).toBe(PUBLIC_IP);
  });

  it('refuses names that resolve to a private address and private literals', async () => {
    await expect(proxyDialHost('rebind.example.com', { resolve: resolver({ 'rebind.example.com': '127.0.0.1' }) })).rejects.toMatchObject({ code: 'blocked' });
    await expect(proxyDialHost('10.0.0.5', {})).rejects.toMatchObject({ code: 'blocked' });
    await expect(proxyDialHost('[::1]', {})).rejects.toMatchObject({ code: 'blocked' });
    await expect(proxyDialHost('localhost', { resolve: resolver({}) })).rejects.toMatchObject({ code: 'blocked' });
  });

  it('passes .onion and locally unresolvable public names to the proxy, but not LAN-looking names', async () => {
    let lookups = 0;
    const counting = async (h: string): Promise<LookupAddress[]> => {
      lookups++;
      return resolver({})(h);
    };
    expect(await proxyDialHost('abcdefghijklmnop.onion', { resolve: counting })).toBe('abcdefghijklmnop.onion');
    expect(lookups).toBe(0);
    expect(await proxyDialHost('proxy-only.example.com', { resolve: counting })).toBe('proxy-only.example.com');
    await expect(proxyDialHost('nas.lan', { resolve: counting })).rejects.toMatchObject({ code: 'blocked' });
    await expect(proxyDialHost('mynas', { resolve: counting })).rejects.toMatchObject({ code: 'blocked' });
  });
});

describe('fetchWithProxy with a public-only target policy', () => {
  const policy = { resolve: resolver({ 'tracker.example.com': PUBLIC_IP, 'rebind.example.com': '127.0.0.1' }) };

  it('HTTP CONNECT receives the vetted IP; the Host header keeps the name', async () => {
    const { proxy, seen } = await fakeConnectProxy();
    const res = await fetchWithProxy('http://tracker.example.com/x', undefined, proxy, undefined, { targetPolicy: () => policy });
    expect(await res.text()).toBe('tunnelled');
    expect(seen.targets).toEqual([`${PUBLIC_IP}:80`]);
    expect(seen.hostHeaders).toEqual(['tracker.example.com']);
  });

  it('SOCKS5 receives an IPv4 address type, not the domain type', async () => {
    const { proxy, seen } = await fakeSocks5Proxy();
    const res = await fetchWithProxy('http://tracker.example.com:8080/x', undefined, proxy, undefined, { targetPolicy: () => policy });
    expect(await res.text()).toBe('tunnelled');
    expect(seen.targets).toEqual([`1:${PUBLIC_IP}`]);
    expect(seen.hostHeaders).toEqual(['tracker.example.com:8080']);
  });

  it('refuses a name resolving to 127.0.0.1 before any tunnel is opened', async () => {
    for (const fake of [await fakeConnectProxy(), await fakeSocks5Proxy()]) {
      const err = await fetchWithProxy('http://rebind.example.com/', undefined, fake.proxy, undefined, { targetPolicy: () => policy }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProxyError);
      expect((err as ProxyError).code).toBe('blocked');
      expect(fake.seen.connections).toBe(0);
    }
  });

  it('without a policy the proxy still gets the name (remote DNS)', async () => {
    const http = await fakeConnectProxy();
    await (await fetchWithProxy('http://tracker.example.com/', undefined, http.proxy)).text();
    expect(http.seen.targets).toEqual(['tracker.example.com:80']);
    const socks = await fakeSocks5Proxy();
    await (await fetchWithProxy('http://tracker.example.com/', undefined, socks.proxy)).text();
    expect(socks.seen.targets).toEqual(['3:tracker.example.com']);
  });
});

describe('definition runtime through a proxy', () => {
  const DEF = `
id: proxied
name: Proxied
type: private
links: [http://tracker.example/]
settings: []
caps:
  categorymappings: [{id: 1, cat: Movies}]
  modes: {search: [q]}
search:
  path: browse
  rows: {selector: tr}
  fields: {title: {selector: td}}
`;

  it('keeps remote DNS for the site and refuses a foreign host that rebinds to loopback', async () => {
    const { proxy, seen } = await fakeConnectProxy('d8:announce1:x4:infod4:name1:aee');
    // The runtime's own pre-check sees a public answer; the dial-time lookup gets 127.0.0.1.
    let calls = 0;
    const rebinding = async (): Promise<LookupAddress[]> => [{ address: calls++ === 0 ? PUBLIC_IP : '127.0.0.1', family: 4 }];
    const indexer = createDefinitionIndexer(DEF, {}, { proxy, jar: new CookieJar(), foreignTargetPolicy: { resolve: rebinding } });
    await expect(indexer.download('http://collector.example/grab.torrent')).rejects.toThrow();
    expect(calls).toBe(2);
    expect(seen.connections).toBe(0);
    await indexer.download('http://tracker.example/dl/1').catch(() => undefined);
    expect(seen.targets).toEqual(['tracker.example:80']);
  });
});
