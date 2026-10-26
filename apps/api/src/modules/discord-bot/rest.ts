// Minimal Discord REST client (API v10): bot identity, slash-command registration,
// interaction responses and channel messages. Authenticated with the bot token, so channel
// posts come from the bot user rather than a webhook.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DISCORD_API = 'https://discord.com/api/v10';

export class DiscordRestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DiscordRestError';
  }
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  thumbnail?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordButton {
  type: 2;
  /** 1 primary, 2 secondary, 3 success, 4 danger. */
  style: 1 | 2 | 3 | 4;
  label: string;
  custom_id: string;
  disabled?: boolean;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButton[];
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
  /** 64: ephemeral. */
  flags?: number;
}

export interface SlashCommandOption {
  /** 3 string, 4 integer, 5 boolean. */
  type: 3 | 4 | 5;
  name: string;
  description: string;
  required?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  options?: SlashCommandOption[];
}

export interface DiscordRestOptions {
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Waits for a 429's retry_after (tests shorten it). */
  sleep?: (ms: number) => Promise<void>;
}

export class DiscordRest {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: DiscordRestOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (opts.baseUrl ?? DISCORD_API).replace(/\/+$/, '');
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One call; a 429 is retried once after `retry_after`. */
  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          'User-Agent': 'DiscordBot (https://github.com/arclight, 1.0) Arclight',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      };
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      if (res.status === 429 && attempt === 0) {
        const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
        const header = Number(res.headers.get('retry-after'));
        const seconds = typeof data.retry_after === 'number' ? data.retry_after : Number.isFinite(header) ? header : 1;
        await this.sleep(Math.min(Math.max(seconds, 0), 30) * 1000);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message = `Discord ${method} ${path} failed with HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { message?: string };
          if (parsed.message) message += `: ${parsed.message}`;
        } catch {
          // not JSON; keep the status-only message
        }
        throw new DiscordRestError(res.status, message);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  me(): Promise<DiscordUser> {
    return this.call<DiscordUser>('GET', '/users/@me');
  }

  /** Bulk overwrite: guild commands appear at once, global ones may take a while. */
  registerCommands(applicationId: string, commands: SlashCommand[], guildId: string | null): Promise<unknown> {
    const path = guildId ? `/applications/${applicationId}/guilds/${guildId}/commands` : `/applications/${applicationId}/commands`;
    return this.call('PUT', path, commands);
  }

  /** Interaction callback (type 4 message, 5 deferred message, 6 deferred update, 7 update). */
  interactionCallback(interactionId: string, token: string, type: 4 | 5 | 6 | 7, data?: DiscordMessage): Promise<unknown> {
    return this.call('POST', `/interactions/${interactionId}/${token}/callback`, data === undefined ? { type } : { type, data });
  }

  /** Replaces the original response of a (deferred) interaction. */
  editOriginal(applicationId: string, token: string, message: DiscordMessage): Promise<unknown> {
    return this.call('PATCH', `/webhooks/${applicationId}/${token}/messages/@original`, message);
  }

  sendMessage(channelId: string, message: DiscordMessage): Promise<unknown> {
    return this.call('POST', `/channels/${channelId}/messages`, message);
  }
}
