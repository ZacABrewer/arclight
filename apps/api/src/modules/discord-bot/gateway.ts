import type { Logger } from 'pino';

// Discord gateway client over a WebSocket (the global one in production): Hello -> heartbeat
// (first beat jittered), Identify (or Resume when a session exists), Ready, dispatches, and
// reconnects with exponential backoff. A missing heartbeat ACK, op 7 (Reconnect) and
// op 9 (Invalid Session) all reconnect; fatal close codes (bad token, bad intents) stop.

export const GATEWAY_URL = 'wss://gateway.discord.gg';
/** GUILDS (1 << 0) | GUILD_MESSAGES (1 << 9). */
export const GATEWAY_INTENTS = (1 << 0) | (1 << 9);
/** Close codes after which reconnecting cannot help. */
export const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const Op = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 } as const;

/** The subset of the WHATWG WebSocket the client uses. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => GatewaySocket;

export interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export interface ReadyInfo {
  sessionId: string;
  user: { id: string; username: string };
  applicationId: string;
}

export type GatewayState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'stopped';

export interface GatewayOptions {
  token: string;
  webSocket?: WebSocketCtor;
  url?: string;
  log?: Logger;
  /** Backoff: first delay, multiplier 2, capped at maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 0..1, multiplies the first heartbeat interval (Discord asks for jitter). */
  random?: () => number;
  onReady?: (info: ReadyInfo) => void;
  onDispatch?: (event: string, data: unknown) => void;
  onStateChange?: (state: GatewayState, error?: string) => void;
}

function defaultSocket(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== 'function') throw new Error('this Node.js has no global WebSocket');
  return ctor as WebSocketCtor;
}

export class GatewayClient {
  private readonly opts: GatewayOptions;
  private socket: GatewaySocket | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingAck = false;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private stopped = false;
  /** Consecutive failed connections (resets on Ready/Resumed). */
  attempts = 0;
  state: GatewayState = 'idle';
  lastError: string | null = null;
  /** Payloads sent, newest last (bounded; for diagnostics and tests). */
  readonly sent: GatewayPayload[] = [];

  constructor(opts: GatewayOptions) {
    this.opts = opts;
  }

  get session(): string | null {
    return this.sessionId;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      try {
        socket.close(1000, 'shutting down');
      } catch {
        // already closed
      }
    }
    this.setState('stopped');
  }

  private setState(state: GatewayState, error?: string): void {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    this.opts.onStateChange?.(state, error);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState(this.attempts === 0 && !this.sessionId ? 'connecting' : 'reconnecting');
    const base = this.sessionId && this.resumeUrl ? this.resumeUrl : (this.opts.url ?? GATEWAY_URL);
    const url = `${base.replace(/\/+$/, '')}/?v=10&encoding=json`;
    let socket: GatewaySocket;
    try {
      socket = new (this.opts.webSocket ?? defaultSocket())(url);
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
      return;
    }
    this.socket = socket;
    socket.onmessage = (ev) => this.onMessage(ev.data);
    socket.onerror = () => {
      // The close event follows and decides what happens next.
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      if (this.stopped) return;
      if (FATAL_CLOSE_CODES.has(ev.code)) {
        this.opts.log?.error({ code: ev.code, reason: ev.reason }, 'Discord gateway closed the connection for good');
        this.setState('error', `gateway closed with ${ev.code}${ev.reason ? `: ${ev.reason}` : ''}`);
        return;
      }
      // 4007 (bad seq) / 4009 (session timed out) cannot resume.
      if (ev.code === 4007 || ev.code === 4009) this.sessionId = null;
      this.scheduleReconnect(`gateway closed with ${ev.code}${ev.reason ? `: ${ev.reason}` : ''}`);
    };
  }

  /** Next connection after base * 2^attempts (capped). */
  backoffDelay(): number {
    const base = this.opts.baseDelayMs ?? 1000;
    const max = this.opts.maxDelayMs ?? 60_000;
    return Math.min(max, base * 2 ** Math.min(this.attempts, 20));
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    const delay = this.backoffDelay();
    this.attempts++;
    this.opts.log?.warn({ reason, delay, attempt: this.attempts }, 'Discord gateway reconnecting');
    this.setState('reconnecting', reason);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Drops the socket (no clean close, so the session stays resumable) and reconnects. */
  private reconnect(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    if (socket) {
      socket.onclose = null;
      try {
        socket.close(4000, reason);
      } catch {
        // already closed
      }
    }
    this.scheduleReconnect(reason);
  }

  private send(payload: GatewayPayload): void {
    this.sent.push(payload);
    if (this.sent.length > 200) this.sent.shift();
    this.socket?.send(JSON.stringify(payload));
  }

  private heartbeat(): void {
    if (this.awaitingAck) {
      // Zombied connection: no ACK since the last beat.
      this.reconnect('heartbeat not acknowledged');
      return;
    }
    this.awaitingAck = true;
    this.send({ op: Op.HEARTBEAT, d: this.seq });
  }

  private startHeartbeat(interval: number): void {
    const jitter = (this.opts.random ?? Math.random)();
    this.awaitingAck = false;
    const beat = (delay: number) => {
      this.heartbeatTimer = setTimeout(() => {
        this.heartbeat();
        if (this.socket) beat(interval);
      }, delay);
    };
    beat(Math.floor(interval * jitter));
  }

  private identify(): void {
    this.send({
      op: Op.IDENTIFY,
      d: {
        token: this.opts.token,
        intents: GATEWAY_INTENTS,
        properties: { os: process.platform, browser: 'arclight', device: 'arclight' },
      },
    });
  }

  private onMessage(raw: unknown): void {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')) as GatewayPayload;
    } catch {
      this.opts.log?.warn('unparseable Discord gateway payload');
      return;
    }
    if (typeof payload.s === 'number') this.seq = payload.s;
    switch (payload.op) {
      case Op.HELLO: {
        const interval = (payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 41_250;
        this.startHeartbeat(interval);
        if (this.sessionId) this.send({ op: Op.RESUME, d: { token: this.opts.token, session_id: this.sessionId, seq: this.seq } });
        else this.identify();
        break;
      }
      case Op.HEARTBEAT_ACK:
        this.awaitingAck = false;
        break;
      case Op.HEARTBEAT:
        this.send({ op: Op.HEARTBEAT, d: this.seq });
        break;
      case Op.RECONNECT:
        this.reconnect('gateway asked to reconnect');
        break;
      case Op.INVALID_SESSION:
        if (payload.d !== true) {
          this.sessionId = null;
          this.seq = null;
        }
        this.reconnect('invalid session');
        break;
      case Op.DISPATCH:
        this.onDispatch(payload.t ?? '', payload.d);
        break;
      default:
        break;
    }
  }

  private onDispatch(event: string, data: unknown): void {
    if (event === 'READY') {
      const d = data as { session_id: string; resume_gateway_url?: string; user: { id: string; username: string }; application?: { id: string } };
      this.sessionId = d.session_id;
      this.resumeUrl = d.resume_gateway_url ?? null;
      this.attempts = 0;
      this.lastError = null;
      this.setState('connected');
      this.opts.onReady?.({ sessionId: d.session_id, user: { id: d.user.id, username: d.user.username }, applicationId: d.application?.id ?? d.user.id });
    } else if (event === 'RESUMED') {
      this.attempts = 0;
      this.lastError = null;
      this.setState('connected');
    }
    this.opts.onDispatch?.(event, data);
  }
}
