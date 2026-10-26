import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserCandidate, ChallengeSolver, SolveRequest } from '@arclight/challenge-solver';
import { FlareSolverrClient } from '@arclight/indexers';
import type { AppContext } from '../../app.js';
import type { Db } from '../../db/index.js';
import { tags } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { authServiceFor, installAuth } from '../auth/index.js';
import { flareSolverrUnreachableCheck } from '../health/checks/flaresolverr.js';
import type { HealthDeps } from '../health/types.js';
import { DefinitionStore, IndexersService, indexersServiceFor } from '../indexers/index.js';
import { ProxiesService } from '../indexers/proxies.js';
import {
  BUILTIN_PROXY_NAME,
  BUNDLED_PROXY_NAME,
  PROXY_AUTODETECT_JOB,
  autoDetectDepsFor,
  isBuiltinSolverRow,
  loopbackFor,
  proxyTarget,
  runProxyAutoDetect,
  solverModuleWith,
  solverServiceFor,
} from './index.js';

// ---- harness --------------------------------------------------------------------------

const EDGE: BrowserCandidate = { name: 'edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' };

function fakeSolver() {
  const calls: SolveRequest[] = [];
  const solver = {
    running: false,
    pending: 0,
    solve: async (req: SolveRequest) => {
      calls.push(req);
      return {
        url: req.url,
        status: 200,
        html: '<html>cleared</html>',
        headers: { 'content-type': 'text/html' },
        cookies: [{ name: 'cf_clearance', value: 'abc', domain: '.tracker.example', path: '/', httpOnly: true, secure: true }],
        userAgent: 'Mozilla/5.0 Chrome/130.0.0.0',
        challenged: true,
      };
    },
    createSession: (id?: string) => id ?? 'generated',
    listSessions: () => [],
    destroySession: async () => false,
    close: async () => {},
  };
  return { calls, solver: solver as unknown as ChallengeSolver };
}

let dir: string;
let db: Db;
let ctx: AppContext;
let app: FastifyInstance;
let browser: BrowserCandidate | null;
let probeAnswers: boolean;
let envUrl: string | undefined;
let fake: ReturnType<typeof fakeSolver>;

async function buildCtx(): Promise<AppContext> {
  db = await createTestDb();
  const log = pino({ level: 'silent' });
  const bus = new EventBus();
  return {
    config: { configDir: dir, dbPath: ':memory:', logDir: dir, port: 7878, host: '0.0.0.0', logLevel: 'silent', isDocker: false, webDist: null },
    db,
    bus,
    scheduler: new Scheduler(db, bus, log),
    log,
    startedAt: new Date(),
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify().withTypeProvider<ZodTypeProvider>();
  a.setValidatorCompiler(validatorCompiler);
  a.setSerializerCompiler(serializerCompiler);
  await a.register(
    async (api) => {
      installAuth(api, ctx);
      await api.register(solverModuleWith({ autodetect: { probe: async () => probeAnswers, envUrl } })(ctx));
    },
    { prefix: '/api/v1' },
  );
  await a.ready();
  return a;
}

/** fetch() that goes through app.inject, so FlareSolverrClient can target the route. */
function injectFetch(target: () => FastifyInstance): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const res = await target().inject({
      method: (init?.method ?? 'GET') as 'POST',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') } });
  }) as typeof fetch;
}

const proxies = () => indexersServiceFor(ctx).proxies;
const rows = () => proxies().allRows();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'arclight-solver-api-'));
  browser = EDGE;
  probeAnswers = false;
  envUrl = undefined;
  fake = fakeSolver();
  ctx = await buildCtx();
  solverServiceFor(ctx, { findBrowser: () => browser, createSolver: () => fake.solver });
});

afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

// ---- auto-detect -------------------------------------------------------------------------

describe('ProxyAutoDetect', () => {
  it('registers "FlareSolverr (bundled)" from ARCLIGHT_FLARESOLVERR_URL, tagged cloudflare, once', async () => {
    browser = null;
    const deps = autoDetectDepsFor(ctx, { envUrl: 'http://flaresolverr:8191', probe: async () => false });
    const first = await runProxyAutoDetect(deps);
    expect(first.bundledCreated).not.toBeNull();
    const [row] = rows();
    expect(row).toMatchObject({ name: BUNDLED_PROXY_NAME, type: 'flaresolverr', host: 'http://flaresolverr', port: 8191 });
    const tag = db.select().from(tags).all();
    expect(tag).toEqual([{ id: row!.tags[0], label: 'cloudflare' }]);
    expect((await runProxyAutoDetect(deps)).bundledCreated).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it('probes the default URL when the env var is unset', async () => {
    browser = null;
    const probed: string[] = [];
    const none = await runProxyAutoDetect(autoDetectDepsFor(ctx, { envUrl: undefined, probe: async (u) => (probed.push(u), false) }));
    expect(none.bundledCreated).toBeNull();
    expect(probed).toEqual(['http://localhost:8191']);
    await runProxyAutoDetect(autoDetectDepsFor(ctx, { envUrl: undefined, probe: async () => true }));
    expect(rows()[0]).toMatchObject({ name: BUNDLED_PROXY_NAME, host: 'http://localhost', port: 8191 });
  });

  it('leaves things alone when the user already has a FlareSolverr proxy', async () => {
    browser = null;
    proxies().create({ name: 'Mine', type: 'flaresolverr', host: 'http://nas', port: 8191 });
    const result = await runProxyAutoDetect(autoDetectDepsFor(ctx, { envUrl: 'http://flaresolverr:8191', probe: async () => true }));
    expect(result.bundledCreated).toBeNull();
    expect(rows().map((r) => r.name)).toEqual(['Mine']);
  });

  it('registers the built-in solver with the API key, keeps it in sync and removes it when disabled', async () => {
    await runProxyAutoDetect(autoDetectDepsFor(ctx, { envUrl: undefined, probe: async () => false }));
    const builtin = rows().find(isBuiltinSolverRow);
    expect(builtin).toMatchObject({ name: BUILTIN_PROXY_NAME, host: 'http://127.0.0.1/api/v1/solver', port: 7878, requestTimeout: 60 });
    expect(builtin!.password).toBe(authServiceFor(ctx).apiKey());

    const rotated = authServiceFor(ctx).regenerateApiKey();
    await runProxyAutoDetect(autoDetectDepsFor(ctx, { envUrl: undefined, probe: async () => false }));
    expect(rows().find(isBuiltinSolverRow)!.password).toBe(rotated);

    solverServiceFor(ctx).updateSettings({ enabled: false });
    const result = await runProxyAutoDetect(autoDetectDepsFor(ctx, { envUrl: undefined, probe: async () => false }));
    expect(result.builtinProxyId).toBeNull();
    expect(rows().some(isBuiltinSolverRow)).toBe(false);
  });

  it('does not count the built-in solver as an existing FlareSolverr', async () => {
    await runProxyAutoDetect(autoDetectDepsFor(ctx, { envUrl: undefined, probe: async () => false }));
    await runProxyAutoDetect(autoDetectDepsFor(ctx, { envUrl: 'http://localhost:8191', probe: async () => false }));
    expect(rows().map((r) => r.name).sort()).toEqual([BUILTIN_PROXY_NAME, BUNDLED_PROXY_NAME].sort());
  });

  it('runs on boot and registers the 10-minute job', async () => {
    envUrl = 'http://localhost:8191';
    app = await buildApp();
    expect(rows().map((r) => r.name).sort()).toEqual([BUILTIN_PROXY_NAME, BUNDLED_PROXY_NAME].sort());
    expect(ctx.scheduler.has(PROXY_AUTODETECT_JOB)).toBe(true);
  });

  it('parses solver URLs and loopback hosts', () => {
    expect(proxyTarget('flaresolverr')).toEqual({ host: 'http://flaresolverr', port: 8191 });
    expect(proxyTarget('https://solver.example:9000/v1')).toEqual({ host: 'https://solver.example', port: 9000 });
    expect(proxyTarget('http://[bad')).toBeUndefined();
    expect(loopbackFor('0.0.0.0')).toBe('127.0.0.1');
    expect(loopbackFor('::')).toBe('[::1]');
    expect(loopbackFor('192.168.1.5')).toBe('192.168.1.5');
  });
});

// ---- defaulting ---------------------------------------------------------------------------

describe('definition indexers that require FlareSolverr', () => {
  it('get the first FlareSolverr proxy appended when none applies', () => {
    const p = new ProxiesService({ db });
    const http = p.create({ name: 'Http', type: 'http', host: 'p.example', port: 3128, tags: [3] });
    expect(p.applicable({ proxyId: null, tags: [3] }, { needsSolver: true }).map((r) => r.name)).toEqual(['Http']);
    p.create({ name: 'Solver B', type: 'flaresolverr', host: 'http://b', port: 8191 });
    p.create({ name: 'Solver C', type: 'flaresolverr', host: 'http://c', port: 8191, tags: [9] });
    expect(p.applicable({ proxyId: null, tags: [3] }, { needsSolver: true }).map((r) => r.name)).toEqual(['Http', 'Solver B']);
    expect(p.applicable({ proxyId: http.id, tags: [] }, { needsSolver: true }).map((r) => r.name)).toEqual(['Http', 'Solver B']);
    // A solver already applies through tags: nothing is added.
    expect(p.applicable({ proxyId: null, tags: [9] }, { needsSolver: true }).map((r) => r.name)).toEqual(['Solver C']);
    expect(p.applicable({ proxyId: null, tags: [] }).map((r) => r.name)).toEqual([]);
  });

  it('are detected from the definition key, treating a missing key as false', async () => {
    const defs = join(dir, 'defs');
    await mkdir(defs);
    await writeFile(
      join(defs, 'cfsite.yml'),
      [
        'id: cfsite',
        'name: CfSite',
        'description: test',
        'language: en-US',
        'type: public',
        'links:',
        '  - https://cfsite.example/',
        'caps:',
        '  categorymappings:',
        '    - {id: 1, cat: Movies, desc: Movies}',
        '  modes:',
        '    search: [q]',
        'search:',
        '  paths:',
        '    - path: browse',
        '  rows:',
        '    selector: tr',
        '  fields:',
        '    title: {selector: a}',
        '    download: {selector: a, attribute: href}',
        '',
      ].join('\n'),
      'utf8',
    );
    const store = new DefinitionStore({ customDir: defs });
    await store.ready();
    const service = new IndexersService({ db, definitions: store });
    service.proxies.create({ name: 'Solver', type: 'flaresolverr', host: 'http://solver', port: 8191 });
    const created = service.create({ name: 'Cf', implementation: 'definition', settings: { definitionId: 'cfsite', fields: {} } });
    expect(created.proxyNames).toBeUndefined();

    const original = store.get.bind(store);
    store.get = (id: string) => {
      const def = original(id);
      return def ? ({ ...def, requiresFlareSolverr: true } as typeof def) : def;
    };
    expect(service.get(created.id).proxyNames).toEqual(['Solver']);
  });
});

// ---- routes -------------------------------------------------------------------------------

describe('POST /api/v1/solver/v1', () => {
  it('requires the API key and answers in the FlareSolverr shape', async () => {
    app = await buildApp();
    const body = { cmd: 'request.get', url: 'https://tracker.example/', maxTimeout: 30000 };
    expect((await app.inject({ method: 'POST', url: '/api/v1/solver/v1', payload: body })).statusCode).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/api/v1/solver/v1', payload: body, headers: { 'x-api-key': authServiceFor(ctx).apiKey() } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      message: 'Challenge solved!',
      solution: { url: 'https://tracker.example/', status: 200, response: '<html>cleared</html>', userAgent: 'Mozilla/5.0 Chrome/130.0.0.0' },
    });
    expect(fake.calls).toEqual([{ method: 'GET', url: 'https://tracker.example/', timeoutMs: 30000 }]);
  });

  it('answers HTTP 500 like FlareSolverr when disabled or without a browser', async () => {
    app = await buildApp();
    const headers = { 'x-api-key': authServiceFor(ctx).apiKey() };
    browser = null;
    const none = await app.inject({ method: 'POST', url: '/api/v1/solver/v1', payload: { cmd: 'request.get', url: 'https://x/' }, headers });
    expect(none.statusCode).toBe(500);
    expect(none.json()).toMatchObject({ status: 'error', message: expect.stringContaining('No Chromium-family browser') });
    browser = EDGE;
    solverServiceFor(ctx).updateSettings({ enabled: false });
    const off = await app.inject({ method: 'POST', url: '/api/v1/solver/v1', payload: { cmd: 'sessions.list' }, headers });
    expect(off.json()).toMatchObject({ status: 'error', message: expect.stringContaining('disabled') });
  });

  it('is usable unchanged by the indexers FlareSolverrClient (and so by the built-in proxy)', async () => {
    app = await buildApp();
    const builtin = rows().find(isBuiltinSolverRow)!;
    const client = new FlareSolverrClient(
      { type: 'flaresolverr', url: 'http://127.0.0.1:7878/api/v1/solver', apiKey: builtin.password! },
      { fetchImpl: injectFetch(() => app) },
    );
    const solution = await client.get('https://tracker.example/browse');
    expect(solution).toMatchObject({ status: 200, response: '<html>cleared</html>', userAgent: 'Mozilla/5.0 Chrome/130.0.0.0' });
    expect(solution.cookies[0]).toMatchObject({ name: 'cf_clearance', value: 'abc' });

    // The proxy test route runs a real request.get through it, with the API key.
    const viaProxies = new ProxiesService({ db, fetch: injectFetch(() => app) });
    const result = await viaProxies.testSaved(builtin.id, 'https://tracker.example/');
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('fetched https://tracker.example/') });
    expect(fake.calls.at(-1)).toMatchObject({ method: 'GET', url: 'https://tracker.example/' });
    expect(await viaProxies.ping(builtin.id)).toEqual({ ok: true });
  });

  it('updates settings, re-runs auto-detect and reports status', async () => {
    app = await buildApp();
    const headers = { 'x-api-key': authServiceFor(ctx).apiKey() };
    const status = await app.inject({ method: 'GET', url: '/api/v1/solver/status', headers });
    expect(status.json()).toMatchObject({ enabled: true, browser: EDGE, running: false, proxyId: expect.any(Number) });
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/solver', payload: { enabled: false, timeoutSeconds: 90 }, headers });
    expect(put.json()).toEqual({ enabled: false, timeoutSeconds: 90, idleCloseSeconds: 300 });
    expect(rows().some(isBuiltinSolverRow)).toBe(false);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/solver', payload: { timeoutSeconds: 1 }, headers })).statusCode).toBe(400);
  });
});

// ---- health -------------------------------------------------------------------------------

describe('FlareSolverrUnreachable', () => {
  it('warns once per unreachable solver and stays quiet otherwise', async () => {
    const deps = (list: Array<{ id: number; name: string; ok: boolean; message?: string }>) =>
      ({ flareSolverrs: async () => list }) as unknown as HealthDeps;
    expect(await flareSolverrUnreachableCheck.run(deps([{ id: 1, name: 'A', ok: true }]))).toEqual([]);
    const findings = await flareSolverrUnreachableCheck.run(
      deps([
        { id: 1, name: 'FlareSolverr (bundled)', ok: false, message: 'fetch failed' },
        { id: 2, name: 'B', ok: true },
      ]),
    );
    expect(findings).toEqual([
      expect.objectContaining({ source: 'FlareSolverrUnreachable', status: 'warning', message: expect.stringContaining('"FlareSolverr (bundled)" is unreachable: fetch failed') }),
    ]);
    expect(await flareSolverrUnreachableCheck.run({} as HealthDeps)).toEqual([]);
  });
});
