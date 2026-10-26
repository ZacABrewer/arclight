import { randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  DISCORD_BOT_TOKEN_MASK,
  DiscordBotSettings,
  type DiscordBotStatus,
  type DiscordBotTestResult,
  type DiscordLinkCode,
  type ServerEvent,
} from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { settings, users } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { SYSTEM_ACTOR, type RequestsService } from '../requests/index.js';
import { CommandHandler, EMBED_COLOURS, SLASH_COMMANDS, requestEmbed, type DiscordInteraction, type LinkedUser } from './commands.js';
import { GatewayClient, type GatewayState, type WebSocketCtor } from './gateway.js';
import { DiscordRest, type FetchLike } from './rest.js';

// The Discord bot: settings (stored as the `discordBot` settings row), the gateway client
// and its lifecycle, Discord <-> Arclight account links, and request notifications posted to
// the request channel through the bot's REST API.

export const DISCORD_SETTINGS_KEY = 'discordBot';
export const LINK_CODE_TTL_MS = 10 * 60_000;
/** The DiscordBotDisconnected health check fires after this long without a connection. */
export const DISCONNECTED_GRACE_MS = 2 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class DiscordBotError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'NOT_SIGNED_IN',
    message: string,
  ) {
    super(message);
    this.name = 'DiscordBotError';
  }
}

export interface DiscordBotServiceOptions {
  db: Db;
  bus: EventBus;
  requests: RequestsService;
  log?: Logger;
  webSocket?: WebSocketCtor;
  fetch?: FetchLike;
  gatewayUrl?: string;
  restBaseUrl?: string;
  now?: () => Date;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class DiscordBotService {
  private readonly opts: DiscordBotServiceOptions;
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private gateway: GatewayClient | null = null;
  private rest: DiscordRest | null = null;
  private applicationId: string | null = null;
  private botUser: { id: string; username: string } | null = null;
  private connectedAt: string | null = null;
  private commandsRegistered = false;
  /** Since when the enabled bot has been without a gateway connection (null: connected or disabled). */
  private disconnectedSince: Date | null = null;
  private readonly codes = new Map<string, { userId: number; expiresAt: number }>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private unsubscribe: (() => void) | null = null;
  readonly commands: CommandHandler;

  constructor(opts: DiscordBotServiceOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.commands = new CommandHandler({
      rest: () => this.rest,
      applicationId: () => this.applicationId,
      requests: opts.requests,
      adminRoleId: () => this.stored().adminRoleId,
      linkedUser: (id) => this.linkedUser(id),
      redeemLinkCode: (code, discordUserId) => this.redeem(code, discordUserId),
      ...(opts.log ? { log: opts.log } : {}),
    });
  }

  // -------------------------------------------------------------------------------------
  // settings
  // -------------------------------------------------------------------------------------

  stored(): DiscordBotSettings {
    const row = this.db.select().from(settings).where(eq(settings.key, DISCORD_SETTINGS_KEY)).get();
    const parsed = DiscordBotSettings.safeParse(row?.value ?? {});
    return parsed.success ? parsed.data : DiscordBotSettings.parse({});
  }

  settings(): DiscordBotSettings {
    const s = this.stored();
    return { ...s, botToken: s.botToken ? DISCORD_BOT_TOKEN_MASK : '' };
  }

  /** Saves the settings (the mask keeps the stored token) and restarts the bot. */
  async updateSettings(raw: DiscordBotSettings): Promise<DiscordBotSettings> {
    const parsed = DiscordBotSettings.safeParse(raw);
    if (!parsed.success) throw new DiscordBotError('VALIDATION', parsed.error.message);
    const current = this.stored();
    const next: DiscordBotSettings = {
      ...parsed.data,
      botToken: parsed.data.botToken === DISCORD_BOT_TOKEN_MASK ? current.botToken : parsed.data.botToken.trim(),
    };
    if (next.enabled && !next.botToken) throw new DiscordBotError('VALIDATION', 'a bot token is required to enable the Discord bot');
    const now = this.now().toISOString();
    this.db
      .insert(settings)
      .values({ key: DISCORD_SETTINGS_KEY, value: next, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: now } })
      .run();
    this.opts.bus.publish({ type: 'settings', section: DISCORD_SETTINGS_KEY });
    this.restart();
    return this.settings();
  }

  // -------------------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------------------

  /** Starts the gateway when enabled and subscribes to request events. */
  start(): void {
    if (!this.unsubscribe) this.unsubscribe = this.opts.bus.subscribe((event) => this.onEvent(event));
    this.restart();
  }

  restart(): void {
    this.stopGateway();
    const s = this.stored();
    if (!s.enabled || !s.botToken) {
      this.disconnectedSince = null;
      return;
    }
    this.rest = this.restFor(s.botToken);
    this.disconnectedSince = this.now();
    this.gateway = new GatewayClient({
      token: s.botToken,
      ...(this.opts.webSocket ? { webSocket: this.opts.webSocket } : {}),
      ...(this.opts.gatewayUrl ? { url: this.opts.gatewayUrl } : {}),
      ...(this.log ? { log: this.log } : {}),
      ...(this.opts.baseDelayMs !== undefined ? { baseDelayMs: this.opts.baseDelayMs } : {}),
      ...(this.opts.maxDelayMs !== undefined ? { maxDelayMs: this.opts.maxDelayMs } : {}),
      ...(this.opts.random ? { random: this.opts.random } : {}),
      onReady: (info) => {
        this.applicationId = info.applicationId;
        this.botUser = info.user;
        this.track(this.registerCommands());
      },
      onStateChange: (state) => this.onState(state),
      onDispatch: (event, data) => {
        if (event === 'INTERACTION_CREATE') this.track(this.commands.handle(data as DiscordInteraction));
      },
    });
    this.gateway.start();
  }

  private stopGateway(): void {
    this.gateway?.stop();
    this.gateway = null;
    this.rest = null;
    this.applicationId = null;
    this.botUser = null;
    this.connectedAt = null;
    this.commandsRegistered = false;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopGateway();
    this.disconnectedSince = null;
  }

  private onState(state: GatewayState): void {
    if (state === 'connected') {
      this.connectedAt = this.now().toISOString();
      this.disconnectedSince = null;
    } else if (state !== 'stopped') {
      this.connectedAt = null;
      this.disconnectedSince ??= this.now();
    }
  }

  private restFor(token: string): DiscordRest {
    return new DiscordRest({
      token,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.restBaseUrl ? { baseUrl: this.opts.restBaseUrl } : {}),
      ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
    });
  }

  private async registerCommands(): Promise<void> {
    const rest = this.rest;
    const appId = this.applicationId;
    if (!rest || !appId) return;
    await rest.registerCommands(appId, SLASH_COMMANDS, this.stored().guildId);
    this.commandsRegistered = true;
  }

  /** Background work (interactions, notifications); errors are logged, never thrown. */
  private track(p: Promise<unknown>): void {
    const guarded = p.catch((err: unknown) => this.log?.warn({ err }, 'Discord bot task failed'));
    this.inFlight.add(guarded);
    void guarded.finally(() => this.inFlight.delete(guarded));
  }

  /** Waits for background work (tests). */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** Direct entry for an interaction (the gateway calls this for INTERACTION_CREATE). */
  handleInteraction(interaction: DiscordInteraction): Promise<void> {
    return this.commands.handle(interaction);
  }

  status(): DiscordBotStatus {
    const s = this.stored();
    const g = this.gateway;
    const state: DiscordBotStatus['state'] = !s.enabled || !g ? 'disabled' : g.state === 'idle' || g.state === 'stopped' ? 'connecting' : g.state;
    return {
      enabled: s.enabled,
      state,
      botUser: this.botUser,
      connectedAt: this.connectedAt,
      lastError: g?.lastError ?? null,
      reconnectAttempts: g?.attempts ?? 0,
      commandsRegistered: this.commandsRegistered,
      linkedUsers: this.linkedCount(),
    };
  }

  /** Health: a problem message when the enabled bot has been disconnected too long, else null. */
  healthProblem(): string | null {
    const s = this.stored();
    if (!s.enabled || !this.gateway) return null;
    if (this.gateway.state === 'error') return `The Discord bot cannot connect: ${this.gateway.lastError ?? 'unknown error'}`;
    if (this.disconnectedSince && this.now().getTime() - this.disconnectedSince.getTime() >= DISCONNECTED_GRACE_MS) {
      return `The Discord bot has been disconnected since ${this.disconnectedSince.toISOString()}${this.gateway.lastError ? ` (${this.gateway.lastError})` : ''}`;
    }
    return null;
  }

  /** Checks the token (stored, or the given settings) and posts a test message to the request channel. */
  async test(raw?: DiscordBotSettings): Promise<DiscordBotTestResult> {
    const stored = this.stored();
    const s = raw ? { ...DiscordBotSettings.parse(raw) } : stored;
    const token = s.botToken === DISCORD_BOT_TOKEN_MASK || !s.botToken ? stored.botToken : s.botToken;
    if (!token) return { ok: false, message: 'no bot token is configured' };
    const rest = this.restFor(token);
    try {
      const me = await rest.me();
      if (s.requestChannelId) {
        await rest.sendMessage(s.requestChannelId, {
          embeds: [{ title: 'Arclight test', description: 'The Discord bot can post to this channel.', color: EMBED_COLOURS.success }],
        });
      }
      return { ok: true, botUser: { id: me.id, username: me.username } };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // -------------------------------------------------------------------------------------
  // account links
  // -------------------------------------------------------------------------------------

  /** A fresh single-use code for `/link <code>`; earlier codes of the user stop working. */
  createLinkCode(userId: number): DiscordLinkCode {
    const now = this.now().getTime();
    for (const [code, entry] of this.codes) if (entry.userId === userId || entry.expiresAt <= now) this.codes.delete(code);
    let code = '';
    do {
      code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.codes.has(code));
    const expiresAt = now + LINK_CODE_TTL_MS;
    this.codes.set(code, { userId, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString(), linkedDiscordUserId: this.discordIdOf(userId) };
  }

  private redeem(code: string, discordUserId: string): string | null {
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    if (entry.expiresAt <= this.now().getTime()) return null;
    const row = this.db.select().from(users).where(eq(users.id, entry.userId)).get();
    if (!row) return null;
    // One Arclight user per Discord account: an older link moves to the new user.
    for (const other of this.linkedRows(discordUserId)) if (other.id !== row.id) this.setDiscordId(other.id, null);
    this.setDiscordId(row.id, discordUserId);
    return row.displayName ?? row.username;
  }

  unlink(userId: number): void {
    this.setDiscordId(userId, null);
  }

  discordIdOf(userId: number): string | null {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    const value = (row?.settings as Record<string, unknown> | undefined)?.['discordUserId'];
    return typeof value === 'string' ? value : null;
  }

  private setDiscordId(userId: number, discordUserId: string | null): void {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) return;
    const next: Record<string, unknown> = { ...((row.settings ?? {}) as Record<string, unknown>) };
    if (discordUserId === null) delete next['discordUserId'];
    else next['discordUserId'] = discordUserId;
    this.db.update(users).set({ settings: next, updatedAt: this.now().toISOString() }).where(eq(users.id, userId)).run();
  }

  private linkedRows(discordUserId: string) {
    return this.db
      .select()
      .from(users)
      .where(sql`json_extract(${users.settings}, '$.discordUserId') = ${discordUserId}`)
      .all();
  }

  linkedUser(discordUserId: string): LinkedUser | undefined {
    const row = this.linkedRows(discordUserId)[0];
    return row ? { id: row.id, username: row.username, role: row.role, permissions: row.permissions } : undefined;
  }

  private linkedCount(): number {
    return this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`json_extract(${users.settings}, '$.discordUserId') is not null`)
      .all().length;
  }

  // -------------------------------------------------------------------------------------
  // channel notifications
  // -------------------------------------------------------------------------------------

  private onEvent(event: ServerEvent): void {
    if (event.type !== 'request') return;
    if (event.action !== 'created' && event.action !== 'approved' && event.action !== 'completed') return;
    const s = this.stored();
    if (!s.enabled || !s.requestChannelId || !this.rest) return;
    this.track(this.postRequest(s.requestChannelId, event.action, event.id));
  }

  private async postRequest(channelId: string, action: 'created' | 'approved' | 'completed', id: number): Promise<void> {
    const rest = this.rest;
    if (!rest) return;
    const r = this.opts.requests.get(SYSTEM_ACTOR, id);
    const heading = action === 'created' ? 'New request' : action === 'approved' ? 'Request approved' : 'Now available';
    const colour = action === 'created' ? EMBED_COLOURS.info : action === 'approved' ? EMBED_COLOURS.success : EMBED_COLOURS.success;
    await rest.sendMessage(channelId, { embeds: [requestEmbed(r, heading, colour)] });
  }
}
