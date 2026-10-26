import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentClient, type AgentEvent } from '@arclight/engine-agent';
import { createRemoteEngineClient, DownloadClientError } from '@arclight/download-clients';
import { createTorrent, Session, type SessionSettings } from '@arclight/torrent-engine';
import { createTestDb } from '../../db/test-utils.js';
import { engineAgentRoutes } from './routes.js';
import { EngineAgentService } from './service.js';

vi.setConfig({ testTimeout: 30_000 });

const API_KEY = 'arclight-api-key-0123456789';
const FAST: Partial<SessionSettings> = {
  listenPort: 0,
  listenAddress: '127.0.0.1',
  dht: false,
  pex: false,
  utp: false,
  dhtBootstrapNodes: [],
  tickIntervalMs: 50,
  chokeIntervalMs: 300,
  trackerMinIntervalSec: 0,
  trackerRetrySec: 0.2,
  peerRetryMs: 200,
  connectTimeoutMs: 2000,
};

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'mt-engine-agent-'));
  cleanups.push(() => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return d;
}

function pack() {
  const name = `rel-${randomBytes(4).toString('hex')}`;
  const files = [
    { path: ['ep.mkv'], data: randomBytes(48_000) },
    { path: ['ep.srt'], data: randomBytes(3_000) },
  ];
  const created = createTorrent({ name, files, pieceLength: 16 * 1024 });
  return { name, files, torrent: created.torrent, infoHash: created.metainfo.infoHash.toString('hex') };
}

/**
 * The "remote" Arclight: its engine module's routes over a real Session, behind a stand-in of
 * the auth hook (X-Api-Key -> apikey, a session cookie -> session user, nothing -> anonymous).
 */
async function remoteArclight(opts: { enabled?: boolean; running?: boolean } = {}) {
  const db = await createTestDb();
  const root = await tmp();
  let session: Session | null = null;
  if (opts.running !== false) {
    session = new Session({ settings: { ...FAST, savePath: root } });
    await session.start();
    const s = session;
    cleanups.push(() => s.shutdown());
  }
  const service = new EngineAgentService({ db, session: () => session, downloadsRoot: () => root });
  if (opts.enabled !== false) service.updateSettings({ enabled: true });
  const app: FastifyInstance = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(websocket);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (req.headers['x-api-key'] === API_KEY) req.auth = { user: null, via: 'apikey', isAdmin: true, appAccess: [] };
    else if (req.headers.cookie) req.auth = { user: null, via: 'session', isAdmin: true } as unknown as typeof req.auth;
  });
  await app.register(engineAgentRoutes(service), { prefix: '/api/v1' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, db, root, service, session, url: `http://127.0.0.1:${port}/api/v1/engine-agent` };
}

async function seeder(p: ReturnType<typeof pack>) {
  const dir = await tmp();
  for (const f of p.files) {
    const full = join(dir, p.name, ...f.path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, f.data);
  }
  const s = new Session({ settings: { ...FAST, savePath: dir } });
  await s.start();
  cleanups.push(() => s.shutdown());
  const t = await s.addTorrent({ torrent: p.torrent });
  await waitFor(() => t.state === 'seeding');
  return s;
}

function waitFor<T>(cond: () => T | undefined | null | false, ms = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const v = cond();
      if (v) {
        clearInterval(iv);
        resolve(v);
      } else if (Date.now() - start > ms) {
        clearInterval(iv);
        reject(new Error('timed out waiting for condition'));
      }
    }, 20);
  });
}

describe('engine-agent module: guard', () => {
  it('answers 404 in the agent error shape while disabled', async () => {
    const { app } = await remoteArclight({ enabled: false });
    const res = await app.inject({ method: 'GET', url: '/api/v1/engine-agent/status', headers: { 'x-api-key': API_KEY } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not-found' });
  });

  it('requires the API key (a signed-in browser session is not enough)', async () => {
    const { app } = await remoteArclight();
    expect((await app.inject({ method: 'GET', url: '/api/v1/engine-agent/status' })).statusCode).toBe(401);
    const cookie = await app.inject({ method: 'GET', url: '/api/v1/engine-agent/status', headers: { cookie: 'arclight_session=x' } });
    expect(cookie.statusCode).toBe(401);
    expect(cookie.json()).toMatchObject({ code: 'unauthorized' });
    const ok = await app.inject({ method: 'GET', url: '/api/v1/engine-agent/status', headers: { 'x-api-key': API_KEY } });
    expect(ok.statusCode).toBe(200);
  });

  it('maps a wrong API key to an auth error in the remote client', async () => {
    const { url } = await remoteArclight();
    const client = createRemoteEngineClient({ url, token: 'wrong' });
    cleanups.push(() => client.close());
    const error = await client.test().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownloadClientError);
    expect((error as DownloadClientError).code).toBe('auth');
  });
});

describe('engine-agent module: protocol', () => {
  it('reports an arclight-kind status with a managed port and refuses port changes', async () => {
    const { url, session, root } = await remoteArclight();
    const client = new AgentClient({ url, token: API_KEY });
    expect(await client.status()).toMatchObject({ kind: 'arclight', running: true, portManaged: true, listenPort: session!.listenPort, downloadsRoot: root });
    const error = await client.setListenPort(40_000).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('conflict');
  });

  it('answers not-running while the engine is stopped', async () => {
    const { url } = await remoteArclight({ running: false });
    const client = new AgentClient({ url, token: API_KEY });
    expect((await client.status()).running).toBe(false);
    const error = await client.list().catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('not-running');
  });

  it('streams events over the Fastify WebSocket', async () => {
    const { url, root } = await remoteArclight();
    const client = new AgentClient({ url, token: API_KEY });
    const events: AgentEvent[] = [];
    const sub = client.subscribe((e) => events.push(e));
    cleanups.push(() => sub.close());
    await waitFor(() => events[0]?.type === 'hello');
    const p = pack();
    for (const f of p.files) {
      await mkdir(join(root, 'tv', p.name), { recursive: true });
      await writeFile(join(root, 'tv', p.name, ...f.path), f.data);
    }
    await client.add({ category: 'tv' }, p.torrent);
    await waitFor(() => events.some((e) => e.type === 'added'));
  });

  it('serves settings and validates updates', async () => {
    const { app } = await remoteArclight({ enabled: false });
    const get = await app.inject({ method: 'GET', url: '/api/v1/settings/engineagent' });
    expect(get.json()).toEqual({ enabled: false, path: '/api/v1/engine-agent', engineRunning: true });
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/engineagent', payload: { enabled: true } });
    expect(put.json()).toMatchObject({ enabled: true });
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/settings/engineagent', payload: { enabled: 'yes' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('engine-agent module: Arclight to Arclight', () => {
  it('a remoteEngine client adds a .torrent, the remote engine downloads it and the file is pulled locally', async () => {
    const p = pack();
    const seed = await seeder(p);
    const remote = await remoteArclight();
    const local = await tmp();
    const client = createRemoteEngineClient({ url: remote.url, token: API_KEY, category: 'tv', pullMode: true, localDownloadPath: local });
    cleanups.push(() => client.close());
    expect((await client.test()).version).toContain('arclight');

    const { id } = await client.addTorrent({ torrentFile: p.torrent, title: p.name, category: 'tv' });
    expect(id).toBe(p.infoHash);
    remote.session!.getTorrent(id)!.addPeers([{ host: '127.0.0.1', port: seed.listenPort }]);

    const deadline = Date.now() + 20_000;
    let item;
    for (;;) {
      item = (await client.getItems('tv')).find((i) => i.id === id);
      if (item && item.status === 'seeding' && item.outputPath === join(local, p.name)) break;
      if (Date.now() > deadline) throw new Error(`not pulled: ${JSON.stringify(item)}`);
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(item.isReadOnly).toBe(false);
    for (const f of p.files) expect(await readFile(join(local, p.name, ...f.path))).toEqual(f.data);
    expect(await readFile(join(remote.root, 'tv', p.name, 'ep.mkv'))).toEqual(p.files[0]!.data);

    await client.removeItem(id, true);
    expect(remote.session!.getTorrent(id)).toBeUndefined();
  });
});
