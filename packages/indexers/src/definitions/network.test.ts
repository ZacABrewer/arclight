// In-process HTTP servers: form login with cookies/CSRF, relogin, cookie/post login methods,
// FlareSolverr challenge solving and SOCKS5 tunnelling through the definition runtime.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import torznabCaps from '../../fixtures/torznab-caps.xml?raw';
import { createIndexer } from '../index.js';
import { IndexerError } from '../types.js';
import { parseDefinitionYaml } from './catalogue.js';
import { CookieJar } from './cookies.js';
import { createDefinitionIndexer } from './indexer.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function startHttp(handler: Handler): Promise<{ server: Server; base: string; port: number }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}/`, port };
}

function cookiesOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = v.join('=');
  }
  return out;
}

const noSleep = async (): Promise<void> => {};
const TORRENT = 'd8:announce20:http://tracker/announce4:infod4:name4:teste';

// ------------------------------------------------------------------------------------------
// Fake private tracker

interface SiteState {
  logins: number;
  killNextSession: boolean;
  sessions: Set<string>;
  lastLoginBody: string;
  searchCookies: string[];
}

const state: SiteState = { logins: 0, killNextSession: false, sessions: new Set(), lastLoginBody: '', searchCookies: [] };
let site: { server: Server; base: string; port: number };

const LOGIN_PAGE = `<html><body>
<form id="other" action="/nope"><input name="q"></form>
<form id="login" method="post" action="takelogin.php">
  <input type="hidden" name="csrf" value="tok123">
  <input type="hidden" name="disabledfield" value="x" disabled>
  <input type="checkbox" name="remember" value="1">
  <input type="checkbox" name="keep" value="yes" checked>
  <input type="text" name="username">
  <input type="password" name="password">
  <input type="submit" name="go" value="Login">
</form></body></html>`;

const RESULTS = `<html><body><a href="logout.php">Logout</a><table>
<tr class="t"><td class="n"><a href="details.php?id=1">Private.Release.2024.1080p</a></td><td class="s">2 GB</td>
<td><a class="dl" href="download.php?id=1">dl</a></td><td class="h">0123456789abcdef0123456789abcdef01234567</td></tr>
</table></body></html>`;

beforeAll(async () => {
  site = await startHttp((req, res, body) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const cookies = cookiesOf(req);
    const authed = cookies['uid'] !== undefined && state.sessions.has(cookies['uid']);
    if (url.pathname === '/login.php') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'PHPSESSID=s1; Path=/; HttpOnly' });
      res.end(LOGIN_PAGE);
      return;
    }
    if (url.pathname === '/takelogin.php') {
      state.lastLoginBody = body;
      const form = new URLSearchParams(body);
      if (cookies['PHPSESSID'] !== 's1' || form.get('csrf') !== 'tok123') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<div class="error"><span>CSRF check failed</span></div>');
        return;
      }
      if (form.get('username') !== 'alice' || form.get('password') !== 'secret') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><div class="error">Error: <span>Invalid credentials</span></div></html>');
        return;
      }
      state.logins++;
      const uid = `u${state.logins}`;
      state.sessions.add(uid);
      res.writeHead(302, { location: '/index.php', 'set-cookie': [`uid=${uid}; Path=/`, 'pass=hash; Path=/'] });
      res.end();
      return;
    }
    if (url.pathname === '/index.php') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(authed ? '<a href="logout.php">Logout</a>' : '<a href="login.php">Login</a>');
      return;
    }
    if (url.pathname === '/browse.php' || url.pathname === '/download.php') {
      if (authed && state.killNextSession && url.pathname === '/browse.php') {
        state.killNextSession = false;
        state.sessions.delete(cookies['uid'] ?? '');
      }
      if (!cookies['uid'] || !state.sessions.has(cookies['uid'])) {
        res.writeHead(302, { location: '/login.php?returnto=browse' });
        res.end();
        return;
      }
      if (url.pathname === '/download.php') {
        res.writeHead(200, { 'content-type': 'application/x-bittorrent' });
        res.end(TORRENT);
        return;
      }
      state.searchCookies.push(req.headers.cookie ?? '');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(RESULTS);
      return;
    }
    if (url.pathname === '/cookie-browse.php') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(cookies['session'] === 'abc' && cookies['remember'] === 'yes' ? RESULTS : '<a href="login.php">Login</a>');
      return;
    }
    if (url.pathname === '/api-login') {
      const form = new URLSearchParams(body);
      const ok = req.method === 'POST' && form.get('user') === 'alice' && form.get('pass') === 'secret' && cookies['lang'] === 'en';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'text/html', ...(ok ? { 'set-cookie': 'uid=apisess' } : {}) });
      if (ok) state.sessions.add('apisess');
      res.end(ok ? 'welcome' : 'denied');
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => site.server.close(() => resolve()));
});

const privateDefinition = (method = 'form'): string => `
id: fakeprivate
name: FakePrivate
type: private
links: [${site.base}]
caps:
  categorymappings: [{id: 1, cat: Movies/HD, desc: "Movies"}]
  modes: {search: [q]}
login:
  method: ${method}
  path: ${method === 'post' ? 'api-login' : 'login.php'}
  form: "form#login"
  cookies: ["lang=en"]
  inputs:
    ${method === 'post' ? 'user' : 'username'}: "{{ .Config.username }}"
    ${method === 'post' ? 'pass' : 'password'}: "{{ .Config.password }}"
  error:
    - selector: "div.error"
      message: {selector: "div.error span"}
  test:
    path: index.php
    selector: "a[href='logout.php']"
search:
  paths:
    - path: browse.php
  inputs:
    search: "{{ .Keywords }}"
  rows: {selector: "tr.t"}
  fields:
    category: {text: 1}
    title: {selector: "td.n a"}
    details: {selector: "td.n a", attribute: href}
    download: {selector: "a.dl", attribute: href}
    size: {selector: "td.s"}
    infohash: {selector: "td.h"}
`;

describe('login flows against a fake site', () => {
  it('form login: hidden inputs, CSRF cookie, redirect cookies, then search', async () => {
    const before = state.logins;
    const indexer = createDefinitionIndexer(privateDefinition(), { username: 'alice', password: 'secret' }, { sleep: noSleep });
    const releases = await indexer.search({ kind: 'search', query: 'private release' });
    expect(state.logins).toBe(before + 1);
    const sent = new URLSearchParams(state.lastLoginBody);
    expect(sent.get('csrf')).toBe('tok123');
    expect(sent.get('keep')).toBe('yes');
    expect(sent.has('remember')).toBe(false);
    expect(sent.has('disabledfield')).toBe(false);
    expect(sent.has('go')).toBe(false);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      title: 'Private.Release.2024.1080p',
      infoUrl: `${site.base}details.php?id=1`,
      downloadUrl: `${site.base}download.php?id=1`,
      size: 2 * 1024 ** 3,
      infoHash: '0123456789abcdef0123456789abcdef01234567',
      categories: [2040, 100001],
    });
    // private trackers never get a synthesised magnet (S2.3)
    expect(releases[0]?.magnetUrl).toBeUndefined();
    expect(indexer.runtime.jar.get('uid')).toBe(`u${before + 1}`);
    expect(indexer.runtime.jar.get('pass')).toBe('hash');
    expect(state.searchCookies.at(-1)).toContain('lang=en');

    // download sends the session cookies
    const dl = await indexer.download(releases[0]?.downloadUrl ?? '');
    expect(dl.kind).toBe('torrent');
    if (dl.kind === 'torrent') expect(new TextDecoder().decode(dl.data)).toBe(TORRENT);
  });

  it('relogs in once when the session is lost', async () => {
    const indexer = createDefinitionIndexer(privateDefinition(), { username: 'alice', password: 'secret' }, { sleep: noSleep });
    await indexer.search({ kind: 'search', query: 'x' });
    const before = state.logins;
    state.killNextSession = true;
    const releases = await indexer.search({ kind: 'search', query: 'x' });
    expect(releases).toHaveLength(1);
    expect(state.logins).toBe(before + 1);
  });

  it('surfaces error-block messages as auth errors without leaking the password', async () => {
    const indexer = createDefinitionIndexer(privateDefinition(), { username: 'alice', password: 'wrong-pw' }, { sleep: noSleep });
    const err = await indexer.search({ kind: 'search', query: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).code).toBe('auth');
    expect((err as IndexerError).message).toBe('Login failed: Invalid credentials');
    expect((err as IndexerError).message).not.toContain('wrong-pw');
    const result = await indexer.test();
    expect(result.ok).toBe(false);
  });

  it('post login method with seed cookies; 401 is an auth error', async () => {
    const ok = createDefinitionIndexer(privateDefinition('post'), { username: 'alice', password: 'secret' }, { sleep: noSleep });
    await ok.login();
    expect(ok.runtime.jar.get('uid')).toBe('apisess');
    expect((await ok.search({ kind: 'search', query: 'x' })).length).toBe(1);
    const bad = createDefinitionIndexer(privateDefinition('post'), { username: 'alice', password: 'nope' }, { sleep: noSleep });
    await expect(bad.login()).rejects.toMatchObject({ code: 'auth' });
  });

  it('cookie login method loads the jar from the cookie setting', async () => {
    const def = parseDefinitionYaml(
      privateDefinition('cookie')
        .replace('path: browse.php', 'path: cookie-browse.php')
        .replace(/test:\n {4}path: index.php\n/, 'test:\n')
        .replace('caps:', 'settings:\n  - {name: cookie, type: text, label: Cookie}\ncaps:'),
    );
    const indexer = createDefinitionIndexer(def, { cookie: 'session=abc; remember=yes' }, { sleep: noSleep });
    const releases = await indexer.search({ kind: 'search', query: 'x' });
    expect(releases).toHaveLength(1);
    expect(indexer.runtime.jar.toJSON()).toEqual({ session: 'abc', remember: 'yes' });
    const expired = createDefinitionIndexer(def, { cookie: 'session=old' }, { sleep: noSleep });
    await expect(expired.search({ kind: 'search', query: 'x' })).rejects.toMatchObject({ code: 'auth' });
  });

  it('reuses a persisted cookie jar without logging in', async () => {
    const seed = createDefinitionIndexer(privateDefinition(), { username: 'alice', password: 'secret' }, { sleep: noSleep });
    await seed.login();
    const before = state.logins;
    const jar = new CookieJar(seed.runtime.jar.toJSON());
    jar.expiresAt = Date.now() + 60_000;
    const restored = createDefinitionIndexer(privateDefinition(), { username: 'alice', password: 'secret' }, { jar, sleep: noSleep });
    expect((await restored.search({ kind: 'search', query: 'x' })).length).toBe(1);
    expect(state.logins).toBe(before);
  });
});

// ------------------------------------------------------------------------------------------
// FlareSolverr

describe('FlareSolverr through the runtime', () => {
  let origin: { server: Server; base: string };
  let solver: { server: Server; base: string };
  const solverCalls: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    origin = await startHttp((req, res) => {
      const ok = cookiesOf(req)['cf_clearance'] === 'cleared' && req.headers['user-agent'] === 'SolvedBrowser/1.0';
      if (!ok) {
        res.writeHead(503, { server: 'cloudflare', 'content-type': 'text/html' });
        res.end('<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(RESULTS.replace('<a href="logout.php">Logout</a>', ''));
    });
    solver = await startHttp((_req, res, body) => {
      const payload = JSON.parse(body) as Record<string, unknown>;
      solverCalls.push(payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          message: '',
          solution: {
            url: payload['url'],
            status: 200,
            headers: {},
            response: '<html></html>',
            cookies: [{ name: 'cf_clearance', value: 'cleared', domain: '127.0.0.1', path: '/' }],
            userAgent: 'SolvedBrowser/1.0',
          },
        }),
      );
    });
  });

  afterAll(async () => {
    await Promise.all([origin, solver].map((s) => new Promise<void>((r) => s.server.close(() => r()))));
  });

  it('solves the challenge, imports cookies and reuses the solved user agent', async () => {
    const def = privateDefinition()
      .replace(/login:[\s\S]*?search:/, 'search:')
      .replace('type: private', 'type: public')
      .replace(site.base, origin.base);
    const indexer = createDefinitionIndexer(def, {}, {
      sleep: noSleep,
      proxy: { type: 'flaresolverr', url: solver.base, timeoutMs: 5000 },
    });
    const first = await indexer.search({ kind: 'search', query: 'x' });
    expect(first).toHaveLength(1);
    expect(solverCalls).toHaveLength(1);
    expect(solverCalls[0]).toMatchObject({ cmd: 'request.get', maxTimeout: 5000 });
    expect(String(solverCalls[0]?.['url'])).toContain(`${origin.base}browse.php`);
    expect(indexer.runtime.jar.get('cf_clearance')).toBe('cleared');
    const second = await indexer.search({ kind: 'search', query: 'y' });
    expect(second).toHaveLength(1);
    expect(solverCalls).toHaveLength(1); // no second solve
  });
});

// ------------------------------------------------------------------------------------------
// SOCKS5

describe('SOCKS5 proxy', () => {
  let socks: TcpServer;
  let socksPort = 0;
  const targets: string[] = [];
  let origin: { server: Server; base: string; port: number };

  beforeAll(async () => {
    origin = await startHttp((req, res) => {
      if ((req.url ?? '').includes('t=caps')) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(torznabCaps);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(RESULTS);
    });
    socks = createTcpServer((client: Socket) => {
      let stage = 0;
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0 && buf.length >= 2 && buf.length >= 2 + (buf[1] ?? 0)) {
          if (buf[0] !== 5) return void client.destroy();
          client.write(Buffer.from([5, 0]));
          buf = buf.subarray(2 + (buf[1] ?? 0));
          stage = 1;
        }
        if (stage === 1 && buf.length >= 5) {
          const atyp = buf[3];
          let host = '';
          let offset = 4;
          if (atyp === 3) {
            const len = buf[4] ?? 0;
            if (buf.length < 5 + len + 2) return;
            host = buf.subarray(5, 5 + len).toString('utf8');
            offset = 5 + len;
          } else if (atyp === 1) {
            if (buf.length < 10) return;
            host = [...buf.subarray(4, 8)].join('.');
            offset = 8;
          }
          const port = buf.readUInt16BE(offset);
          targets.push(`${host}:${port}`);
          client.off('data', onData);
          const upstream = connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            const rest = buf.subarray(offset + 2);
            if (rest.length) upstream.write(rest);
            client.pipe(upstream).pipe(client);
          });
          upstream.on('error', () => client.destroy());
          stage = 2;
        }
      };
      client.on('data', onData);
      client.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => socks.listen(0, '127.0.0.1', resolve));
    const address = socks.address();
    socksPort = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((r) => socks.close(() => r()));
    await new Promise<void>((r) => origin.server.close(() => r()));
  });

  it('routes definition searches through the SOCKS5 tunnel (remote DNS)', async () => {
    const def = privateDefinition()
      .replace(/login:[\s\S]*?search:/, 'search:')
      .replace(site.base, `http://localhost:${origin.port}/`);
    const throwingFetch = (() => {
      throw new Error('direct fetch must not be used');
    }) as unknown as typeof fetch;
    const indexer = createDefinitionIndexer(def, {}, {
      sleep: noSleep,
      fetchImpl: throwingFetch,
      proxy: { type: 'socks5', host: '127.0.0.1', port: socksPort },
    });
    const releases = await indexer.search({ kind: 'search', query: 'x' });
    expect(releases).toHaveLength(1);
    expect(targets).toContain(`localhost:${origin.port}`);
  });

  it('routes Torznab clients through the proxy via IndexerDefinition.proxy', async () => {
    targets.length = 0;
    const indexer = createIndexer({
      name: 'jackett',
      baseUrl: `http://localhost:${origin.port}`,
      apiKey: 'k',
      categories: [2000],
      protocol: 'torrent',
      proxy: { type: 'socks5', host: '127.0.0.1', port: socksPort },
    });
    const caps = await indexer.caps();
    expect(caps.categories.length).toBeGreaterThan(0);
    expect(targets).toEqual([`localhost:${origin.port}`]);
  });
});
