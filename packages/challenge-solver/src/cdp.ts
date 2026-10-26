import { SolverError } from './errors.js';

/** The subset of the WHATWG WebSocket the connection uses (Node 24's global satisfies it). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type CdpParams = Record<string, unknown>;
export type CdpListener = (params: CdpParams, sessionId: string | undefined) => void;

export const DEFAULT_CDP_TIMEOUT_MS = 30_000;

interface Pending {
  method: string;
  resolve: (value: CdpParams) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A Chrome DevTools Protocol connection over one WebSocket, in flattened-session mode:
 * commands for a page carry the `sessionId` returned by `Target.attachToTarget`.
 */
export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<CdpListener>>();
  private readonly closeListeners = new Set<() => void>();
  private isClosed = false;

  private constructor(
    private readonly ws: WebSocketLike,
    private readonly defaultTimeoutMs: number,
  ) {
    ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    ws.addEventListener('close', () => this.handleClose());
  }

  static connect(url: string, opts: { factory?: WebSocketFactory; timeoutMs?: number } = {}): Promise<CdpConnection> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let ws: WebSocketLike;
      try {
        ws = (opts.factory ?? defaultFactory)(url);
      } catch (err) {
        reject(new SolverError('protocol', `Cannot connect to DevTools at ${url}: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        ws.close();
        reject(new SolverError('protocol', `DevTools at ${url} did not accept the connection within ${timeoutMs} ms`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(new CdpConnection(ws, timeoutMs));
      });
      const fail = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new SolverError('protocol', `Cannot connect to DevTools at ${url}`));
      };
      ws.addEventListener('error', fail);
      ws.addEventListener('close', fail);
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Send a command; resolves with its `result`, rejects with a SolverError on a CDP error. */
  send<T extends CdpParams = CdpParams>(method: string, params: CdpParams = {}, sessionId?: string, timeoutMs?: number): Promise<T> {
    if (this.isClosed) return Promise.reject(new SolverError('closed', `DevTools connection closed (calling ${method})`));
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) message['sessionId'] = sessionId;
    return new Promise<T>((resolve, reject) => {
      const ms = timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SolverError('protocol', `${method} did not answer within ${ms} ms`));
      }, ms);
      this.pending.set(id, { method, resolve: resolve as (v: CdpParams) => void, reject, timer });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new SolverError('protocol', `Cannot send ${method}: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
      }
    });
  }

  /** Subscribe to an event (`Network.responseReceived`, ...). Returns unsubscribe. */
  on(method: string, listener: CdpListener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Called once when the connection closes (either side). Returns unsubscribe. */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private handleClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new SolverError('closed', `DevTools connection closed while waiting for ${p.method}`));
    }
    this.pending.clear();
    for (const l of this.closeListeners) l();
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closing
    }
    this.handleClose();
  }

  private onMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : String(data);
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // not CDP; ignore
    }
    if (!isObject(msg)) return;
    const sessionId = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : undefined;
    if (typeof msg['id'] === 'number') {
      const p = this.pending.get(msg['id']);
      if (!p) return;
      this.pending.delete(msg['id']);
      clearTimeout(p.timer);
      const error = msg['error'];
      if (isObject(error)) {
        const detail = typeof error['message'] === 'string' ? error['message'] : 'unknown error';
        p.reject(new SolverError('protocol', `${p.method} failed: ${detail}${typeof error['code'] === 'number' ? ` (${error['code']})` : ''}`));
      } else {
        p.resolve(isObject(msg['result']) ? msg['result'] : {});
      }
      return;
    }
    if (typeof msg['method'] === 'string') {
      const set = this.listeners.get(msg['method']);
      if (!set) return;
      const params = isObject(msg['params']) ? msg['params'] : {};
      for (const l of [...set]) l(params, sessionId);
    }
  }
}
