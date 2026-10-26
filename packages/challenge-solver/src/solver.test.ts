import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleFlareSolverrCommand } from './flaresolverr-api.js';
import type { LaunchedBrowser } from './launch.js';
import { ChallengeSolver, normalizeUserAgent, type ChallengeSolverOptions } from './solver.js';
import { FakeCdpServer } from './testing/fake-cdp-server.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const CHALLENGE = fixture('cf-js-challenge.html');
const TURNSTILE = fixture('cf-turnstile.html');
const NORMAL = fixture('normal.html');
const CLEARANCE = { name: 'cf_clearance', value: 'tok123', domain: '.tracker.example', path: '/', expires: 1893456000.5, httpOnly: true, secure: true, session: false, sameSite: 'None' };

let server: FakeCdpServer;
let launches: number;
let killed: number;
const solvers: ChallengeSolver[] = [];

function makeSolver(extra: Partial<ChallengeSolverOptions> = {}): ChallengeSolver {
  const solver = new ChallengeSolver({
    executablePath: 'msedge.exe',
    userDataDir: 'unused',
    pollIntervalMs: 5,
    timeoutMs: 2000,
    idleCloseMs: 0,
    launch: async (): Promise<LaunchedBrowser> => {
      launches += 1;
      let exit!: () => void;
      const exited = new Promise<void>((r) => (exit = r));
      return {
        wsEndpoint: server.url,
        pid: 1,
        exited,
        kill: async () => {
          killed += 1;
          exit();
        },
      };
    },
    ...extra,
  });
  solvers.push(solver);
  return solver;
}

beforeEach(async () => {
  launches = 0;
  killed = 0;
  server = new FakeCdpServer();
  await server.start();
});

afterEach(async () => {
  for (const s of solvers.splice(0)) await s.close();
  await server.stop();
});

describe('ChallengeSolver', () => {
  it('returns the page untouched when there is no challenge', async () => {
    server.sites.set('https://example.com/', { states: [{ title: 'Example Domain', html: NORMAL, status: 200, headers: { 'Content-Type': 'text/html' } }] });
    const res = await makeSolver().solve({ method: 'GET', url: 'https://example.com/' });
    expect(res).toMatchObject({ url: 'https://example.com/', status: 200, challenged: false, cookies: [] });
    expect(res.html).toContain('Example Domain');
    expect(res.headers).toEqual({ 'content-type': 'text/html' });
  });

  it('waits out a JS challenge and returns the cleared page with cf_clearance', async () => {
    server.sites.set('https://tracker.example/', {
      states: [
        { title: 'Just a moment...', html: CHALLENGE, status: 403, headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' }, polls: 3 },
        { title: 'Tracker', html: '<html><head><title>Tracker</title></head><body>rows</body></html>', status: 200 },
      ],
      cookies: [CLEARANCE],
    });
    const res = await makeSolver().solve({ method: 'GET', url: 'https://tracker.example/' });
    expect(res.challenged).toBe(true);
    expect(res.status).toBe(200);
    expect(res.html).toContain('rows');
    expect(res.cookies).toEqual([{ name: 'cf_clearance', value: 'tok123', domain: '.tracker.example', path: '/', expires: 1893456000, httpOnly: true, secure: true, sameSite: 'None' }]);
    expect(server.methods().filter((m) => m === 'Runtime.evaluate').length).toBeGreaterThanOrEqual(4);
  });

  it('presents a non-headless user agent to pages and in the result', async () => {
    server.sites.set('https://example.com/', { states: [{ title: 'ok', html: NORMAL }] });
    const res = await makeSolver().solve({ method: 'GET', url: 'https://example.com/' });
    expect(res.userAgent).not.toContain('Headless');
    expect(res.userAgent).toContain('Chrome/130.0.0.0');
    const override = server.calls.find((c) => c.method === 'Network.setUserAgentOverride');
    expect(override?.params['userAgent']).toBe(res.userAgent);
    expect(normalizeUserAgent('Mozilla/5.0 HeadlessChrome/1.0')).toBe('Mozilla/5.0 Chrome/1.0');
  });

  it('times out on a challenge that never clears and hints at Turnstile', async () => {
    server.sites.set('https://hard.example/', { states: [{ title: 'Just a moment...', html: TURNSTILE, status: 403 }] });
    await expect(makeSolver().solve({ method: 'GET', url: 'https://hard.example/', timeoutMs: 60 })).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringMatching(/Timeout after 0 seconds\. The page shows an interactive Turnstile challenge/),
    });
  });

  it('fails fast on a 1020 block and on navigation errors', async () => {
    server.sites.set('https://blocked.example/', { states: [{ title: 'Access denied', html: fixture('cf-1020.html'), status: 403 }] });
    server.sites.set('https://nxdomain.example/', { states: [], navigateError: 'net::ERR_NAME_NOT_RESOLVED' });
    const solver = makeSolver();
    await expect(solver.solve({ method: 'GET', url: 'https://blocked.example/' })).rejects.toMatchObject({ code: 'blocked' });
    await expect(solver.solve({ method: 'GET', url: 'https://nxdomain.example/' })).rejects.toMatchObject({ code: 'navigation' });
    await expect(solver.solve({ method: 'GET', url: 'ftp://x/' })).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('reuses one tab per host and opens another for a different host', async () => {
    for (const u of ['https://a.example/1', 'https://a.example/2', 'https://b.example/']) server.sites.set(u, { states: [{ title: 'ok', html: NORMAL }] });
    const solver = makeSolver();
    await solver.solve({ method: 'GET', url: 'https://a.example/1' });
    await solver.solve({ method: 'GET', url: 'https://a.example/2' });
    await solver.solve({ method: 'GET', url: 'https://b.example/' });
    expect(server.methods().filter((m) => m === 'Target.createTarget')).toHaveLength(2);
    expect(launches).toBe(1);
    expect(server.connections).toBe(1);
  });

  it('runs requests one at a time', async () => {
    server.latencyMs = 3;
    for (const u of ['https://a.example/', 'https://b.example/']) server.sites.set(u, { states: [{ title: 'ok', html: NORMAL }] });
    const solver = makeSolver();
    const a = solver.solve({ method: 'GET', url: 'https://a.example/' });
    const b = solver.solve({ method: 'GET', url: 'https://b.example/' });
    expect(solver.pending).toBe(2);
    await Promise.all([a, b]);
    const navs = server.calls.map((c, i) => [c.method, i] as const).filter(([m]) => m === 'Page.navigate' || m === 'Network.getCookies');
    // navigate(a), cookies(a), navigate(b), cookies(b): never interleaved.
    expect(navs.map(([m]) => m)).toEqual(['Page.navigate', 'Network.getCookies', 'Page.navigate', 'Network.getCookies']);
    expect(launches).toBe(1);
  });

  it('POSTs from inside the cleared page', async () => {
    server.sites.set('https://tracker.example/login', {
      states: [{ title: 'Login', html: NORMAL }],
      post: { status: 200, body: '<html><body>welcome</body></html>', headers: { 'set-cookie': 'x' } },
      cookies: [CLEARANCE],
    });
    const res = await makeSolver().solve({ method: 'POST', url: 'https://tracker.example/login', postData: 'user=a&pass=b' });
    expect(res.html).toContain('welcome');
    const evalCall = server.calls.find((c) => c.method === 'Runtime.evaluate' && String(c.params['expression']).includes('fetch('));
    expect(evalCall?.params['awaitPromise']).toBe(true);
    expect(String(evalCall?.params['expression'])).toContain('"user=a&pass=b"');
  });

  it('closes the browser after the idle timeout and relaunches on demand', async () => {
    server.sites.set('https://example.com/', { states: [{ title: 'ok', html: NORMAL }] });
    const solver = makeSolver({ idleCloseMs: 30 });
    await solver.solve({ method: 'GET', url: 'https://example.com/' });
    expect(solver.running).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(solver.running).toBe(false);
    expect(killed).toBe(1);
    expect(server.methods()).toContain('Browser.close');
    await solver.solve({ method: 'GET', url: 'https://example.com/' });
    expect(launches).toBe(2);
  });

  it('relaunches after the browser connection drops', async () => {
    server.sites.set('https://example.com/', { states: [{ title: 'ok', html: NORMAL }] });
    const solver = makeSolver();
    await solver.solve({ method: 'GET', url: 'https://example.com/' });
    server.dropConnections();
    await new Promise((r) => setTimeout(r, 30));
    await solver.solve({ method: 'GET', url: 'https://example.com/' });
    expect(launches).toBe(2);
  });

  it('gives named sessions their own tab and closes it on destroy', async () => {
    server.sites.set('https://a.example/', { states: [{ title: 'ok', html: NORMAL }] });
    const solver = makeSolver();
    const id = solver.createSession('s1');
    await solver.solve({ method: 'GET', url: 'https://a.example/' });
    await solver.solve({ method: 'GET', url: 'https://a.example/', session: id });
    expect(server.openPages).toBe(2);
    expect(await solver.destroySession(id)).toBe(true);
    expect(server.openPages).toBe(1);
    expect(await solver.destroySession(id)).toBe(false);
  });
});

describe('FlareSolverr /v1 contract', () => {
  const clock = () => 1_700_000_000_000;

  it('answers request.get with the FlareSolverr solution shape', async () => {
    server.sites.set('https://tracker.example/', {
      states: [
        { title: 'Just a moment...', html: CHALLENGE, status: 403, polls: 1 },
        { title: 'Tracker', html: '<html>ok</html>', status: 200 },
      ],
      cookies: [CLEARANCE],
    });
    const res = await handleFlareSolverrCommand(makeSolver(), { cmd: 'request.get', url: 'https://tracker.example/', maxTimeout: 5000 }, { now: clock });
    expect(res.httpStatus).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      message: 'Challenge solved!',
      startTimestamp: 1_700_000_000_000,
      endTimestamp: 1_700_000_000_000,
      version: expect.any(String),
      solution: {
        url: 'https://tracker.example/',
        status: 200,
        headers: { 'content-type': 'text/html' },
        response: '<html>ok</html>',
        cookies: [expect.objectContaining({ name: 'cf_clearance', value: 'tok123' })],
        userAgent: expect.stringContaining('Chrome/130'),
      },
    });
  });

  it('answers errors with HTTP 500 and status "error"', async () => {
    const solver = makeSolver();
    expect((await handleFlareSolverrCommand(solver, { cmd: 'request.get' })).body).toMatchObject({ status: 'error', message: expect.stringContaining('"url" is mandatory') });
    expect((await handleFlareSolverrCommand(solver, { cmd: 'request.post', url: 'https://x/' })).httpStatus).toBe(500);
    expect((await handleFlareSolverrCommand(solver, { cmd: 'nope' })).body.message).toContain('is invalid');
    expect((await handleFlareSolverrCommand(solver, 'garbage')).httpStatus).toBe(500);
    server.sites.set('https://hard.example/', { states: [{ title: 'Just a moment...', html: CHALLENGE }] });
    const timeout = await handleFlareSolverrCommand(solver, { cmd: 'request.get', url: 'https://hard.example/', maxTimeout: 30 });
    expect(timeout).toMatchObject({ httpStatus: 500, body: { status: 'error', message: expect.stringContaining('Timeout after') } });
  });

  it('manages sessions without launching a browser', async () => {
    const solver = makeSolver();
    const created = await handleFlareSolverrCommand(solver, { cmd: 'sessions.create', session: 'abc' });
    expect(created.body).toMatchObject({ status: 'ok', session: 'abc' });
    expect((await handleFlareSolverrCommand(solver, { cmd: 'sessions.list' })).body.sessions).toEqual(['abc']);
    expect((await handleFlareSolverrCommand(solver, { cmd: 'sessions.destroy', session: 'abc' })).body.status).toBe('ok');
    expect((await handleFlareSolverrCommand(solver, { cmd: 'sessions.destroy', session: 'abc' })).httpStatus).toBe(500);
    expect(launches).toBe(0);
  });
});
