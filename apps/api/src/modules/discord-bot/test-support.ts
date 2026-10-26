import { DiscordBotSettings } from '@arclight/shared';
import { settings } from '../../db/schema.js';
import type { Db } from '../../db/index.js';
import { setup, type Harness } from '../requests/test-support.js';
import type { GatewayPayload, GatewaySocket, WebSocketCtor } from './gateway.js';
import type { DiscordInteraction } from './commands.js';
import { DiscordBotService, DISCORD_SETTINGS_KEY } from './service.js';

// Test-only fakes: an in-process Discord gateway (sockets driven by the test), a recording
// REST fetch, and a harness wiring the bot to the requests test harness.

export class FakeSocket implements GatewaySocket {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly received: GatewayPayload[] = [];
  closedWith: number | undefined | null = null;

  constructor(
    readonly url: string,
    private readonly server: FakeGateway,
  ) {}

  send(data: string): void {
    const payload = JSON.parse(data) as GatewayPayload;
    this.received.push(payload);
    this.server.onClientPayload(this, payload);
  }

  close(code?: number): void {
    this.closedWith = code;
  }

  /** Server -> client. */
  push(payload: GatewayPayload): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** The server drops the connection. */
  drop(code = 1006, reason = ''): void {
    this.onclose?.({ code, reason });
  }

  ops(op: number): GatewayPayload[] {
    return this.received.filter((p) => p.op === op);
  }
}

export class FakeGateway {
  readonly sockets: FakeSocket[] = [];
  heartbeatInterval = 40;
  ackHeartbeats = true;
  autoReady = true;
  seq = 0;
  readonly sessionId = 'session-1';
  readonly resumeUrl = 'wss://resume.test';
  readonly ctor: WebSocketCtor;

  constructor() {
    const server = this;
    this.ctor = class {
      constructor(url: string) {
        const socket = new FakeSocket(url, server);
        server.sockets.push(socket);
        // The client sets its handlers right after construction.
        queueMicrotask(() => socket.push({ op: 10, d: { heartbeat_interval: server.heartbeatInterval } }));
        return socket;
      }
    } as unknown as WebSocketCtor;
  }

  get last(): FakeSocket {
    return this.sockets[this.sockets.length - 1]!;
  }

  dispatch(socket: FakeSocket, t: string, d: unknown): void {
    socket.push({ op: 0, t, s: ++this.seq, d });
  }

  onClientPayload(socket: FakeSocket, payload: GatewayPayload): void {
    if (payload.op === 1 && this.ackHeartbeats) queueMicrotask(() => socket.push({ op: 11 }));
    if (payload.op === 2 && this.autoReady) {
      queueMicrotask(() =>
        this.dispatch(socket, 'READY', {
          session_id: this.sessionId,
          resume_gateway_url: this.resumeUrl,
          user: { id: '900', username: 'arclight-bot' },
          application: { id: 'app-1' },
        }),
      );
    }
    if (payload.op === 6) queueMicrotask(() => this.dispatch(socket, 'RESUMED', {}));
  }
}

export interface RestCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export function fakeRest() {
  const calls: RestCall[] = [];
  const overrides: ((call: RestCall) => Response | undefined)[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const path = input.replace('https://discord.com/api/v10', '');
    const call: RestCall = {
      method: init?.method ?? 'GET',
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    for (const o of overrides) {
      const res = o(call);
      if (res) return res;
    }
    if (path === '/users/@me') return Response.json({ id: '900', username: 'arclight-bot' });
    if (call.method === 'POST' && path.endsWith('/callback')) return new Response(null, { status: 204 });
    return Response.json({});
  };
  const find = (method: string, pattern: RegExp) => calls.filter((c) => c.method === method && pattern.test(c.path));
  return { fetch, calls, overrides, find };
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function saveSettings(db: Db, value: Partial<DiscordBotSettings>): void {
  const v = DiscordBotSettings.parse({ enabled: true, botToken: 'bot-token', guildId: '11111', requestChannelId: '22222', adminRoleId: '33333', ...value });
  db.insert(settings)
    .values({ key: DISCORD_SETTINGS_KEY, value: v, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value: v } })
    .run();
}

export interface BotHarness extends Harness {
  gateway: FakeGateway;
  rest: ReturnType<typeof fakeRest>;
  bot: DiscordBotService;
  clock: { now: Date };
}

export async function botHarness(opts: { settings?: Partial<DiscordBotSettings>; start?: boolean } = {}): Promise<BotHarness> {
  const h = await setup();
  const gateway = new FakeGateway();
  const rest = fakeRest();
  const clock = { now: new Date('2026-06-01T12:00:00Z') };
  saveSettings(h.db, opts.settings ?? {});
  const bot = new DiscordBotService({
    db: h.db,
    bus: h.ctx.bus,
    requests: h.services.requests,
    webSocket: gateway.ctor,
    fetch: rest.fetch,
    now: () => clock.now,
    baseDelayMs: 5,
    maxDelayMs: 40,
    random: () => 0,
    sleep: async () => {},
  });
  if (opts.start !== false) {
    bot.start();
    await waitFor(() => bot.status().state === 'connected' && bot.status().commandsRegistered);
  }
  return { ...h, gateway, rest, bot, clock };
}

let counter = 0;

export function interaction(
  kind: { command: string; options?: Record<string, unknown> } | { button: string },
  discordUserId: string,
  roles: string[] = [],
): DiscordInteraction {
  counter++;
  return {
    id: `int-${counter}`,
    token: `tok-${counter}`,
    type: 'command' in kind ? 2 : 3,
    guild_id: '11111',
    data:
      'command' in kind
        ? { name: kind.command, options: Object.entries(kind.options ?? {}).map(([name, value]) => ({ name, value })) }
        : { custom_id: kind.button },
    member: { user: { id: discordUserId, username: `discord-${discordUserId}` }, roles },
  };
}

/** The bot's final answer to an interaction: the body of the PATCH of the original response. */
export function replyTo(rest: ReturnType<typeof fakeRest>, i: DiscordInteraction): { content?: string; embeds?: { title?: string; description?: string; fields?: { name: string; value: string }[] }[]; components?: { components: { label: string; custom_id: string }[] }[] } {
  const call = rest.calls.filter((c) => c.method === 'PATCH' && c.path === `/webhooks/app-1/${i.token}/messages/@original`).pop();
  if (!call) throw new Error(`no reply to ${i.id}`);
  return call.body as ReturnType<typeof replyTo>;
}
