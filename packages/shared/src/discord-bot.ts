import { z } from 'zod';

// Discord bot (gateway + slash commands): settings, status and account links.
// Behaviour: docs/API.md "discord-bot".

const Snowflake = z.string().regex(/^\d{5,25}$/, 'a Discord id (digits)');

/** Placeholder returned for the stored bot token; sending it back keeps the stored value. */
export const DISCORD_BOT_TOKEN_MASK = '********';

/** GET/PUT /settings/discordbot (stored in the `discordBot` settings row; botToken masked on read). */
export const DiscordBotSettings = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().max(200).default(''),
  /** Slash commands are registered on this guild (instant) instead of globally. */
  guildId: Snowflake.nullable().default(null),
  /** Request created/approved/available embeds are posted here; null: no channel posts. */
  requestChannelId: Snowflake.nullable().default(null),
  /** Members with this role may use /pending and its approve/decline buttons. */
  adminRoleId: Snowflake.nullable().default(null),
});
export type DiscordBotSettings = z.infer<typeof DiscordBotSettings>;

export const DiscordBotState = z.enum(['disabled', 'connecting', 'connected', 'reconnecting', 'error']);
export type DiscordBotState = z.infer<typeof DiscordBotState>;

/** GET /discordbot/status. */
export const DiscordBotStatus = z.object({
  enabled: z.boolean(),
  state: DiscordBotState,
  botUser: z.object({ id: z.string(), username: z.string() }).nullable(),
  connectedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  reconnectAttempts: z.number().int(),
  commandsRegistered: z.boolean(),
  linkedUsers: z.number().int(),
});
export type DiscordBotStatus = z.infer<typeof DiscordBotStatus>;

/** POST /discordbot/test: checks the token against the REST API (and posts to the channel when set). */
export const DiscordBotTestResult = z.object({
  ok: z.boolean(),
  botUser: z.object({ id: z.string(), username: z.string() }).optional(),
  message: z.string().optional(),
});
export type DiscordBotTestResult = z.infer<typeof DiscordBotTestResult>;

/** POST /user/me/discord/link-code: a one-time code for `/link <code>` in Discord. */
export const DiscordLinkCode = z.object({
  code: z.string(),
  expiresAt: z.string(),
  /** Discord user id the caller is linked to already, if any. */
  linkedDiscordUserId: z.string().nullable(),
});
export type DiscordLinkCode = z.infer<typeof DiscordLinkCode>;
