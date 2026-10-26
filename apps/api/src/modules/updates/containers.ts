import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Logger } from 'pino';
import {
  AUTOUPDATE_LABEL,
  ContainerUpdateItem,
  ContainerUpdateRun,
  type ContainerUpdatesInfo,
  type UpdateSettings,
  type UpdateWindow,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { settings } from '../../db/schema.js';
import { DockerClient, type ContainerInspect, type DockerEndpoint, type ImageInspect } from './docker.js';
import { parseImageRef, pullName, remoteDigest, type RegistryOptions } from './registry.js';
import { SWAP_SCRIPT, type SwapItem, type SwapPlan } from './swap-script.js';

// Container updates through the Docker Engine API: find containers labelled
// arclight.autoupdate=true, compare their image digest with the registry, and recreate them
// with the same configuration on a newer image. Containers sharing another's network
// namespace (network_mode: service:gluetun) are recreated after their parent, because a
// recreated parent leaves them without a network.

export const CONTAINER_CACHE_KEY = 'containerUpdates';
export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
export const NEW_SUFFIX = '-arclight-new';

const Cache = z.object({
  checkedAt: z.string().nullable().default(null),
  containers: z.array(ContainerUpdateItem).default([]),
  lastRun: ContainerUpdateRun.optional(),
});
type Cache = z.infer<typeof Cache>;

export class ContainerUpdateError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE' | 'NOT_FOUND' | 'NOTHING_TO_DO',
    message: string,
  ) {
    super(message);
    this.name = 'ContainerUpdateError';
  }
}

export interface SwapRunner {
  /** Run the swap in this process's environment (child process). */
  local(plan: SwapPlan): Promise<{ ok: boolean; message: string }>;
}

export interface ContainerUpdaterOptions {
  db: Db;
  /** Where the Docker socket is mounted in this container. */
  socketPath?: string;
  /** Test seam: talk to a fake Docker API over TCP instead of the socket. */
  endpoint?: DockerEndpoint;
  isDocker: boolean;
  /** Container id or name of this Arclight instance; default ARCLIGHT_CONTAINER_ID, then the hostname. */
  selfRef?: string;
  registry?: RegistryOptions;
  now?: () => Date;
  log?: Logger;
  swap?: SwapRunner;
  /** Delay before the helper container stops us, so the HTTP reply gets out. */
  helperDelayMs?: number;
}

function readKey(db: Db, key: string): unknown {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

function writeKey(db: Db, key: string, value: unknown, now: string): void {
  db.insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}

const nameOf = (c: Pick<ContainerInspect, 'Name'>) => c.Name.replace(/^\//, '');
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** `container:<ref>` -> ref, else null. */
export function networkParentRef(c: Pick<ContainerInspect, 'HostConfig'>): string | null {
  const mode = c.HostConfig.NetworkMode ?? '';
  return mode.startsWith('container:') ? mode.slice('container:'.length) : null;
}

/** True when `hour` falls in [startHour, endHour), wrapping past midnight; equal bounds = all day. */
export function inWindow(hour: number, w: UpdateWindow): boolean {
  if (w.startHour === w.endHour) return true;
  return w.startHour < w.endHour ? hour >= w.startHour && hour < w.endHour : hour >= w.startHour || hour < w.endHour;
}

/**
 * The create body that reproduces `c` on `image`. Values the old image supplied (env, cmd,
 * entrypoint, labels, exposed ports, …) are dropped so the new image's defaults apply;
 * everything set at run time is kept. `parentId` re-points a shared network namespace.
 */
export function recreateBody(c: ContainerInspect, oldImage: ImageInspect | null, image: string, parentId?: string): Record<string, unknown> {
  const img = (oldImage?.Config ?? {}) as Record<string, unknown>;
  const config: Record<string, unknown> = { ...c.Config, Image: image };
  const imgEnv = new Set(Array.isArray(img['Env']) ? (img['Env'] as string[]) : []);
  if (Array.isArray(config['Env'])) config['Env'] = (config['Env'] as string[]).filter((e) => !imgEnv.has(e));
  for (const key of ['Cmd', 'Entrypoint', 'WorkingDir', 'User', 'Healthcheck', 'StopSignal', 'Shell', 'OnBuild', 'Volumes']) {
    if (key in config && same(config[key], img[key])) delete config[key];
  }
  const imgLabels = (img['Labels'] ?? {}) as Record<string, string>;
  if (config['Labels'] && typeof config['Labels'] === 'object') {
    config['Labels'] = Object.fromEntries(Object.entries(config['Labels'] as Record<string, string>).filter(([k, v]) => imgLabels[k] !== v));
  }
  const imgPorts = (img['ExposedPorts'] ?? {}) as Record<string, unknown>;
  if (config['ExposedPorts'] && typeof config['ExposedPorts'] === 'object') {
    const kept = Object.fromEntries(Object.entries(config['ExposedPorts'] as Record<string, unknown>).filter(([k]) => !(k in imgPorts)));
    if (Object.keys(kept).length) config['ExposedPorts'] = kept;
    else delete config['ExposedPorts'];
  }
  const hostConfig: Record<string, unknown> = { ...c.HostConfig };
  const parentRef = networkParentRef(c);
  const shortId = c.Id.slice(0, 12);
  if (parentRef !== null) {
    // Joined namespaces take hostname and networks from the parent.
    delete config['Hostname'];
    delete config['Domainname'];
    if (parentId) hostConfig['NetworkMode'] = `container:${parentId}`;
    return { ...config, HostConfig: hostConfig };
  }
  if (config['Hostname'] === shortId) delete config['Hostname'];
  const mode = String(hostConfig['NetworkMode'] ?? '');
  const networks = c.NetworkSettings?.Networks ?? {};
  if (mode === 'host' || mode === 'none' || Object.keys(networks).length === 0) return { ...config, HostConfig: hostConfig };
  const endpoints: Record<string, unknown> = {};
  for (const [net, ep] of Object.entries(networks)) {
    const aliases = Array.isArray(ep['Aliases']) ? (ep['Aliases'] as string[]).filter((a) => a !== shortId) : undefined;
    endpoints[net] = {
      ...(aliases?.length ? { Aliases: aliases } : {}),
      ...(ep['IPAMConfig'] ? { IPAMConfig: ep['IPAMConfig'] } : {}),
      ...(ep['Links'] ? { Links: ep['Links'] } : {}),
      ...(ep['DriverOpts'] ? { DriverOpts: ep['DriverOpts'] } : {}),
    };
  }
  return { ...config, HostConfig: hostConfig, NetworkingConfig: { EndpointsConfig: endpoints } };
}

/** Parents before dependents (the order containers start in). */
export function orderParentsFirst(items: ContainerInspect[]): ContainerInspect[] {
  const byRef = new Map<string, ContainerInspect>();
  for (const c of items) {
    byRef.set(c.Id, c);
    byRef.set(nameOf(c), c);
  }
  const out: ContainerInspect[] = [];
  const seen = new Set<string>();
  const visit = (c: ContainerInspect, depth = 0) => {
    if (seen.has(c.Id) || depth > 20) return;
    const parentRef = networkParentRef(c);
    const parent = parentRef ? (byRef.get(parentRef) ?? [...byRef.values()].find((p) => p.Id.startsWith(parentRef))) : undefined;
    if (parent && parent.Id !== c.Id) visit(parent, depth + 1);
    if (seen.has(c.Id)) return;
    seen.add(c.Id);
    out.push(c);
  };
  for (const c of items) visit(c);
  return out;
}

/** Default swap runner: the script as a child process of this Node. */
export function localSwapRunner(env: NodeJS.ProcessEnv): SwapRunner {
  return {
    local: (plan) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', SWAP_SCRIPT], { env: { ...env, ARCLIGHT_UPDATE_PLAN: JSON.stringify(plan) }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (c: Buffer) => (out += c.toString()));
        child.stderr.on('data', (c: Buffer) => (out += c.toString()));
        child.on('error', (err) => resolve({ ok: false, message: err.message }));
        child.on('close', (code) => resolve({ ok: code === 0, message: out.trim() || (code === 0 ? 'updated' : `swap exited with ${code}`) }));
      }),
  };
}

export class ContainerUpdater {
  private readonly socketPath: string;
  private readonly docker: DockerClient | null;
  private running: Promise<ContainerUpdateRun> | null = null;

  constructor(private readonly opts: ContainerUpdaterOptions) {
    this.socketPath = opts.socketPath ?? DEFAULT_DOCKER_SOCKET;
    const endpoint = opts.endpoint ?? (existsSync(this.socketPath) ? { socketPath: this.socketPath } : null);
    this.docker = endpoint ? new DockerClient(endpoint) : null;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private cache(): Cache {
    const parsed = Cache.safeParse(readKey(this.opts.db, CONTAINER_CACHE_KEY) ?? {});
    return parsed.success ? parsed.data : Cache.parse({});
  }

  private save(cache: Cache): void {
    writeKey(this.opts.db, CONTAINER_CACHE_KEY, cache, this.now().toISOString());
  }

  /** Why container updates cannot run, or null when the socket answers. */
  async unavailableReason(): Promise<string | null> {
    if (!this.docker) {
      return this.opts.isDocker
        ? `Notify only: the Docker socket is not mounted at ${this.socketPath}. Update by pulling the image.`
        : 'Notify only: Arclight is not running in Docker. Install new releases from GitHub.';
    }
    if (!(await this.docker.ping())) return `Notify only: the Docker API at ${this.socketPath} does not answer. Update by pulling the image.`;
    return null;
  }

  async info(mode: UpdateSettings['mode']): Promise<ContainerUpdatesInfo> {
    const reason = await this.unavailableReason();
    const cache = this.cache();
    return {
      dockerAvailable: reason === null,
      socketPath: this.socketPath,
      ...(reason ? { reason } : {}),
      mode,
      checkedAt: cache.checkedAt,
      containers: cache.containers,
      ...(cache.lastRun ? { lastRun: cache.lastRun } : {}),
    };
  }

  /** Cached items (no Docker calls); used by the health check. */
  cachedContainers(): ContainerUpdateItem[] {
    return this.cache().containers;
  }

  lastCheckedAt(): string | null {
    return this.cache().checkedAt;
  }

  private requireDocker(): DockerClient {
    if (!this.docker) throw new ContainerUpdateError('UNAVAILABLE', 'the Docker socket is not mounted');
    return this.docker;
  }

  private async selfId(docker: DockerClient): Promise<string | null> {
    const ref = this.opts.selfRef ?? process.env['ARCLIGHT_CONTAINER_ID'] ?? hostname();
    try {
      return (await docker.inspectContainer(ref)).Id;
    } catch {
      return null;
    }
  }

  /** Compare every labelled container's image digest with its registry. */
  async check(): Promise<ContainerUpdateItem[]> {
    const reason = await this.unavailableReason();
    if (reason) throw new ContainerUpdateError('UNAVAILABLE', reason);
    const docker = this.requireDocker();
    const selfId = await this.selfId(docker);
    const list = await docker.listContainers(`${AUTOUPDATE_LABEL}=true`);
    const checkedAt = this.now().toISOString();
    const items: ContainerUpdateItem[] = [];
    for (const summary of list) {
      const c = await docker.inspectContainer(summary.Id);
      const parentRef = networkParentRef(c);
      let networkParent: string | undefined;
      if (parentRef) networkParent = await docker.inspectContainer(parentRef).then(nameOf, () => parentRef);
      const base = { id: c.Id, name: nameOf(c), image: c.Config.Image, isSelf: c.Id === selfId, labels: { ...(c.Config.Labels ?? {}) }, checkedAt, ...(networkParent ? { networkParent } : {}) };
      try {
        const ref = parseImageRef(c.Config.Image);
        if (ref.digest) {
          items.push({ ...base, updateAvailable: false, currentDigest: ref.digest, error: 'Pinned to a digest; not updated' });
          continue;
        }
        const image = await docker.inspectImage(c.Image);
        const digests = (image.RepoDigests ?? []).map((d) => d.slice(d.indexOf('@') + 1));
        if (digests.length === 0) {
          items.push({ ...base, updateAvailable: false, error: 'Built locally; there is no registry image to compare' });
          continue;
        }
        const latest = await remoteDigest(ref, this.opts.registry);
        items.push({ ...base, currentDigest: digests[0]!, latestDigest: latest, updateAvailable: !digests.includes(latest) });
      } catch (err) {
        items.push({ ...base, updateAvailable: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    this.save({ ...this.cache(), checkedAt, containers: items });
    return items;
  }

  /**
   * Pull and recreate `refs` (names or ids; default: every cached container with an update),
   * plus the containers that share their network namespace.
   */
  update(refs?: string[]): Promise<ContainerUpdateRun> {
    this.running ??= this.runUpdate(refs).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runUpdate(refs?: string[]): Promise<ContainerUpdateRun> {
    const reason = await this.unavailableReason();
    if (reason) throw new ContainerUpdateError('UNAVAILABLE', reason);
    const docker = this.requireDocker();
    const cached = this.cache().containers;
    const wanted = refs
      ? refs.map((r) => {
          const hit = cached.find((c) => c.name === r || c.id === r || c.id.startsWith(r));
          if (!hit) throw new ContainerUpdateError('NOT_FOUND', `no labelled container "${r}"; run a check first`);
          return hit;
        })
      : cached.filter((c) => c.updateAvailable);
    if (wanted.length === 0) throw new ContainerUpdateError('NOTHING_TO_DO', 'no container has an update');

    const at = this.now().toISOString();
    const created: string[] = [];
    try {
      const selfId = await this.selfId(docker);
      // Every container, to find dependents of what we recreate.
      const all = await Promise.all((await docker.listContainers()).map((s) => docker.inspectContainer(s.Id)));
      const byId = new Map(all.map((c) => [c.Id, c]));
      const pullIds = new Set(wanted.map((w) => w.id));
      const set = new Map<string, ContainerInspect>();
      const add = (c: ContainerInspect) => {
        if (set.has(c.Id)) return;
        set.set(c.Id, c);
        for (const d of all) {
          const p = networkParentRef(d);
          if (p && (p === c.Id || p === nameOf(c) || c.Id.startsWith(p))) add(d);
        }
      };
      for (const w of wanted) {
        const c = byId.get(w.id) ?? (await docker.inspectContainer(w.id));
        add(c);
      }
      const ordered = orderParentsFirst([...set.values()]);

      // 1. Pull new images for the containers that have an update (dependents keep theirs).
      for (const c of ordered) {
        if (!pullIds.has(c.Id)) continue;
        const ref = parseImageRef(c.Config.Image);
        await docker.pull(pullName(ref), ref.tag);
      }

      // 2. Create the replacements under temporary names, parents first.
      const newIds = new Map<string, string>();
      const items: SwapItem[] = [];
      for (const c of ordered) {
        const oldImage = await docker.inspectImage(c.Image).catch(() => null);
        const image = pullIds.has(c.Id) ? c.Config.Image : c.Image;
        const parentRef = networkParentRef(c);
        const parent = parentRef ? ordered.find((p) => p.Id === parentRef || nameOf(p) === parentRef || p.Id.startsWith(parentRef)) : undefined;
        const newParentId = parent ? newIds.get(parent.Id) : undefined;
        const name = nameOf(c);
        await docker.remove(`${name}${NEW_SUFFIX}`); // leftovers of an interrupted run
        const id = await docker.createContainer(`${name}${NEW_SUFFIX}`, recreateBody(c, oldImage, image, newParentId));
        created.push(id);
        newIds.set(c.Id, id);
        items.push({ name, oldId: c.Id, newId: id });
      }

      // 3. Swap. Our own container cannot stop itself mid-run: a helper container does it.
      const involvesSelf = selfId !== null && ordered.some((c) => c.Id === selfId);
      const names = items.map((i) => i.name);
      let run: ContainerUpdateRun;
      if (involvesSelf) {
        const self = ordered.find((c) => c.Id === selfId)!;
        await this.startHelper(docker, self, pullIds.has(self.Id) ? self.Config.Image : self.Image, { delayMs: this.opts.helperDelayMs ?? 3000, items });
        run = { at, ok: true, updated: names, handedOff: true, message: `Updating ${names.join(', ')}; Arclight restarts in a few seconds.` };
      } else {
        const runner = this.opts.swap ?? localSwapRunner(this.endpointEnv());
        const result = await runner.local({ delayMs: 0, items });
        run = { at, ok: result.ok, updated: result.ok ? names : [], handedOff: false, message: result.ok ? `Updated ${names.join(', ')}.` : result.message };
        if (!result.ok) await Promise.all(created.map((id) => docker.remove(id).catch(() => undefined)));
      }
      const cache = this.cache();
      this.save({
        ...cache,
        lastRun: run,
        containers: run.ok ? cache.containers.map((c) => (names.includes(c.name) ? { ...c, updateAvailable: false, ...(c.latestDigest ? { currentDigest: c.latestDigest } : {}) } : c)) : cache.containers,
      });
      this.opts.log?.info({ updated: names, handedOff: run.handedOff, ok: run.ok }, 'container update');
      return run;
    } catch (err) {
      if (err instanceof ContainerUpdateError) throw err;
      await Promise.all(created.map((id) => docker.remove(id).catch(() => undefined)));
      const run: ContainerUpdateRun = { at, ok: false, updated: [], handedOff: false, message: err instanceof Error ? err.message : String(err) };
      this.save({ ...this.cache(), lastRun: run });
      return run;
    }
  }

  private endpointEnv(): NodeJS.ProcessEnv {
    const ep = this.opts.endpoint;
    if (ep && 'host' in ep) return { ...process.env, ARCLIGHT_DOCKER_TCP: `${ep.host}:${ep.port}` };
    return { ...process.env, ARCLIGHT_DOCKER_SOCKET: ep && 'socketPath' in ep ? ep.socketPath : this.socketPath };
  }

  /** A throwaway container from the Arclight image that runs the swap script. */
  private async startHelper(docker: DockerClient, self: ContainerInspect, image: string, plan: SwapPlan): Promise<void> {
    const hostSocket = self.Mounts?.find((m) => m.Destination === this.socketPath)?.Source ?? this.socketPath;
    const id = await docker.createContainer(`arclight-updater-${Date.now()}`, {
      Image: image,
      Entrypoint: [''],
      Cmd: ['node', '-e', SWAP_SCRIPT],
      Env: [`ARCLIGHT_UPDATE_PLAN=${JSON.stringify(plan)}`, 'ARCLIGHT_DOCKER_SOCKET=/var/run/docker.sock'],
      User: '0:0',
      Labels: { 'arclight.updater': 'true' },
      HostConfig: { Binds: [`${hostSocket}:/var/run/docker.sock`], AutoRemove: true, NetworkMode: 'none' },
    });
    await docker.start(id);
  }
}
