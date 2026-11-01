import { KEYS } from '../config.js';
import { normalizeBaseUrl } from './address.js';
import { readJson, writeJson, type KeyValueStore } from './kv.js';

// The saved servers: addresses and names only (sign-in lives in the WebView's cookies).

export interface Server {
  id: string;
  name: string;
  /** Base URL, normalized (no trailing slash). */
  url: string;
  addedAt: string;
}

interface Persisted {
  version: 1;
  servers: Server[];
  selectedId: string | null;
}

const EMPTY: Persisted = { version: 1, servers: [], selectedId: null };

export function defaultServerName(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

const sameUrl = (a: string, b: string) => normalizeBaseUrl(a).toLowerCase() === normalizeBaseUrl(b).toLowerCase();

/** The saved server a page URL belongs to (longest matching base URL wins). */
export function serverForUrl(servers: readonly Server[], pageUrl: string): Server | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  let best: Server | null = null;
  for (const s of servers) {
    const base = new URL(s.url);
    if (base.origin !== page.origin) continue;
    const basePath = base.pathname.replace(/\/+$/, '');
    if (basePath && page.pathname !== basePath && !page.pathname.startsWith(`${basePath}/`)) continue;
    if (!best || s.url.length > best.url.length) best = s;
  }
  return best;
}

export class ServerStore {
  private listeners = new Set<(servers: Server[]) => void>();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly newId: () => string = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async load(): Promise<Persisted> {
    const data = await readJson<Persisted>(this.kv, KEYS.servers);
    if (!data || data.version !== 1 || !Array.isArray(data.servers)) return { ...EMPTY, servers: [] };
    const servers = data.servers.filter((s) => s && typeof s.id === 'string' && typeof s.url === 'string');
    const selectedId = servers.some((s) => s.id === data.selectedId) ? data.selectedId : (servers[0]?.id ?? null);
    return { version: 1, servers, selectedId };
  }

  private async save(data: Persisted): Promise<void> {
    await writeJson(this.kv, KEYS.servers, data);
    for (const l of this.listeners) l(data.servers);
  }

  /** Called after every change (used to hand the allowed origins to the native layer). */
  onChange(listener: (servers: Server[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(): Promise<Server[]> {
    return (await this.load()).servers;
  }

  async get(id: string): Promise<Server | null> {
    return (await this.load()).servers.find((s) => s.id === id) ?? null;
  }

  async selected(): Promise<Server | null> {
    const d = await this.load();
    return d.servers.find((s) => s.id === d.selectedId) ?? null;
  }

  async findByUrl(url: string): Promise<Server | null> {
    return (await this.load()).servers.find((s) => sameUrl(s.url, url)) ?? null;
  }

  /** Adds a server (or returns the existing one with the same URL) and selects it. */
  async add(url: string, name?: string): Promise<Server> {
    const d = await this.load();
    const normalized = normalizeBaseUrl(url);
    let server = d.servers.find((s) => sameUrl(s.url, normalized));
    if (server) {
      if (name?.trim()) server.name = name.trim();
    } else {
      server = { id: this.newId(), name: name?.trim() || defaultServerName(normalized), url: normalized, addedAt: this.now().toISOString() };
      d.servers.push(server);
    }
    d.selectedId = server.id;
    await this.save(d);
    return server;
  }

  async rename(id: string, name: string): Promise<void> {
    const d = await this.load();
    const s = d.servers.find((x) => x.id === id);
    if (!s) return;
    s.name = name.trim() || defaultServerName(s.url);
    await this.save(d);
  }

  /** Changes a server's address (after it was validated). */
  async updateUrl(id: string, url: string): Promise<void> {
    const d = await this.load();
    const s = d.servers.find((x) => x.id === id);
    if (!s) return;
    const normalized = normalizeBaseUrl(url);
    if (d.servers.some((x) => x.id !== id && sameUrl(x.url, normalized))) throw new Error('Another saved server already uses that address.');
    if (s.name === defaultServerName(s.url)) s.name = defaultServerName(normalized);
    s.url = normalized;
    await this.save(d);
  }

  async remove(id: string): Promise<Server | null> {
    const d = await this.load();
    const removed = d.servers.find((s) => s.id === id) ?? null;
    d.servers = d.servers.filter((s) => s.id !== id);
    if (d.selectedId === id) d.selectedId = d.servers[0]?.id ?? null;
    await this.save(d);
    return removed;
  }

  async select(id: string): Promise<void> {
    const d = await this.load();
    if (!d.servers.some((s) => s.id === id)) return;
    d.selectedId = id;
    await this.save(d);
  }
}
