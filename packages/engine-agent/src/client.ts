import type { z } from 'zod';
import { isLoopbackHost } from './config.js';
import {
  AGENT_DEPRECATION_HEADER,
  AGENT_PROTOCOL_VERSION,
  AGENT_TOKEN_HEADER,
  AgentAddResult,
  AgentErrorBody,
  AgentEvent,
  AgentFile,
  AgentFileChecksum,
  AgentStatus,
  AgentTorrent,
  type AgentAddOptions,
  type AgentErrorCode,
} from './protocol.js';

export type AgentClientErrorCode = 'auth' | 'unreachable' | 'bad-response' | 'not-found' | 'rejected' | 'conflict' | 'not-running';

/** Failure talking to an agent. `agentCode` is the agent's own error code when it sent one. */
export class AgentClientError extends Error {
  override readonly name = 'AgentClientError';
  constructor(
    readonly code: AgentClientErrorCode,
    message: string,
    readonly options: { cause?: unknown; httpStatus?: number; agentCode?: AgentErrorCode } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
  get httpStatus(): number | undefined {
    return this.options.httpStatus;
  }
  get agentCode(): AgentErrorCode | undefined {
    return this.options.agentCode;
  }
}

const CODE_FOR: Record<AgentErrorCode, AgentClientErrorCode> = {
  unauthorized: 'auth',
  forbidden: 'rejected',
  'not-found': 'not-found',
  'bad-request': 'rejected',
  conflict: 'conflict',
  incomplete: 'conflict',
  range: 'rejected',
  'not-running': 'not-running',
  'rate-limited': 'auth',
  internal: 'bad-response',
};

export interface AgentClientOptions {
  /** Base URL: http://seedbox:7879, or http://nas:7878/api/v1/engine-agent for an Arclight. */
  url: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout for API calls (not for file transfers). Default 30 s. */
  timeoutMs?: number;
  /** WebSocket implementation (Node's global by default). */
  WebSocket?: typeof globalThis.WebSocket;
}

export interface AgentSubscription {
  close(): void;
  readonly connected: boolean;
}

export interface SubscribeOptions {
  onOpen?: () => void;
  onClose?: (reason: string) => void;
  /** First reconnect delay; doubled per failure up to `maxBackoffMs`. Default 500 ms. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * How the token is sent. `agent`: `x-agent-token` only (the standalone agent and Arclight 0.24+).
 * `api-key`: `x-api-key` only, for an Arclight from before 0.24, which read its full API key there.
 */
type AuthMode = 'agent' | 'api-key';

function authHeaders(token: string, mode: AuthMode): Record<string, string> {
  return mode === 'agent' ? { [AGENT_TOKEN_HEADER]: token } : { 'x-api-key': token };
}

/** True for an Arclight acting as agent (its protocol lives under /api/v1/engine-agent). */
function isArclightAgentUrl(baseUrl: string): boolean {
  try {
    return /\/engine-agent$/.test(new URL(baseUrl).pathname.replace(/\/+$/, ''));
  } catch {
    return false;
  }
}

/** HTTP + WebSocket client of the agent protocol. */
export class AgentClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private authMode: AuthMode = 'agent';
  /** The agent accepted the caller's full API key (deprecated); set from AGENT_DEPRECATION_HEADER. */
  private legacyAuth = false;

  constructor(private readonly opts: AgentClientOptions) {
    this.baseUrl = opts.url.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /**
   * Security notes for the connection test: the token crossing a non-loopback network in plain
   * HTTP, and an Arclight agent that only let us in with its full API key.
   */
  warnings(): string[] {
    const out: string[] = [];
    try {
      const u = new URL(this.baseUrl);
      if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
        out.push('The remote engine is reached over plain http://: the token and pulled files cross the network unencrypted. Use https:// or a private network (WireGuard, Tailscale).');
      }
    } catch {
      // The URL was validated by the settings schema.
    }
    if (this.authMode === 'api-key' || this.legacyAuth) {
      out.push(
        "The remote Arclight accepted its full API key as the token. Copy its agent token from Settings > Download Clients > Act as remote engine on that instance and enter it here instead.",
      );
    }
    return out;
  }

  private send(path: string, rest: RequestInit, timeout: number | undefined): Promise<Response> {
    return this.fetchImpl(this.url(path), {
      ...rest,
      headers: { ...authHeaders(this.opts.token, this.authMode), ...(rest.headers as Record<string, string> | undefined) },
      // A redirect would carry the token to wherever it points: never follow one.
      redirect: 'manual',
      ...(timeout !== undefined && !rest.signal ? { signal: AbortSignal.timeout(timeout) } : {}),
    });
  }

  /** Raw request; maps network failures and error bodies to `AgentClientError`. */
  async request(path: string, init: RequestInit & { timeoutMs?: number | null } = {}): Promise<Response> {
    const { timeoutMs, ...rest } = init;
    const timeout = timeoutMs === null ? undefined : (timeoutMs ?? this.timeoutMs);
    let res: Response;
    try {
      res = await this.send(path, rest, timeout);
    } catch (error) {
      throw new AgentClientError('unreachable', `Cannot reach the remote engine at ${this.baseUrl}: ${messageOf(error)}`, { cause: error });
    }
    if (res.headers.get(AGENT_DEPRECATION_HEADER)) this.legacyAuth = true;
    if (res.ok) return res;
    if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      throw new AgentClientError(
        'bad-response',
        `The remote engine answered with a redirect (HTTP ${res.status}${location ? ` to ${location}` : ''}). Redirects are not followed, so the token is not sent elsewhere: enter the final address as the URL.`,
        { httpStatus: res.status },
      );
    }
    let body: AgentErrorBody | null = null;
    try {
      const parsed = AgentErrorBody.safeParse(await res.json());
      if (parsed.success) body = parsed.data;
    } catch {
      body = null;
    }
    // An Arclight from before 0.24 answers its auth hook's 401 (not the agent error shape) when
    // the key is not in x-api-key: retry there once and keep using it for this client.
    if (res.status === 401 && !body && this.authMode === 'agent' && isArclightAgentUrl(this.baseUrl)) {
      this.authMode = 'api-key';
      try {
        const retried = await this.request(path, init);
        return retried;
      } catch (error) {
        if (error instanceof AgentClientError && error.code === 'auth') this.authMode = 'agent';
        throw error;
      }
    }
    if (res.status === 401 || (res.status === 403 && !body)) {
      throw new AgentClientError('auth', `The remote engine rejected the token (HTTP ${res.status}).`, { httpStatus: res.status });
    }
    if (body) {
      throw new AgentClientError(CODE_FOR[body.code], body.error, { httpStatus: res.status, agentCode: body.code });
    }
    throw new AgentClientError(res.status === 404 ? 'not-found' : 'bad-response', `The remote engine answered HTTP ${res.status} for ${path}.`, {
      httpStatus: res.status,
    });
  }

  private async json<T extends z.ZodType>(schema: T, path: string, init: RequestInit = {}): Promise<z.infer<T>> {
    const res = await this.request(path, init);
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (error) {
      throw new AgentClientError('bad-response', `The remote engine sent invalid JSON for ${path}.`, { cause: error });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AgentClientError('bad-response', `Unexpected response for ${path}: ${parsed.error.message}`);
    return parsed.data;
  }

  private async noContent(path: string, init: RequestInit): Promise<void> {
    const res = await this.request(path, init);
    await res.arrayBuffer().catch(() => undefined);
  }

  private static jsonInit(method: string, body: unknown): RequestInit {
    return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }

  /** GET /status, refusing agents speaking another protocol version. */
  async status(): Promise<AgentStatus> {
    const status = await this.json(AgentStatus, '/status');
    if (status.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      throw new AgentClientError(
        'bad-response',
        `The remote engine speaks protocol ${status.protocolVersion}; this Arclight speaks ${AGENT_PROTOCOL_VERSION}. Update both to the same version.`,
      );
    }
    return status;
  }

  list(category?: string): Promise<AgentTorrent[]> {
    const q = category ? `?category=${encodeURIComponent(category)}` : '';
    return this.json(AgentTorrent.array(), `/torrents${q}`);
  }

  get(id: string): Promise<AgentTorrent> {
    return this.json(AgentTorrent, `/torrents/${encodeURIComponent(id)}`);
  }

  /** Adds by magnet (JSON) or by .torrent bytes (multipart: `torrent` file + `options` JSON). */
  add(options: AgentAddOptions, torrentFile?: Uint8Array): Promise<AgentAddResult> {
    if (!torrentFile) return this.json(AgentAddResult, '/torrents', AgentClient.jsonInit('POST', options));
    const form = new FormData();
    form.set('options', JSON.stringify(options));
    form.set('torrent', new Blob([new Uint8Array(torrentFile)], { type: 'application/x-bittorrent' }), 'release.torrent');
    return this.json(AgentAddResult, '/torrents', { method: 'POST', body: form });
  }

  remove(id: string, deleteData: boolean): Promise<void> {
    return this.noContent(`/torrents/${encodeURIComponent(id)}?deleteData=${deleteData}`, { method: 'DELETE' });
  }

  pause(id: string): Promise<void> {
    return this.noContent(`/torrents/${encodeURIComponent(id)}/pause`, { method: 'POST' });
  }

  resume(id: string): Promise<void> {
    return this.noContent(`/torrents/${encodeURIComponent(id)}/resume`, { method: 'POST' });
  }

  setCategory(id: string, category: string): Promise<void> {
    return this.noContent(`/torrents/${encodeURIComponent(id)}/category`, AgentClient.jsonInit('PUT', { category }));
  }

  setSavePath(id: string, savePath: string): Promise<void> {
    return this.noContent(`/torrents/${encodeURIComponent(id)}/save-path`, AgentClient.jsonInit('PUT', { savePath }));
  }

  setListenPort(port: number): Promise<AgentStatus> {
    return this.json(AgentStatus, '/listen-port', AgentClient.jsonInit('PUT', { port }));
  }

  files(id: string): Promise<AgentFile[]> {
    return this.json(AgentFile.array(), `/torrents/${encodeURIComponent(id)}/files`);
  }

  checksum(id: string, index: number): Promise<AgentFileChecksum> {
    // Hashing a large file on the agent takes a while; no API timeout.
    return this.json(AgentFileChecksum, `/torrents/${encodeURIComponent(id)}/files/${index}/sha256`, {
      timeoutMs: null,
    } as RequestInit);
  }

  /** Opens a file's bytes from `start` (Range request). The caller consumes `body`. */
  openFile(id: string, index: number, start = 0, signal?: AbortSignal): Promise<Response> {
    return this.request(`/torrents/${encodeURIComponent(id)}/files/${index}/content`, {
      headers: start > 0 ? { range: `bytes=${start}-` } : {},
      timeoutMs: null,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Subscribes to GET /events, reconnecting with exponential backoff until `close()`. Each
   * (re)connection starts with a `hello` event carrying the agent status.
   */
  subscribe(onEvent: (event: AgentEvent) => void, options: SubscribeOptions = {}): AgentSubscription {
    const Impl = this.opts.WebSocket ?? globalThis.WebSocket;
    const wsUrl = this.url('/events').replace(/^http/, 'ws');
    const base = options.backoffMs ?? 500;
    const max = options.maxBackoffMs ?? 30_000;
    let delay = base;
    let stopped = false;
    let connected = false;
    let socket: WebSocket | null = null;
    let timer: NodeJS.Timeout | null = null;

    const connect = () => {
      if (stopped) return;
      // Node's WebSocket (undici) accepts request headers in its init object.
      const init = { headers: authHeaders(this.opts.token, this.authMode) } as unknown as string[];
      const ws = new Impl(wsUrl, init);
      socket = ws;
      ws.onopen = () => {
        connected = true;
        delay = base;
        options.onOpen?.();
      };
      ws.onmessage = (msg: MessageEvent) => {
        if (typeof msg.data !== 'string') return;
        let raw: unknown;
        try {
          raw = JSON.parse(msg.data);
        } catch {
          return;
        }
        const parsed = AgentEvent.safeParse(raw);
        if (parsed.success) onEvent(parsed.data);
      };
      ws.onerror = () => {
        // onclose follows and schedules the reconnect.
      };
      ws.onclose = (ev: CloseEvent) => {
        const was = connected;
        connected = false;
        socket = null;
        if (was || ev.code !== 1006) options.onClose?.(ev.reason || `closed (${ev.code})`);
        else options.onClose?.('connection failed');
        if (stopped) return;
        timer = setTimeout(connect, delay);
        timer.unref?.();
        delay = Math.min(max, delay * 2);
      };
    };
    connect();

    return {
      close() {
        stopped = true;
        if (timer) clearTimeout(timer);
        socket?.close();
        socket = null;
      },
      get connected() {
        return connected;
      },
    };
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}
