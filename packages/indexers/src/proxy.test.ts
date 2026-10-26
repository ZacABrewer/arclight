import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { CookieJar } from './definitions/cookies.js';
import {
  CHALLENGE_MARKERS,
  FlareSolverrClient,
  ProxyError,
  createProxiedFetch,
  fetchWithProxy,
  isChallengeResponse,
  openHttpConnectTunnel,
  openSocks5Tunnel,
} from './proxy.js';
import type { NetworkProxy } from './proxy.js';

// ---------------------------------------------------------------------------------------------
// In-process fixtures
// ---------------------------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function listen(server: net.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on('connection', (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  }));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

function socketReader(sock: net.Socket): { read: (n: number) => Promise<Buffer>; readUntil: (d: string) => Promise<string>; detach: () => Buffer } {
  let buf: Buffer = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  const onData = (c: Buffer): void => {
    buf = Buffer.concat([buf, c]);
    wake?.();
  };
  sock.on('data', onData);
  const waitMore = (): Promise<void> => new Promise<void>((r) => { wake = r; });
  return {
    async read(n) {
      while (buf.length < n) await waitMore();
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    async readUntil(d) {
      while (buf.indexOf(d) < 0) await waitMore();
      const i = buf.indexOf(d);
      const out = buf.toString('latin1', 0, i);
      buf = buf.subarray(i + d.length);
      return out;
    },
    detach() {
      sock.removeListener('data', onData);
      sock.pause();
      const rest = buf;
      buf = Buffer.alloc(0);
      return rest;
    },
  };
}

function pipeTo(client: net.Socket, port: number, rest: Buffer, onReady: () => void): void {
  const upstream = net.connect(port, '127.0.0.1', () => {
    onReady();
    if (rest.length > 0) upstream.write(rest);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
}

interface SocksLog {
  connections: number;
  greeting?: number[];
  auth?: { user: string; pass: string };
  atyp?: number;
  host?: string;
  port?: number;
}

/** Fake SOCKS5 proxy: records the handshake, then pipes to 127.0.0.1:{requested port}. */
async function startSocks5(opts: { credentials?: { user: string; pass: string }; replyCode?: number } = {}): Promise<{ proxy: NetworkProxy; log: SocksLog }> {
  const log: SocksLog = { connections: 0 };
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    log.connections++;
    const r = socketReader(sock);
    void (async () => {
      const greet = await r.read(2);
      const methods = [...(await r.read(greet.readUInt8(1)))];
      log.greeting = [greet.readUInt8(0), greet.readUInt8(1), ...methods];
      if (opts.credentials) {
        if (!methods.includes(0x02)) {
          sock.end(Buffer.from([0x05, 0xff]));
          return;
        }
        sock.write(Buffer.from([0x05, 0x02]));
        const v = await r.read(2);
        const user = (await r.read(v.readUInt8(1))).toString('utf8');
        const plen = (await r.read(1)).readUInt8(0);
        const pass = (await r.read(plen)).toString('utf8');
        log.auth = { user, pass };
        const ok = user === opts.credentials.user && pass === opts.credentials.pass;
        sock.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) {
          sock.end();
          return;
        }
      } else {
        sock.write(Buffer.from([0x05, 0x00]));
      }
      const req = await r.read(4);
      const atyp = req.readUInt8(3);
      log.atyp = atyp;
      if (atyp === 0x03) {
        const len = (await r.read(1)).readUInt8(0);
        log.host = (await r.read(len)).toString('utf8');
      } else if (atyp === 0x01) {
        log.host = [...(await r.read(4))].join('.');
      } else {
        log.host = (await r.read(16)).toString('hex');
      }
      const port = (await r.read(2)).readUInt16BE(0);
      log.port = port;
      if (opts.replyCode !== undefined) {
        sock.end(Buffer.from([0x05, opts.replyCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }
      pipeTo(sock, port, r.detach(), () => sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0])));
    })();
  });
  const port = await listen(server);
  const proxy: NetworkProxy = { type: 'socks5', host: '127.0.0.1', port };
  if (opts.credentials) {
    proxy.username = opts.credentials.user;
    proxy.password = opts.credentials.pass;
  }
  return { proxy, log };
}

/** Fake HTTP CONNECT proxy; `expectAuth` = required Proxy-Authorization value. */
async function startHttpConnect(expectAuth?: string): Promise<{ port: number; log: { lines: string[] } }> {
  const log = { lines: [] as string[] };
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    const r = socketReader(sock);
    void (async () => {
      const head = await r.readUntil('\r\n\r\n');
      const lines = head.split('\r\n');
      log.lines.push(...lines);
      const auth = lines.find((l) => l.toLowerCase().startsWith('proxy-authorization:'))?.slice(20).trim();
      if (expectAuth !== undefined && auth !== expectAuth) {
        sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="x"\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const target = (lines[0] ?? '').split(' ')[1] ?? '';
      const port = Number(target.slice(target.lastIndexOf(':') + 1));
      pipeTo(sock, port, r.detach(), () => sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'));
    })();
  });
  return { port: await listen(server), log };
}

/** In-process origin web server. */
async function startOrigin(handler?: http.RequestListener): Promise<number> {
  const server = http.createServer(handler ?? ((req, res) => {
    const url = req.url ?? '/';
    if (url === '/hello') {
      res.setHeader('x-test', 'yes');
      res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; HttpOnly']);
      res.setHeader('content-type', 'text/plain');
      res.end('hello world');
    } else if (url === '/chunked') {
      res.write('part1-');
      setTimeout(() => {
        res.write('part2-');
        res.end('part3');
      }, 5);
    } else if (url === '/gzip') {
      res.setHeader('content-encoding', 'gzip');
      res.end(zlib.gzipSync(Buffer.from('compressed payload '.repeat(50))));
    } else if (url === '/redirect') {
      res.writeHead(302, { location: '/hello' }).end();
    } else if (url === '/see-other') {
      req.resume();
      res.writeHead(303, { location: '/echo' }).end();
    } else if (url === '/nocontent') {
      res.writeHead(204).end();
    } else if (url === '/slow') {
      // never answers
    } else if (url.startsWith('/echo')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
    } else {
      res.writeHead(404).end('nope');
    }
  }));
  return listen(server);
}

interface FsCall { body: Record<string, unknown> }

/** Fake FlareSolverr `/v1` endpoint. */
async function startFlareSolverr(reply: (payload: Record<string, unknown>) => { status?: number; json: unknown }): Promise<{ url: string; calls: FsCall[] }> {
  const calls: FsCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url !== '/v1' || req.method !== 'POST') {
        res.writeHead(404).end('not found');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      calls.push({ body });
      const out = reply(body);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.json));
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/`, calls };
}

const okSolution = (cookies: unknown[] = [{ name: 'cf_clearance', value: 'abc', domain: '.origin.test', path: '/', expires: 1900000000 }]) => ({
  status: 'ok',
  message: 'Challenge solved!',
  version: '3.3.21',
  solution: { url: 'http://x/', status: 200, response: '<html></html>', headers: { server: 'cloudflare' }, cookies, userAgent: 'SolvedUA/1.0' },
});

async function expectProxyError(p: Promise<unknown>, code: ProxyError['code'], message?: RegExp): Promise<ProxyError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(ProxyError);
  const pe = err as ProxyError;
  expect(pe.code).toBe(code);
  if (message) expect(pe.message).toMatch(message);
  return pe;
}

// ---------------------------------------------------------------------------------------------
// SOCKS5
// ---------------------------------------------------------------------------------------------

describe('fetchWithProxy over SOCKS5', () => {
  it('performs a no-auth handshake with remote DNS (ATYP domain) and returns status, headers, cookies', async () => {
    const origin = await startOrigin();
    const { proxy, log } = await startSocks5();
    const res = await fetchWithProxy(`http://origin.test:${origin}/hello`, undefined, proxy);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-test')).toBe('yes');
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; HttpOnly']);
    expect(res.url).toBe(`http://origin.test:${origin}/hello`);
    expect(await res.text()).toBe('hello world');
    expect(log.greeting).toEqual([0x05, 0x01, 0x00]);
    expect(log.atyp).toBe(0x03);
    expect(log.host).toBe('origin.test');
    expect(log.port).toBe(origin);
  });

  it('negotiates RFC 1929 username/password auth', async () => {
    const origin = await startOrigin();
    const { proxy, log } = await startSocks5({ credentials: { user: 'alice', pass: 's3cret' } });
    const res = await fetchWithProxy(`http://origin.test:${origin}/hello`, {}, proxy);
    expect(await res.text()).toBe('hello world');
    expect(log.greeting).toEqual([0x05, 0x02, 0x00, 0x02]);
    expect(log.auth).toEqual({ user: 'alice', pass: 's3cret' });
  });

  it('maps rejected credentials to ProxyError auth', async () => {
    const { proxy } = await startSocks5({ credentials: { user: 'alice', pass: 'right' } });
    await expectProxyError(fetchWithProxy('http://origin.test/hello', {}, { ...proxy, password: 'wrong' }), 'auth');
  });

  it('maps a missing-credentials 0xFF method reply to ProxyError auth', async () => {
    const { proxy } = await startSocks5({ credentials: { user: 'alice', pass: 'x' } });
    const { username: _u, password: _p, ...anon } = proxy;
    await expectProxyError(openSocks5Tunnel(anon, 'origin.test', 80), 'auth', /requires authentication/);
  });

  it('maps CONNECT reply code 0x05 to ProxyError connect "connection refused"', async () => {
    const { proxy } = await startSocks5({ replyCode: 0x05 });
    await expectProxyError(fetchWithProxy('http://origin.test:1/hello', {}, proxy), 'connect', /connection refused/);
  });

  it('maps reply code 0x04 to host unreachable', async () => {
    const { proxy } = await startSocks5({ replyCode: 0x04 });
    await expectProxyError(openSocks5Tunnel(proxy, 'origin.test', 80), 'connect', /host unreachable/);
  });

  it('sends IPv4 literals as ATYP 0x01', async () => {
    const origin = await startOrigin();
    const { proxy, log } = await startSocks5();
    const res = await fetchWithProxy(`http://127.0.0.1:${origin}/hello`, {}, proxy);
    expect(res.status).toBe(200);
    expect(log.atyp).toBe(0x01);
    expect(log.host).toBe('127.0.0.1');
  });

  it('reports an unreachable proxy as ProxyError connect', async () => {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise<void>((r) => server.close(() => r()));
    await expectProxyError(openSocks5Tunnel({ type: 'socks5', host: '127.0.0.1', port }, 'origin.test', 80, 5000), 'connect');
  });

  it('decodes a chunked body', async () => {
    const origin = await startOrigin();
    const { proxy } = await startSocks5();
    const res = await fetchWithProxy(`http://origin.test:${origin}/chunked`, {}, proxy);
    expect(await res.text()).toBe('part1-part2-part3');
  });

  it('decompresses a gzip body', async () => {
    const origin = await startOrigin();
    const { proxy } = await startSocks5();
    const res = await fetchWithProxy(`http://origin.test:${origin}/gzip`, {}, proxy);
    expect(await res.text()).toBe('compressed payload '.repeat(50));
  });

  it('follows redirects, re-tunnelling per hop', async () => {
    const origin = await startOrigin();
    const { proxy, log } = await startSocks5();
    const res = await fetchWithProxy(`http://origin.test:${origin}/redirect`, {}, proxy);
    expect(res.status).toBe(200);
    expect(res.url).toBe(`http://origin.test:${origin}/hello`);
    expect(res.redirected).toBe(true);
    expect(await res.text()).toBe('hello world');
    expect(log.connections).toBe(2);
  });

  it('returns the 3xx response with redirect: manual', async () => {
    const origin = await startOrigin();
    const { proxy } = await startSocks5();
    const res = await fetchWithProxy(`http://origin.test:${origin}/redirect`, { redirect: 'manual' }, proxy);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/hello');
  });

  it('sends POST bodies with Content-Length and content-type, and turns POST into GET on 303', async () => {
    const origin = await startOrigin();
    const { proxy } = await startSocks5();
    const res = await fetchWithProxy(`http://origin.test:${origin}/echo?x=1`, {
      method: 'POST',
      body: new URLSearchParams({ user: 'bob', pass: 'a b' }),
      headers: [['X-Custom', 'v1']],
    }, proxy);
    const echo = (await res.json()) as { method: string; url: string; headers: Record<string, string>; body: string };
    expect(echo.method).toBe('POST');
    expect(echo.url).toBe('/echo?x=1');
    expect(echo.body).toBe('user=bob&pass=a+b');
    expect(echo.headers['content-type']).toMatch(/^application\/x-www-form-urlencoded/);
    expect(echo.headers['content-length']).toBe(String('user=bob&pass=a+b'.length));
    expect(echo.headers['x-custom']).toBe('v1');
    expect(echo.headers['host']).toBe(`origin.test:${origin}`);
    expect(echo.headers['accept-encoding']).toBe('gzip, deflate');

    const after = await fetchWithProxy(`http://origin.test:${origin}/see-other`, { method: 'POST', body: 'payload' }, proxy);
    const echo2 = (await after.json()) as { method: string; body: string };
    expect(echo2.method).toBe('GET');
    expect(echo2.body).toBe('');
  });

  it('returns a null body for 204', async () => {
    const origin = await startOrigin();
    const { proxy } = await startSocks5();
    const res = await fetchWithProxy(`http://origin.test:${origin}/nocontent`, {}, proxy);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it('rejects with the abort reason when the signal fires', async () => {
    const origin = await startOrigin();
    const { proxy } = await startSocks5();
    const controller = new AbortController();
    const reason = new Error('stop now');
    setTimeout(() => controller.abort(reason), 50);
    await expect(fetchWithProxy(`http://origin.test:${origin}/slow`, { signal: controller.signal }, proxy)).rejects.toBe(reason);
  });

  it('delegates to fetchImpl when no proxy is given', async () => {
    const calls: string[] = [];
    const fake = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('fake');
    }) as typeof fetch;
    const res = await fetchWithProxy('http://example.invalid/x', undefined, undefined, fake);
    expect(await res.text()).toBe('fake');
    expect(calls).toEqual(['http://example.invalid/x']);
  });
});

// ---------------------------------------------------------------------------------------------
// HTTP CONNECT
// ---------------------------------------------------------------------------------------------

describe('HTTP CONNECT proxy', () => {
  const basic = `Basic ${Buffer.from('bob:pw').toString('base64')}`;

  it('tunnels with Basic proxy auth', async () => {
    const origin = await startOrigin();
    const { port, log } = await startHttpConnect(basic);
    const proxy: NetworkProxy = { type: 'http', host: '127.0.0.1', port, username: 'bob', password: 'pw' };
    const res = await fetchWithProxy(`http://origin.test:${origin}/hello`, {}, proxy);
    expect(await res.text()).toBe('hello world');
    expect(log.lines[0]).toBe(`CONNECT origin.test:${origin} HTTP/1.1`);
    expect(log.lines).toContain(`Host: origin.test:${origin}`);
    expect(log.lines).toContain(`Proxy-Authorization: ${basic}`);
  });

  it('maps 407 to ProxyError auth', async () => {
    const { port } = await startHttpConnect(basic);
    await expectProxyError(openHttpConnectTunnel({ type: 'http', host: '127.0.0.1', port }, 'origin.test', 80), 'auth', /407/);
  });
});

// ---------------------------------------------------------------------------------------------
// Challenge detection
// ---------------------------------------------------------------------------------------------

describe('isChallengeResponse', () => {
  it('detects Cloudflare / DDoS-Guard challenge pages and the 1020 body', () => {
    const cf = new Headers({ server: 'cloudflare' });
    expect(isChallengeResponse(503, cf, '<title>Just a moment...</title>')).toBe(true);
    expect(isChallengeResponse(403, new Headers({ server: 'cloudflare-nginx' }), '<title>Attention Required! | Cloudflare</title>')).toBe(true);
    expect(isChallengeResponse(403, new Headers({ server: 'DDoS-Guard' }), 'DDOS-GUARD check')).toBe(true);
    expect(isChallengeResponse(403, new Headers(), 'error code: 1020')).toBe(true);
    expect(isChallengeResponse(503, new Headers({ vary: 'Accept-Encoding, User-Agent' }), 'ddos protection')).toBe(true);
    expect(CHALLENGE_MARKERS).toContain('just a moment...');
  });

  it('rejects ordinary responses', () => {
    const cf = new Headers({ server: 'cloudflare' });
    expect(isChallengeResponse(200, cf, 'Just a moment...')).toBe(false);
    expect(isChallengeResponse(503, new Headers({ server: 'nginx' }), 'Just a moment...')).toBe(false);
    expect(isChallengeResponse(503, cf, 'service unavailable')).toBe(false);
    expect(isChallengeResponse(403, new Headers({ vary: 'Accept-Encoding,User-Agent', 'content-encoding': 'gzip' }), 'ddos')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// FlareSolverr client
// ---------------------------------------------------------------------------------------------

describe('FlareSolverrClient', () => {
  it('sends request.get with url, maxTimeout and the forwarded proxy; parses the solution', async () => {
    const fs = await startFlareSolverr(() => ({ json: okSolution() }));
    const client = new FlareSolverrClient({ type: 'flaresolverr', url: fs.url, timeoutMs: 1234 }, {
      proxy: { type: 'socks5', host: '10.0.0.2', port: 1080, username: 'u', password: 'p' },
    });
    const solution = await client.get('https://site.test/page');
    expect(fs.calls[0]?.body).toEqual({
      cmd: 'request.get',
      url: 'https://site.test/page',
      maxTimeout: 1234,
      proxy: { url: 'socks5://10.0.0.2:1080', username: 'u', password: 'p' },
    });
    expect(solution.userAgent).toBe('SolvedUA/1.0');
    expect(solution.cookies).toEqual([{ name: 'cf_clearance', value: 'abc', domain: '.origin.test', path: '/', expires: 1900000000 }]);
    expect(solution.headers).toEqual({ server: 'cloudflare' });
  });

  it('sends request.post with postData and the default 60 s maxTimeout', async () => {
    const fs = await startFlareSolverr(() => ({ json: okSolution() }));
    const client = new FlareSolverrClient({ type: 'flaresolverr', url: fs.url.replace(/\/$/, '') });
    await client.post('https://site.test/login', 'user=a&pass=b');
    expect(fs.calls[0]?.body).toEqual({ cmd: 'request.post', url: 'https://site.test/login', postData: 'user=a&pass=b', maxTimeout: 60_000 });
  });

  it('creates one session lazily, reuses it and destroys it', async () => {
    const fs = await startFlareSolverr((p) => (p['cmd'] === 'sessions.create'
      ? { json: { status: 'ok', message: 'Session created', session: 'sess-1' } }
      : p['cmd'] === 'sessions.destroy'
        ? { json: { status: 'ok', message: 'Session destroyed' } }
        : { json: okSolution() }));
    const client = new FlareSolverrClient({ type: 'flaresolverr', url: fs.url, useSession: true });
    await Promise.all([client.get('https://a.test/'), client.get('https://b.test/')]);
    await client.post('https://a.test/', 'x=1');
    await client.destroy();
    const cmds = fs.calls.map((c) => c.body['cmd']);
    expect(cmds.filter((c) => c === 'sessions.create')).toHaveLength(1);
    expect(fs.calls.filter((c) => String(c.body['cmd']).startsWith('request.')).every((c) => c.body['session'] === 'sess-1')).toBe(true);
    expect(fs.calls.at(-1)?.body).toEqual({ cmd: 'sessions.destroy', session: 'sess-1' });
  });

  it('maps HTTP 500 status:error to ProxyError flaresolverr with the solver message', async () => {
    const fs = await startFlareSolverr(() => ({ status: 500, json: { status: 'error', message: 'Error: Error solving the challenge. Timeout after 60.0 seconds.' } }));
    const client = new FlareSolverrClient({ type: 'flaresolverr', url: fs.url });
    await expectProxyError(client.get('https://site.test/'), 'flaresolverr', /Timeout after 60\.0 seconds/);
  });

  it('rejects HTTP statuses other than 200 and 500', async () => {
    const fs = await startFlareSolverr(() => ({ status: 502, json: {} }));
    await expectProxyError(new FlareSolverrClient({ type: 'flaresolverr', url: fs.url }).get('https://x.test/'), 'flaresolverr', /HTTP 502/);
  });

  it('throws "Empty cookies returned by FlareSolverr" when the solution has no cookies', async () => {
    const fs = await startFlareSolverr(() => ({ json: okSolution([]) }));
    const client = new FlareSolverrClient({ type: 'flaresolverr', url: fs.url });
    await expectProxyError(client.get('https://site.test/'), 'flaresolverr', /^Empty cookies returned by FlareSolverr$/);
  });

  it('test() reports ok with version, or a failure message', async () => {
    const fs = await startFlareSolverr(() => ({ json: { status: 'ok', version: '3.3.21', solution: { cookies: [] } } }));
    expect(await new FlareSolverrClient({ type: 'flaresolverr', url: fs.url }).test()).toEqual({ ok: true, version: '3.3.21' });
    expect(fs.calls[0]?.body['cmd']).toBe('request.get');
    const bad = await new FlareSolverrClient({ type: 'flaresolverr', url: `${fs.url}nope` }).test();
    expect(bad.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// createProxiedFetch
// ---------------------------------------------------------------------------------------------

/** Origin that answers a Cloudflare-style 503 unless cf_clearance=abc and the solved UA are sent. */
async function startProtectedOrigin(): Promise<{ port: number; hits: Array<{ ua: string | undefined; cookie: string | undefined; method: string | undefined }> }> {
  const hits: Array<{ ua: string | undefined; cookie: string | undefined; method: string | undefined }> = [];
  const port = await startOrigin((req, res) => {
    req.resume();
    hits.push({ ua: req.headers['user-agent'], cookie: req.headers.cookie, method: req.method });
    const cleared = /(?:^|;\s*)cf_clearance=abc(?:;|$)/.test(req.headers.cookie ?? '') && req.headers['user-agent'] === 'SolvedUA/1.0';
    if (!cleared) {
      res.writeHead(503, { server: 'cloudflare', 'content-type': 'text/html' }).end('<html><title>Just a moment...</title></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`secret for ${req.method}`);
  });
  return { port, hits };
}

describe('createProxiedFetch', () => {
  it('solves a challenge via FlareSolverr, replays with cookie + UA, and reuses the cached UA', async () => {
    const origin = await startProtectedOrigin();
    const fs = await startFlareSolverr(() => ({ json: okSolution() }));
    const jar = new CookieJar({ session: 'keep' });
    const userAgents = new Map<string, string>();
    const f = createProxiedFetch([{ type: 'flaresolverr', url: fs.url }], { jar, userAgents });
    const target = `http://127.0.0.1:${origin.port}/search?q=x`;

    const res = await f(target, { headers: { cookie: 'session=keep' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('secret for GET');
    expect(fs.calls).toHaveLength(1);
    expect(fs.calls[0]?.body['url']).toBe(target);
    expect(jar.get('cf_clearance')).toBe('abc');
    expect(userAgents.get(`127.0.0.1:${origin.port}`)).toBe('SolvedUA/1.0');
    expect(origin.hits[1]?.cookie).toBe('session=keep; cf_clearance=abc');

    const again = await f(target, { headers: { cookie: jar.header() ?? '' } });
    expect(await again.text()).toBe('secret for GET');
    expect(origin.hits.at(-1)?.ua).toBe('SolvedUA/1.0');
    expect(fs.calls).toHaveLength(1);
  });

  it('solves POST form requests with request.post and replays the POST', async () => {
    const origin = await startProtectedOrigin();
    const fs = await startFlareSolverr(() => ({ json: okSolution() }));
    const f = createProxiedFetch({ type: 'flaresolverr', url: fs.url });
    const res = await f(`http://127.0.0.1:${origin.port}/login`, { method: 'POST', body: new URLSearchParams({ u: 'a' }) });
    expect(await res.text()).toBe('secret for POST');
    expect(fs.calls[0]?.body).toMatchObject({ cmd: 'request.post', postData: 'u=a' });
  });

  it('refuses non-urlencoded POST bodies with "Unsupported POST Content-Type"', async () => {
    const origin = await startProtectedOrigin();
    const fs = await startFlareSolverr(() => ({ json: okSolution() }));
    const f = createProxiedFetch({ type: 'flaresolverr', url: fs.url });
    await expectProxyError(
      f(`http://127.0.0.1:${origin.port}/api`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
      'flaresolverr',
      /^Unsupported POST Content-Type/,
    );
    expect(fs.calls).toHaveLength(0);
  });

  it('routes through the network proxy and forwards it to FlareSolverr (first of each kind wins)', async () => {
    const origin = await startProtectedOrigin();
    const fs = await startFlareSolverr(() => ({ json: okSolution() }));
    const { proxy, log } = await startSocks5();
    const f = createProxiedFetch([
      proxy,
      { type: 'http', host: '127.0.0.1', port: 9 },
      { type: 'flaresolverr', url: fs.url },
      { type: 'flaresolverr', url: 'http://127.0.0.1:9/' },
    ]);
    const res = await f(`http://origin.test:${origin.port}/x`);
    expect(await res.text()).toBe('secret for GET');
    expect(log.connections).toBe(2);
    expect(log.host).toBe('origin.test');
    expect(fs.calls[0]?.body['proxy']).toEqual({ url: `socks5://127.0.0.1:${proxy.port}` });
  });

  it('passes non-challenge responses straight through without calling FlareSolverr', async () => {
    const origin = await startOrigin();
    const fs = await startFlareSolverr(() => ({ json: okSolution() }));
    const f = createProxiedFetch([{ type: 'flaresolverr', url: fs.url }]);
    const res = await f(`http://127.0.0.1:${origin}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('nope');
    expect(fs.calls).toHaveLength(0);
  });

  it('fails with CloudflareChallenge when the replay is still challenged', async () => {
    const origin = await startProtectedOrigin();
    const fs = await startFlareSolverr(() => ({ json: { ...okSolution(), solution: { ...okSolution().solution, userAgent: 'OtherUA' } } }));
    const f = createProxiedFetch([{ type: 'flaresolverr', url: fs.url }]);
    await expectProxyError(f(`http://127.0.0.1:${origin.port}/x`), 'flaresolverr', /CloudflareChallenge/);
  });
});
