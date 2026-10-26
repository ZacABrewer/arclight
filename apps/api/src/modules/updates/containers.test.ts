import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { UpdateSettings } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { ContainerUpdater, inWindow, orderParentsFirst, recreateBody } from './containers.js';
import type { ContainerInspect } from './docker.js';
import { createContainerUpdatesCheck } from './health.js';
import { runContainerUpdateJob } from './index.js';
import { parseChallenge, parseImageRef, remoteDigest } from './registry.js';
import { UpdatesService } from './service.js';

// ---- a fake Docker Engine API ----------------------------------------------------------------

interface FakeContainer {
  Id: string;
  Name: string;
  Image: string;
  Config: Record<string, unknown> & { Image: string; Labels?: Record<string, string> };
  HostConfig: Record<string, unknown> & { NetworkMode?: string };
  NetworkSettings: { Networks: Record<string, Record<string, unknown>> };
  Mounts: Array<{ Source: string; Destination: string }>;
  State: { Running: boolean };
}

interface FakeImage {
  Id: string;
  RepoDigests: string[];
  Config: Record<string, unknown>;
}

class FakeDocker {
  containers = new Map<string, FakeContainer>();
  images = new Map<string, FakeImage>();
  calls: string[] = [];
  created: Array<{ name: string; body: Record<string, unknown> }> = [];
  failStart = new Set<string>();
  private seq = 0;
  server!: Server;
  port = 0;

  addImage(ref: string, digest: string, config: Record<string, unknown> = {}) {
    const img = { Id: `sha256:${ref.replace(/\W/g, '')}${this.seq++}`, RepoDigests: digest ? [`${ref.split(':')[0]}@${digest}`] : [], Config: config };
    this.images.set(ref, img);
    this.images.set(img.Id, img);
    return img;
  }

  addContainer(name: string, image: string, opts: { labels?: Record<string, string>; networkMode?: string; env?: string[]; mounts?: FakeContainer['Mounts'] } = {}) {
    const img = this.images.get(image)!;
    const id = `${name.padEnd(12, '0').slice(0, 12)}${'f'.repeat(52)}`;
    const c: FakeContainer = {
      Id: id,
      Name: `/${name}`,
      Image: img.Id,
      Config: { Image: image, Hostname: id.slice(0, 12), Env: [...((img.Config['Env'] as string[]) ?? []), ...(opts.env ?? [])], Labels: { ...(opts.labels ?? {}) }, Cmd: img.Config['Cmd'] },
      HostConfig: { NetworkMode: opts.networkMode ?? 'bridge', RestartPolicy: { Name: 'unless-stopped' }, Binds: [`/srv/${name}:/config`] },
      NetworkSettings: { Networks: opts.networkMode?.startsWith('container:') ? {} : { arclight_default: { Aliases: [name, id.slice(0, 12)], NetworkID: 'n1' } } },
      Mounts: opts.mounts ?? [],
      State: { Running: true },
    };
    this.containers.set(id, c);
    return c;
  }

  find(ref: string): FakeContainer | undefined {
    const r = decodeURIComponent(ref);
    return [...this.containers.values()].find((c) => c.Id === r || c.Name === `/${r}` || (r.length >= 12 && c.Id.startsWith(r)));
  }

  async start() {
    this.server = createServer((req, res) => void this.handle(req).then(([status, body]) => res.writeHead(status, { 'content-type': 'application/json' }).end(body)));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  private async handle(req: IncomingMessage): Promise<[number, string]> {
    const url = new URL(req.url ?? '/', 'http://docker');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
    const parts = url.pathname.split('/').filter(Boolean);
    const json = (v: unknown, status = 200): [number, string] => [status, JSON.stringify(v)];
    const notFound: [number, string] = [404, JSON.stringify({ message: 'No such container' })];
    const method = req.method ?? 'GET';
    if (url.pathname === '/_ping') return [200, 'OK'];
    if (method === 'GET' && url.pathname === '/containers/json') {
      const filter = url.searchParams.get('filters');
      const label = filter ? (JSON.parse(filter) as { label: string[] }).label[0]!.split('=') : null;
      const list = [...this.containers.values()].filter((c) => !label || c.Config.Labels?.[label[0]!] === label[1]);
      return json(list.map((c) => ({ Id: c.Id, Names: [c.Name], Image: c.Config.Image, Labels: c.Config.Labels })));
    }
    if (parts[0] === 'images' && method === 'GET') {
      const img = this.images.get(decodeURIComponent(parts.slice(1, -1).join('/')));
      return img ? json(img) : [404, JSON.stringify({ message: 'No such image' })];
    }
    if (url.pathname === '/images/create' && method === 'POST') {
      const ref = `${url.searchParams.get('fromImage')}:${url.searchParams.get('tag')}`;
      this.calls.push(`pull ${ref}`);
      const old = this.images.get(ref);
      this.addImage(ref, 'sha256:newdigest', old?.Config ?? {});
      return [200, '{"status":"Pulling"}\n{"status":"Downloaded newer image"}\n'];
    }
    if (url.pathname === '/containers/create' && method === 'POST') {
      const name = url.searchParams.get('name')!;
      if (this.find(name)) return [409, JSON.stringify({ message: 'name in use' })];
      const img = this.images.get(body['Image'] as string);
      const id = `new${String(this.seq++).padStart(9, '0')}${'e'.repeat(52)}`;
      this.created.push({ name, body });
      this.calls.push(`create ${name}`);
      this.containers.set(id, {
        Id: id,
        Name: `/${name}`,
        Image: img?.Id ?? (body['Image'] as string),
        Config: { ...(body as FakeContainer['Config']) },
        HostConfig: (body['HostConfig'] ?? {}) as FakeContainer['HostConfig'],
        NetworkSettings: { Networks: {} },
        Mounts: [],
        State: { Running: false },
      });
      return json({ Id: id }, 201);
    }
    if (parts[0] === 'containers' && parts[1]) {
      const c = this.find(parts[1]);
      if (!c) return method === 'DELETE' ? [404, JSON.stringify({ message: 'gone' })] : notFound;
      const name = c.Name.slice(1);
      if (method === 'GET' && parts[2] === 'json') return json(c);
      if (method === 'DELETE') {
        this.calls.push(`remove ${name}`);
        this.containers.delete(c.Id);
        return [204, ''];
      }
      if (parts[2] === 'stop') {
        this.calls.push(`stop ${name}`);
        c.State.Running = false;
        return [204, ''];
      }
      if (parts[2] === 'start') {
        this.calls.push(`start ${name}`);
        if (this.failStart.has(name)) return [500, JSON.stringify({ message: 'cannot join network' })];
        c.State.Running = true;
        return [204, ''];
      }
      if (parts[2] === 'rename') {
        const to = url.searchParams.get('name')!;
        this.calls.push(`rename ${name} -> ${to}`);
        c.Name = `/${to}`;
        return [204, ''];
      }
    }
    return [404, JSON.stringify({ message: `unhandled ${method} ${url.pathname}` })];
  }
}

// ---- a fake registry (anonymous token flow) ----------------------------------------------------

function fakeRegistry(digests: Record<string, string>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
    if (url.pathname === '/token') return Response.json({ token: `tok:${url.searchParams.get('scope')}` });
    const m = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname);
    if (!m) return new Response(null, { status: 404 });
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Bearer tok:repository:${m[1]}:pull`) {
      return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer realm="https://${url.host}/token",service="${url.host}",scope="repository:${m[1]}:pull"` } });
    }
    const digest = digests[`${url.host}/${m[1]}:${m[2]}`];
    return digest ? new Response(null, { status: 200, headers: { 'docker-content-digest': digest } }) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

const REMOTE = {
  'registry-1.docker.io/qmcgaw/gluetun:latest': 'sha256:newdigest',
  'lscr.io/linuxserver/qbittorrent:latest': 'sha256:qbit1',
  'ghcr.io/arclight/arclight:latest': 'sha256:arc1',
};

let docker: FakeDocker | null = null;
afterEach(async () => {
  await new Promise((r) => (docker ? docker.server.close(r) : r(undefined)));
  docker = null;
});

/** gluetun (update available) with qbittorrent and arclight in its network namespace. */
async function stack(selfRef = 'not-here', clock: { now: Date } = { now: new Date(2026, 9, 26, 4, 0) }) {
  docker = new FakeDocker();
  await docker.start();
  docker.addImage('qmcgaw/gluetun:latest', 'sha256:olddigest', { Env: ['PATH=/usr/bin', 'VPN_TYPE=openvpn'], Cmd: ['/gluetun-entrypoint'], Labels: { 'org.opencontainers.image.version': '3.39' } });
  docker.addImage('lscr.io/linuxserver/qbittorrent:latest', 'sha256:qbit1', { Env: ['PATH=/usr/bin'] });
  docker.addImage('ghcr.io/arclight/arclight:latest', 'sha256:arc1', { Env: ['ARCLIGHT_VERSION=0.2.0'] });
  docker.addImage('local/thing:dev', '', {});
  const label = { 'arclight.autoupdate': 'true' };
  const gluetun = docker.addContainer('gluetun', 'qmcgaw/gluetun:latest', { labels: label, env: ['VPN_TYPE=wireguard'] });
  docker.addContainer('qbittorrent', 'lscr.io/linuxserver/qbittorrent:latest', { labels: label, networkMode: `container:${gluetun.Id}` });
  docker.addContainer('arclight', 'ghcr.io/arclight/arclight:latest', {
    labels: label,
    networkMode: `container:${gluetun.Id}`,
    mounts: [{ Source: '/run/docker.sock', Destination: '/var/run/docker.sock' }],
  });
  docker.addContainer('unlabelled', 'local/thing:dev');
  const db = await createTestDb();
  const updater = new ContainerUpdater({
    db,
    isDocker: true,
    endpoint: { host: '127.0.0.1', port: docker.port },
    selfRef,
    registry: { fetchImpl: fakeRegistry(REMOTE) },
    helperDelayMs: 0,
    now: () => clock.now,
  });
  return { db, docker, updater, gluetun, clock };
}

describe('image references and registry digests', () => {
  it('parses Docker Hub, GHCR and lscr references', () => {
    expect(parseImageRef('nginx')).toEqual({ registry: 'registry-1.docker.io', repository: 'library/nginx', tag: 'latest' });
    expect(parseImageRef('qmcgaw/gluetun:v3')).toEqual({ registry: 'registry-1.docker.io', repository: 'qmcgaw/gluetun', tag: 'v3' });
    expect(parseImageRef('ghcr.io/arclight/arclight:v0.2.0')).toEqual({ registry: 'ghcr.io', repository: 'arclight/arclight', tag: 'v0.2.0' });
    expect(parseImageRef('localhost:5000/x/y')).toEqual({ registry: 'localhost:5000', repository: 'x/y', tag: 'latest' });
    expect(parseImageRef('docker.io/library/redis@sha256:abc')).toMatchObject({ repository: 'library/redis', digest: 'sha256:abc' });
    expect(parseChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"')).toEqual({
      realm: 'https://ghcr.io/token',
      params: { service: 'ghcr.io', scope: 'repository:a/b:pull' },
    });
  });

  it('follows the anonymous token challenge to the manifest digest', async () => {
    const seen: string[] = [];
    const digest = await remoteDigest(parseImageRef('lscr.io/linuxserver/qbittorrent'), { fetchImpl: fakeRegistry(REMOTE, seen) });
    expect(digest).toBe('sha256:qbit1');
    expect(seen).toEqual(['HEAD lscr.io/v2/linuxserver/qbittorrent/manifests/latest', 'GET lscr.io/token', 'HEAD lscr.io/v2/linuxserver/qbittorrent/manifests/latest']);
    await expect(remoteDigest(parseImageRef('ghcr.io/nobody/nothing'), { fetchImpl: fakeRegistry(REMOTE) })).rejects.toThrow(/not in ghcr.io/);
  });
});

describe('recreate plan', () => {
  const c = (name: string, mode = 'bridge'): ContainerInspect =>
    ({ Id: `${name}-id-000000000`, Name: `/${name}`, Image: 'sha', Config: { Image: 'x' }, HostConfig: { NetworkMode: mode } }) as ContainerInspect;

  it('orders network parents before their dependents', () => {
    const order = orderParentsFirst([c('arclight', 'container:gluetun-id-000000000'), c('qbittorrent', 'container:gluetun'), c('gluetun')]);
    expect(order.map((x) => x.Name)).toEqual(['/gluetun', '/arclight', '/qbittorrent']);
  });

  it('keeps run-time config, drops what the old image supplied and re-points the namespace', () => {
    const body = recreateBody(
      {
        Id: 'abcdef123456' + '0'.repeat(52),
        Name: '/arclight',
        Image: 'sha256:old',
        Config: { Image: 'ghcr.io/arclight/arclight:latest', Hostname: 'abcdef123456', Env: ['ARCLIGHT_VERSION=0.2.0', 'TZ=Europe/Oslo'], Cmd: ['node', 'server.mjs'], Labels: { a: '1', 'org.version': '0.2.0' } },
        HostConfig: { NetworkMode: 'container:gluetun', Binds: ['/srv:/config'] },
      },
      { Id: 'sha256:old', Config: { Env: ['ARCLIGHT_VERSION=0.2.0'], Cmd: ['node', 'server.mjs'], Labels: { 'org.version': '0.2.0' } } },
      'ghcr.io/arclight/arclight:latest',
      'newgluetun',
    );
    expect(body).toEqual({
      Image: 'ghcr.io/arclight/arclight:latest',
      Env: ['TZ=Europe/Oslo'],
      Labels: { a: '1' },
      HostConfig: { NetworkMode: 'container:newgluetun', Binds: ['/srv:/config'] },
    });
  });

  it('treats the window as local hours that may wrap past midnight', () => {
    expect(inWindow(4, { startHour: 3, endHour: 6 })).toBe(true);
    expect(inWindow(6, { startHour: 3, endHour: 6 })).toBe(false);
    expect(inWindow(23, { startHour: 22, endHour: 2 })).toBe(true);
    expect(inWindow(1, { startHour: 22, endHour: 2 })).toBe(true);
    expect(inWindow(12, { startHour: 22, endHour: 2 })).toBe(false);
    expect(inWindow(12, { startHour: 5, endHour: 5 })).toBe(true);
  });
});

describe('ContainerUpdater against a fake Docker API', () => {
  it('reports notify-only when the socket is missing', async () => {
    const db = await createTestDb();
    const native = new ContainerUpdater({ db, isDocker: false, socketPath: '/definitely/not/here.sock' });
    expect(await native.info('auto')).toMatchObject({ dockerAvailable: false, reason: expect.stringMatching(/not running in Docker.*GitHub/) });
    const container = new ContainerUpdater({ db, isDocker: true, socketPath: '/definitely/not/here.sock' });
    expect((await container.info('notify')).reason).toMatch(/not mounted.*pulling the image/);
    await expect(container.check()).rejects.toThrow(/not mounted/);
  });

  it('checks labelled containers against their registry digests', async () => {
    const { updater } = await stack('arclight');
    const items = await updater.check();
    expect(items.map((i) => [i.name, i.updateAvailable, i.isSelf, i.networkParent ?? null])).toEqual([
      ['arclight', false, true, 'gluetun'],
      ['gluetun', true, false, null],
      ['qbittorrent', false, false, 'gluetun'],
    ]);
    expect(items.find((i) => i.name === 'gluetun')).toMatchObject({ currentDigest: 'sha256:olddigest', latestDigest: 'sha256:newdigest' });
    // Labels come from Docker inspect (the opt-in label included).
    expect(items.find((i) => i.name === 'gluetun')!.labels).toMatchObject({ 'arclight.autoupdate': 'true' });
    expect((await updater.info('notify')).containers).toHaveLength(3);
  });

  it('pulls, creates, then swaps parents before dependents with the real swap script', async () => {
    const { updater, docker: d, gluetun } = await stack();
    await updater.check();
    const run = await updater.update(['gluetun']);
    expect(run).toMatchObject({ ok: true, handedOff: false, updated: ['gluetun', 'qbittorrent', 'arclight'] });
    expect(d.calls).toEqual([
      'pull qmcgaw/gluetun:latest',
      'create gluetun-arclight-new',
      'create qbittorrent-arclight-new',
      'create arclight-arclight-new',
      // dependents stop first, parents start first
      'stop arclight',
      'stop qbittorrent',
      'stop gluetun',
      'rename arclight -> arclight-arclight-old',
      'rename qbittorrent -> qbittorrent-arclight-old',
      'rename gluetun -> gluetun-arclight-old',
      'rename gluetun-arclight-new -> gluetun',
      'rename qbittorrent-arclight-new -> qbittorrent',
      'rename arclight-arclight-new -> arclight',
      'start gluetun',
      'start qbittorrent',
      'start arclight',
      'remove gluetun-arclight-old',
      'remove qbittorrent-arclight-old',
      'remove arclight-arclight-old',
    ]);
    const newGluetun = d.find('gluetun')!;
    expect(newGluetun.Id).not.toBe(gluetun.Id);
    const gBody = d.created.find((x) => x.name === 'gluetun-arclight-new')!.body;
    // The image's own env and cmd are not frozen into the new container; run-time env is kept.
    expect(gBody['Env']).toEqual(['VPN_TYPE=wireguard']);
    expect(gBody['Cmd']).toBeUndefined();
    expect(gBody['HostConfig']).toMatchObject({ RestartPolicy: { Name: 'unless-stopped' }, Binds: ['/srv/gluetun:/config'] });
    expect(gBody['NetworkingConfig']).toEqual({ EndpointsConfig: { arclight_default: { Aliases: ['gluetun'] } } });
    const qBody = d.created.find((x) => x.name === 'qbittorrent-arclight-new')!.body;
    expect(qBody['HostConfig']).toMatchObject({ NetworkMode: `container:${newGluetun.Id}` });
    expect(qBody['Image']).toMatch(/^sha256:/); // dependent keeps its exact image
    expect((await updater.info('notify')).lastRun).toMatchObject({ ok: true });
    expect(updater.cachedContainers().find((c) => c.name === 'gluetun')!.updateAvailable).toBe(false);
  });

  it('rolls back to the old containers when a new one fails to start', async () => {
    const { updater, docker: d } = await stack();
    await updater.check();
    d.failStart.add('arclight');
    const run = await updater.update(['gluetun']);
    expect(run.ok).toBe(false);
    expect(run.message).toMatch(/rolling back/);
    const names = [...d.containers.values()].map((c) => c.Name).sort();
    expect(names).toEqual(['/arclight', '/gluetun', '/qbittorrent', '/unlabelled']);
    expect(d.find('gluetun')!.Id.startsWith('gluetun')).toBe(true);
    expect(d.find('gluetun')!.State.Running).toBe(true);
  });

  it('hands the swap to a helper container when Arclight itself is recreated', async () => {
    const { updater, docker: d } = await stack('arclight');
    await updater.check();
    const run = await updater.update(['gluetun']);
    expect(run).toMatchObject({ ok: true, handedOff: true, updated: ['gluetun', 'qbittorrent', 'arclight'] });
    const helper = d.created.find((x) => x.name.startsWith('arclight-updater-'))!;
    expect(helper.body).toMatchObject({
      Entrypoint: [''],
      Cmd: ['node', '-e', expect.stringContaining('ARCLIGHT_UPDATE_PLAN')],
      User: '0:0',
      HostConfig: { Binds: ['/run/docker.sock:/var/run/docker.sock'], AutoRemove: true, NetworkMode: 'none' },
    });
    const plan = JSON.parse(String((helper.body['Env'] as string[])[0]).replace('ARCLIGHT_UPDATE_PLAN=', '')) as { items: Array<{ name: string }> };
    expect(plan.items.map((i) => i.name)).toEqual(['gluetun', 'qbittorrent', 'arclight']);
    // Nothing old was touched by this process: the helper does it.
    expect(d.calls.filter((c) => c.startsWith('stop'))).toEqual([]);
    expect(d.calls.at(-1)).toMatch(/^start arclight-updater-/);
  });

  it('runs once a day inside the window, updating only in auto mode', async () => {
    const { db, updater, docker: d, clock } = await stack();
    const service = new UpdatesService({ db, currentVersion: '0.2.0', isDocker: true });
    const at = (h: number) => new Date(2026, 9, 26, h, 10);
    expect(await runContainerUpdateJob(service, updater, at(12))).toBe('outside the update window');
    clock.now = at(4);
    expect(await runContainerUpdateJob(service, updater, at(4))).toBe('updates available: gluetun');
    expect(d.calls.some((c) => c.startsWith('pull'))).toBe(false);
    expect(await runContainerUpdateJob(service, updater, at(5))).toBe('already checked today');

    const check = createContainerUpdatesCheck(
      () => service,
      () => updater,
    );
    expect((await check.run({} as never))[0]).toMatchObject({ source: 'ContainerUpdatesAvailable', status: 'warning', message: expect.stringContaining('gluetun') });

    service.updateSettings({ mode: 'auto', autoUpdateWindow: UpdateSettings.shape.autoUpdateWindow.parse(undefined) });
    const next = new Date(2026, 9, 27, 4, 10);
    clock.now = next;
    expect(await runContainerUpdateJob(service, updater, next)).toMatch(/^Updated gluetun, qbittorrent, arclight/);
    expect(await check.run({} as never)).toEqual([]);
  });
});
