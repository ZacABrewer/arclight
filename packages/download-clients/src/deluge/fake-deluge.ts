/**
 * Test support: an in-memory Deluge Web UI (JSON-RPC at `/json`) with a session cookie,
 * a Connection Manager of daemon hosts, the Label plugin and a torrent table. Not exported
 * from the package entry point.
 */
import { FakeHttpServer, type FakeHttpReply, type FakeRequest } from '../fake-http.js';
import { fromBase64 } from '../http.js';
import { hashFromMagnet, hashFromTorrentFile } from '../torrent-hash.js';

export interface FakeHost {
  id: string;
  host: string;
  port: number;
  /** 'Online' when deluged answers, 'Offline' otherwise. */
  status: 'Online' | 'Offline';
  version: string;
}

export type FakeTorrent = Record<string, unknown>;

export interface RpcCall {
  method: string;
  params: unknown[];
  cookie: string | null;
}

interface RpcError {
  message: string;
  code: number;
}

type RpcHandler = (params: unknown[]) => unknown;

const NOT_AUTHENTICATED: RpcError = { message: 'Not authenticated', code: 1 };
const UNKNOWN_METHOD: RpcError = { message: 'Unknown method', code: 2 };

class RpcThrow extends Error {
  constructor(readonly rpc: RpcError) {
    super(rpc.message);
  }
}

export class FakeDeluge extends FakeHttpServer {
  password = 'deluge';
  /** The `_session_id` the fake currently accepts; undefined = nobody logged in. */
  validSession: string | undefined;
  private sessionCounter = 0;

  hosts: FakeHost[] = [
    { id: 'host-1', host: '127.0.0.1', port: 58846, status: 'Online', version: '2.1.1' },
  ];
  connectedHostId: string | undefined;
  /** Plugins the daemon has enabled. */
  enabledPlugins: string[] = ['Label'];
  /** Plugins installed and available to enable. */
  availablePlugins: string[] = ['Label', 'Scheduler', 'Execute'];
  /**
   * Whether the Web UI knows the Label plugin's methods. It refreshes this on (re)connect,
   * like the real Web UI, which loads the daemon's method list when it connects.
   */
  private labelMethodsLoaded = false;

  labels: string[] = [];
  readonly labelOptions = new Map<string, Record<string, unknown>>();
  readonly torrents = new Map<string, FakeTorrent>();
  config: Record<string, unknown> = {
    stop_seed_at_ratio: false,
    stop_seed_ratio: 2,
    remove_seed_at_ratio: false,
    download_location: '/downloads',
    move_completed: false,
    move_completed_path: '/downloads/completed',
  };
  listenPorts: [number, number] = [6881, 6891];
  randomPort = true;

  readonly rpcCalls: RpcCall[] = [];
  private readonly failures = new Map<string, RpcError[]>();
  private readonly overrides = new Map<string, RpcHandler>();

  constructor() {
    super();
    this.on('POST', '/json', (req) => this.handle(req));
  }

  /** Makes the next call to `method` fail with a JSON-RPC error. */
  failNext(method: string, message: string, code = 4): this {
    const list = this.failures.get(method) ?? [];
    list.push({ message, code });
    this.failures.set(method, list);
    return this;
  }

  /** Replaces a method's behaviour. */
  override(method: string, handler: RpcHandler): this {
    this.overrides.set(method, handler);
    return this;
  }

  /** Simulates the Web UI forgetting the session (restart / timeout). */
  expireSession(): void {
    this.validSession = undefined;
  }

  /** Simulates the Web UI losing its daemon connection. */
  disconnect(): void {
    this.connectedHostId = undefined;
  }

  addTorrent(hash: string, status: FakeTorrent): this {
    this.torrents.set(hash.toLowerCase(), { hash: hash.toLowerCase(), label: '', ...status });
    return this;
  }

  methods(method: string): RpcCall[] {
    return this.rpcCalls.filter((c) => c.method === method);
  }

  private async handle(req: FakeRequest): Promise<FakeHttpReply> {
    let body: { method?: unknown; params?: unknown; id?: unknown };
    try {
      body = JSON.parse(req.bodyText) as typeof body;
    } catch {
      return { status: 400, body: 'Bad request' };
    }
    const method = typeof body.method === 'string' ? body.method : '';
    const params = Array.isArray(body.params) ? (body.params as unknown[]) : [];
    const id = body.id ?? null;
    const cookie = req.headers.get('cookie');
    this.rpcCalls.push({ method, params, cookie });

    const reply = (result: unknown, error: RpcError | null = null, headers: Record<string, string> = {}): FakeHttpReply => ({
      body: { result: error === null ? result : null, error, id },
      headers: { 'content-type': 'application/json', ...headers },
    });

    if (method === 'auth.login') {
      if (params[0] === this.password) {
        this.validSession = `sess-${++this.sessionCounter}`;
        return reply(true, null, { 'set-cookie': `_session_id=${this.validSession}; Path=/json` });
      }
      return reply(false);
    }

    const session = /(?:^|;\s*)_session_id=([^;]+)/.exec(cookie ?? '')?.[1];
    if (this.validSession === undefined || session !== this.validSession) return reply(null, NOT_AUTHENTICATED);

    const failure = this.failures.get(method)?.shift();
    if (failure) return reply(null, failure);

    try {
      const override = this.overrides.get(method);
      const result = override ? override(params) : await this.dispatch(method, params);
      return reply(result ?? null);
    } catch (error) {
      if (error instanceof RpcThrow) return reply(null, error.rpc);
      throw error;
    }
  }

  private async dispatch(method: string, params: unknown[]): Promise<unknown> {
    if (method.startsWith('web.')) return this.web(method, params);

    // Daemon methods only exist while the Web UI is connected.
    if (this.connectedHostId === undefined) throw new RpcThrow(UNKNOWN_METHOD);
    if (method.startsWith('label.')) {
      if (!this.labelMethodsLoaded) throw new RpcThrow(UNKNOWN_METHOD);
      return this.label(method, params);
    }
    return this.core(method, params);
  }

  private web(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'web.connected':
        return this.connectedHostId !== undefined;
      case 'web.get_hosts':
        return this.hosts.map((h) => [h.id, h.host, h.port, 'localclient']);
      case 'web.get_host_status': {
        const host = this.hosts.find((h) => h.id === params[0]);
        if (!host) return null;
        const status = this.connectedHostId === host.id ? 'Connected' : host.status;
        return [host.id, status, host.status === 'Offline' ? '' : host.version];
      }
      case 'web.connect': {
        const host = this.hosts.find((h) => h.id === params[0]);
        this.connectedHostId = undefined;
        if (host && host.status === 'Online') {
          this.connectedHostId = host.id;
          this.labelMethodsLoaded = this.enabledPlugins.includes('Label');
        }
        return null;
      }
      case 'web.disconnect':
        this.connectedHostId = undefined;
        return true;
      default:
        throw new RpcThrow(UNKNOWN_METHOD);
    }
  }

  private label(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'label.get_labels':
        return [...this.labels];
      case 'label.add': {
        const label = String(params[0] ?? '');
        if (!/^[a-z0-9_.-]+$/.test(label)) throw new RpcThrow({ message: 'Exception: Invalid label, valid characters:[a-z0-9_-]', code: 4 });
        if (this.labels.includes(label)) throw new RpcThrow({ message: 'Exception: Label already exists', code: 4 });
        this.labels.push(label);
        return null;
      }
      case 'label.set_torrent': {
        const torrent = this.torrents.get(String(params[0]));
        const label = String(params[1] ?? '');
        if (!torrent) throw new RpcThrow({ message: 'Exception: Unknown Torrent', code: 4 });
        if (label !== '' && !this.labels.includes(label)) throw new RpcThrow({ message: 'Exception: Unknown Label', code: 4 });
        torrent['label'] = label;
        return null;
      }
      case 'label.get_options': {
        const label = String(params[0] ?? '');
        if (!this.labels.includes(label)) throw new RpcThrow({ message: 'KeyError: ' + label, code: 4 });
        return this.labelOptions.get(label) ?? { apply_move_completed: false, move_completed: false, move_completed_path: '' };
      }
      default:
        throw new RpcThrow(UNKNOWN_METHOD);
    }
  }

  private async core(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'daemon.info':
        return this.hosts.find((h) => h.id === this.connectedHostId)?.version ?? '';
      case 'core.get_enabled_plugins':
        return [...this.enabledPlugins];
      case 'core.enable_plugin': {
        const plugin = String(params[0]);
        if (this.availablePlugins.includes(plugin) && !this.enabledPlugins.includes(plugin)) this.enabledPlugins.push(plugin);
        return true;
      }
      case 'core.get_config_values': {
        const keys = Array.isArray(params[0]) ? (params[0] as unknown[]) : [];
        return Object.fromEntries(keys.map((k) => [String(k), this.config[String(k)]]));
      }
      case 'core.set_config': {
        const values = (params[0] ?? {}) as Record<string, unknown>;
        if (Array.isArray(values['listen_ports'])) this.listenPorts = values['listen_ports'] as [number, number];
        if (typeof values['random_port'] === 'boolean') this.randomPort = values['random_port'];
        return null;
      }
      case 'core.get_listen_port':
        return this.listenPorts[0];
      case 'core.get_torrents_status': {
        const filter = (params[0] ?? {}) as Record<string, unknown>;
        const fields = Array.isArray(params[1]) ? (params[1] as string[]) : [];
        const out: Record<string, FakeTorrent> = {};
        for (const [hash, torrent] of this.torrents) {
          if (typeof filter['label'] === 'string' && torrent['label'] !== filter['label']) continue;
          out[hash] = fields.length === 0
            ? { ...torrent }
            : Object.fromEntries(fields.filter((f) => f in torrent).map((f) => [f, torrent[f]]));
        }
        return out;
      }
      case 'core.add_torrent_file': {
        const hash = await hashFromTorrentFile(fromBase64(String(params[1])));
        return this.add(hash, String(params[0]).replace(/\.torrent$/, ''), (params[2] ?? {}) as Record<string, unknown>);
      }
      case 'core.add_torrent_magnet': {
        const hash = hashFromMagnet(String(params[0]));
        if (hash === undefined) return null;
        const name = new URL(String(params[0])).searchParams.get('dn') ?? hash;
        return this.add(hash, name, (params[1] ?? {}) as Record<string, unknown>);
      }
      case 'core.remove_torrent': {
        const hash = String(params[0]);
        if (!this.torrents.has(hash)) throw new RpcThrow({ message: `InvalidTorrentError: torrent_id ${hash} not in session.`, code: 4 });
        this.torrents.delete(hash);
        return true;
      }
      case 'core.pause_torrent':
      case 'core.resume_torrent':
      case 'core.queue_top': {
        const ids = Array.isArray(params[0]) ? (params[0] as unknown[]) : [params[0]];
        for (const id of ids) {
          const torrent = this.torrents.get(String(id));
          if (!torrent) continue;
          if (method === 'core.pause_torrent') torrent['state'] = 'Paused';
          if (method === 'core.resume_torrent') torrent['state'] = torrent['is_finished'] === true ? 'Seeding' : 'Downloading';
        }
        return null;
      }
      default:
        throw new RpcThrow(UNKNOWN_METHOD);
    }
  }

  private add(hash: string, name: string, options: Record<string, unknown>): string {
    if (this.torrents.has(hash)) {
      throw new RpcThrow({ message: `AddTorrentError: Torrent already in session (${hash}).`, code: 4 });
    }
    this.torrents.set(hash, {
      hash,
      name,
      state: options['add_paused'] === true ? 'Paused' : 'Downloading',
      progress: 0,
      eta: 0,
      message: 'OK',
      is_finished: false,
      download_location: options['download_location'] ?? this.config['download_location'],
      total_size: 0,
      total_done: 0,
      total_wanted: 0,
      ratio: 0,
      stop_at_ratio: options['stop_at_ratio'] ?? this.config['stop_seed_at_ratio'],
      stop_ratio: options['stop_ratio'] ?? this.config['stop_seed_ratio'],
      remove_at_ratio: options['remove_at_ratio'] ?? this.config['remove_seed_at_ratio'],
      label: '',
      options,
    });
    return hash;
  }
}
