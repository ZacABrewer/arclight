import { eq } from 'drizzle-orm';
import type { Socket } from 'node:net';
import {
  openHttpConnectTunnel,
  openSocks5Tunnel,
  type NetworkProxy,
  type ProxyConfig,
} from '@arclight/indexers';
import {
  INDEXER_PROXY_SECRET_MASK,
  IndexerProxyCreate,
  IndexerProxyTestRequest,
  IndexerProxyUpdate,
  type IndexerProxy,
  type IndexerProxyTestResult,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { indexerProxies, indexers } from './schema.js';
import { IndexersError, parseOrThrow } from './errors.js';

// Indexer proxies: CRUD, connectivity test, and resolution of the proxies that apply to an
// indexer (its explicit `proxyId`, else every proxy sharing one of its tags).

export const DEFAULT_PROXY_TEST_URL = 'https://www.google.com/';

type ProxyRow = typeof indexerProxies.$inferSelect;

export type TunnelOpener = (proxy: NetworkProxy, host: string, port: number, timeoutMs: number) => Promise<Socket>;

export interface ProxiesServiceOptions {
  db: Db;
  fetch?: typeof fetch;
  now?: () => number;
  /** Test seam for the HTTP CONNECT / SOCKS5 check. */
  openTunnel?: TunnelOpener;
  /** Called after any change so cached indexer clients are rebuilt. */
  onChange?: () => void;
}

export class ProxiesService {
  private readonly db: Db;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly tunnel: TunnelOpener;
  private readonly onChange: (() => void) | undefined;

  constructor(opts: ProxiesServiceOptions) {
    this.db = opts.db;
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? Date.now;
    this.tunnel = opts.openTunnel ?? ((proxy, host, port, timeoutMs) =>
        proxy.type === 'socks5' ? openSocks5Tunnel(proxy, host, port, timeoutMs) : openHttpConnectTunnel(proxy, host, port, timeoutMs));
    this.onChange = opts.onChange;
  }

  list(): IndexerProxy[] {
    return this.rows().map(toResource);
  }

  get(id: number): IndexerProxy {
    return toResource(this.requireRow(id));
  }

  create(input: IndexerProxyCreate): IndexerProxy {
    const data = parseOrThrow(IndexerProxyCreate, input);
    this.assertUniqueName(data.name);
    const row = this.db
      .insert(indexerProxies)
      .values({
        name: data.name,
        type: data.type,
        host: normalizeHost(data.host),
        port: data.port,
        username: emptyToNull(data.username),
        password: data.password === INDEXER_PROXY_SECRET_MASK ? null : emptyToNull(data.password),
        requestTimeout: data.requestTimeout ?? null,
        tags: data.tags,
      })
      .returning()
      .get();
    this.onChange?.();
    return toResource(row);
  }

  update(id: number, input: IndexerProxyUpdate): IndexerProxy {
    const current = this.requireRow(id);
    const patch = parseOrThrow(IndexerProxyUpdate, input);
    if (patch.name !== undefined && patch.name.toLowerCase() !== current.name.toLowerCase()) this.assertUniqueName(patch.name, id);
    const password =
      patch.password === undefined || patch.password === INDEXER_PROXY_SECRET_MASK ? current.password : emptyToNull(patch.password);
    const row = this.db
      .update(indexerProxies)
      .set({
        name: patch.name ?? current.name,
        type: patch.type ?? current.type,
        host: patch.host !== undefined ? normalizeHost(patch.host) : current.host,
        port: patch.port ?? current.port,
        username: patch.username !== undefined ? emptyToNull(patch.username) : current.username,
        password,
        requestTimeout: patch.requestTimeout !== undefined ? patch.requestTimeout : current.requestTimeout,
        tags: patch.tags ?? current.tags,
      })
      .where(eq(indexerProxies.id, id))
      .returning()
      .get();
    if (!row) throw new IndexersError('NOT_FOUND', `indexer proxy ${id} not found`);
    this.onChange?.();
    return toResource(row);
  }

  delete(id: number): void {
    this.requireRow(id);
    this.db.update(indexers).set({ proxyId: null }).where(eq(indexers.proxyId, id)).run();
    this.db.delete(indexerProxies).where(eq(indexerProxies.id, id)).run();
    this.onChange?.();
  }

  exists(id: number): boolean {
    return this.db.select({ id: indexerProxies.id }).from(indexerProxies).where(eq(indexerProxies.id, id)).get() !== undefined;
  }

  /** Proxy rows that apply to an indexer: its explicit proxy, else those sharing a tag. */
  applicable(indexer: { proxyId: number | null; tags: readonly number[] }): ProxyRow[] {
    if (indexer.proxyId !== null) {
      const row = this.db.select().from(indexerProxies).where(eq(indexerProxies.id, indexer.proxyId)).get();
      return row ? [row] : [];
    }
    if (indexer.tags.length === 0) return [];
    const tags = new Set(indexer.tags);
    return this.rows().filter((p) => p.tags.some((t) => tags.has(t)));
  }

  /** Package proxy configs for an indexer, or undefined when none apply. */
  resolve(indexer: { proxyId: number | null; tags: readonly number[] }): ProxyConfig[] | undefined {
    const configs = this.applicable(indexer).map(toConfig);
    return configs.length > 0 ? configs : undefined;
  }

  /** Test a stored proxy (its password is used even though responses mask it). */
  async testSaved(id: number, url?: string): Promise<IndexerProxyTestResult> {
    const row = this.requireRow(id);
    return this.check(row, url);
  }

  /** Test an unsaved proxy. The mask as password means "use the stored proxy with this name". */
  async test(input: IndexerProxyTestRequest): Promise<IndexerProxyTestResult> {
    const data = parseOrThrow(IndexerProxyTestRequest, input);
    let password = emptyToNull(data.password);
    if (password === INDEXER_PROXY_SECRET_MASK) {
      const stored = this.rows().find((r) => r.name.toLowerCase() === data.name.toLowerCase());
      password = stored?.password ?? null;
    }
    const row: ProxyRow = {
      id: 0,
      name: data.name,
      type: data.type,
      host: normalizeHost(data.host),
      port: data.port,
      username: emptyToNull(data.username),
      password,
      requestTimeout: data.requestTimeout ?? null,
      tags: data.tags,
    };
    return this.check(row, data.url);
  }

  private async check(row: ProxyRow, url: string | undefined): Promise<IndexerProxyTestResult> {
    const started = this.now();
    const timeoutMs = (row.requestTimeout ?? 20) * 1000;
    const done = (ok: boolean, message: string): IndexerProxyTestResult => ({
      ok,
      message,
      durationMs: Math.max(0, Math.round(this.now() - started)),
    });
    try {
      if (row.type === 'flaresolverr') {
        const base = flareSolverrUrl(row);
        const res = await (this.fetchImpl ?? fetch)(`${base}/v1`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cmd: 'sessions.list' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return done(false, `FlareSolverr answered HTTP ${res.status}`);
        const json = (await res.json().catch(() => null)) as { status?: unknown; message?: unknown } | null;
        if (!json || json.status !== 'ok') {
          return done(false, `FlareSolverr reported an error: ${typeof json?.message === 'string' ? json.message : 'unexpected response'}`);
        }
        return done(true, 'FlareSolverr is reachable');
      }
      let target: URL;
      try {
        target = new URL(url ?? DEFAULT_PROXY_TEST_URL);
      } catch {
        return done(false, `"${url}" is not a valid URL`);
      }
      const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;
      const socket = await this.tunnel(toNetwork(row), target.hostname, port, timeoutMs);
      socket.destroy();
      return done(true, `Connected to ${target.hostname}:${port} through the proxy`);
    } catch (err) {
      return done(false, err instanceof Error ? err.message : String(err));
    }
  }

  private rows(): ProxyRow[] {
    return this.db.select().from(indexerProxies).orderBy(indexerProxies.id).all();
  }

  private requireRow(id: number): ProxyRow {
    const row = this.db.select().from(indexerProxies).where(eq(indexerProxies.id, id)).get();
    if (!row) throw new IndexersError('NOT_FOUND', `indexer proxy ${id} not found`);
    return row;
  }

  private assertUniqueName(name: string, exceptId?: number): void {
    const wanted = name.trim().toLowerCase();
    const clash = this.rows().find((r) => r.id !== exceptId && r.name.toLowerCase() === wanted);
    if (clash) throw new IndexersError('CONFLICT', `an indexer proxy named "${clash.name}" already exists`);
  }
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value;
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\/+$/, '');
}

/** `http://host:port` for FlareSolverr; a scheme in `host` is kept. */
export function flareSolverrUrl(row: Pick<ProxyRow, 'host' | 'port'>): string {
  const withScheme = /^https?:\/\//i.test(row.host) ? row.host : `http://${row.host}`;
  const url = new URL(withScheme);
  if (!url.port) url.port = String(row.port);
  return url.toString().replace(/\/+$/, '');
}

function toNetwork(row: ProxyRow): NetworkProxy {
  if (row.type === 'flaresolverr') throw new Error('not a network proxy');
  return {
    type: row.type,
    host: row.host.replace(/^[a-z0-9]+:\/\//i, ''),
    port: row.port,
    ...(row.username ? { username: row.username } : {}),
    ...(row.password ? { password: row.password } : {}),
  };
}

export function toConfig(row: ProxyRow): ProxyConfig {
  if (row.type === 'flaresolverr') {
    return {
      type: 'flaresolverr',
      url: flareSolverrUrl(row),
      ...(row.requestTimeout ? { timeoutMs: row.requestTimeout * 1000 } : {}),
    };
  }
  return toNetwork(row);
}

function toResource(row: ProxyRow): IndexerProxy {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    host: row.host,
    port: row.port,
    ...(row.username ? { username: row.username } : {}),
    ...(row.password ? { password: INDEXER_PROXY_SECRET_MASK } : {}),
    ...(row.requestTimeout ? { requestTimeout: row.requestTimeout } : {}),
    tags: row.tags,
  };
}
