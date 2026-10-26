/**
 * Zod settings schemas, one per agent kind. The api stores settings as JSON validated by these;
 * the web renders a form from them, so every field carries a `.describe()` the UI can show as
 * help text. Defaults here are what a fresh form starts with.
 */

import { z } from 'zod';
import { NOTIFICATION_AGENT_KINDS } from './types.js';

const httpUrl = () => z.url({ protocol: /^https?$/ });

export const DISCORD_FIELDS = [
  'overview',
  'rating',
  'genres',
  'quality',
  'codecs',
  'group',
  'size',
  'languages',
  'subtitles',
  'links',
  'release',
  'poster',
  'fanart',
  'indexer',
  'customFormats',
  'customFormatScore',
] as const;
export const DiscordField = z.enum(DISCORD_FIELDS);
export type DiscordField = z.infer<typeof DiscordField>;

export const DiscordSettings = z.object({
  webhookUrl: httpUrl().describe('Discord channel webhook URL (Channel settings > Integrations > Webhooks).'),
  username: z.string().max(80).optional().describe('Override the webhook bot name. Leave blank for the webhook default.'),
  avatarUrl: httpUrl().optional().describe('Override the webhook avatar image URL.'),
  author: z.string().max(256).optional().describe('Embed author line. Defaults to the instance name.'),
  grabFields: z
    .array(DiscordField)
    .default(['overview', 'quality', 'group', 'size', 'links', 'release', 'poster', 'indexer', 'customFormats', 'customFormatScore'])
    .describe('Fields shown on grab embeds.'),
  importFields: z
    .array(DiscordField)
    .default(['overview', 'quality', 'codecs', 'group', 'size', 'languages', 'subtitles', 'links', 'release', 'poster', 'customFormats'])
    .describe('Fields shown on import/upgrade embeds.'),
  manualInteractionFields: z
    .array(DiscordField)
    .default(['overview', 'quality', 'group', 'size', 'links', 'poster'])
    .describe('Fields shown on manual-interaction embeds.'),
});
export type DiscordSettings = z.infer<typeof DiscordSettings>;

export const TelegramSettings = z.object({
  botToken: z.string().min(1).describe('Bot token from @BotFather.'),
  chatId: z.string().min(1).describe('Chat, group or channel id (negative for groups). Use @userinfobot to find it.'),
  topicId: z
    .number()
    .int()
    .gt(1)
    .optional()
    .describe('Message thread (topic) id inside a forum group. Leave blank for the general topic.'),
  sendSilently: z.boolean().default(false).describe('Deliver without a notification sound.'),
  includeLink: z.boolean().default(true).describe('Append a link to the series/movie page.'),
});
export type TelegramSettings = z.infer<typeof TelegramSettings>;

export const WebhookSettings = z.object({
  url: httpUrl().describe('Endpoint that receives the JSON event.'),
  method: z.enum(['POST', 'PUT']).default('POST').describe('HTTP method.'),
  username: z.string().optional().describe('HTTP basic auth username.'),
  password: z.string().optional().describe('HTTP basic auth password.'),
  headers: z.record(z.string(), z.string()).default({}).describe('Extra request headers, e.g. an API key.'),
});
export type WebhookSettings = z.infer<typeof WebhookSettings>;

export const EmailSettings = z.object({
  host: z.string().min(1).describe('SMTP server hostname.'),
  port: z.number().int().min(1).max(65535).default(587).describe('SMTP port: 587 for STARTTLS, 465 for implicit TLS, 25 for plain.'),
  security: z
    .enum(['none', 'starttls', 'tls'])
    .default('starttls')
    .describe('none: plaintext; starttls: upgrade after connecting; tls: encrypted from the first byte.'),
  username: z.string().optional().describe('SMTP username. Leave blank for no authentication.'),
  password: z.string().optional().describe('SMTP password.'),
  from: z.email().describe('Sender address.'),
  to: z.array(z.email()).min(1).describe('Recipients.'),
  cc: z.array(z.email()).default([]).describe('CC recipients.'),
  bcc: z.array(z.email()).default([]).describe('BCC recipients.'),
  subjectPrefix: z.string().max(100).default('[Media-Tron]').describe('Prepended to every subject line.'),
});
export type EmailSettings = z.infer<typeof EmailSettings>;

export const CustomScriptSettings = z.object({
  path: z.string().min(1).describe('Absolute path of the script or executable to run.'),
  arguments: z.string().default('').describe('Extra command-line arguments, split on whitespace (quote with "...").'),
  timeoutMs: z.number().int().min(1000).max(3_600_000).default(60_000).describe('Kill the script after this many milliseconds.'),
});
export type CustomScriptSettings = z.infer<typeof CustomScriptSettings>;

export const NtfySettings = z.object({
  serverUrl: httpUrl().default('https://ntfy.sh').describe('ntfy server URL.'),
  topics: z.array(z.string().min(1).max(64)).min(1).describe('Topics to publish to.'),
  priority: z.number().int().min(1).max(5).default(3).describe('1 = min, 3 = default, 5 = max (urgent).'),
  tags: z.array(z.string()).default([]).describe('Tags/emoji shortcodes attached to every message.'),
  clickUrl: httpUrl().optional().describe('URL opened when the notification is tapped. Defaults to the media link.'),
  accessToken: z.string().optional().describe('Access token (preferred over username/password).'),
  username: z.string().optional().describe('Basic auth username when the server requires it.'),
  password: z.string().optional().describe('Basic auth password.'),
});
export type NtfySettings = z.infer<typeof NtfySettings>;

export const GotifySettings = z.object({
  serverUrl: httpUrl().describe('Gotify server URL.'),
  appToken: z.string().min(1).describe('Application token from the Gotify "Apps" page.'),
  priority: z.number().int().min(0).max(10).default(5).describe('0-10; Android shows a sound/vibration from 5 upward.'),
  markdown: z.boolean().default(true).describe('Render the message as Markdown.'),
});
export type GotifySettings = z.infer<typeof GotifySettings>;

export const PushoverSettings = z.object({
  apiToken: z.string().length(30).describe('Application API token.'),
  userKey: z.string().length(30).describe('User or group key.'),
  devices: z.array(z.string()).default([]).describe('Device names to target. Empty sends to all devices.'),
  priority: z.number().int().min(-2).max(2).default(0).describe('-2 silent, -1 quiet, 0 normal, 1 high, 2 emergency.'),
  retry: z.number().int().min(30).default(60).describe('Emergency only: seconds between retries.'),
  expire: z.number().int().max(10_800).default(3600).describe('Emergency only: seconds until retries stop.'),
  sound: z.string().optional().describe('Notification sound name. Leave blank for the device default.'),
});
export type PushoverSettings = z.infer<typeof PushoverSettings>;

const mediaServerBase = {
  host: z.string().min(1).describe('Hostname or IP of the media server.'),
  port: z.number().int().min(1).max(65535).default(8096).describe('Port.'),
  useSsl: z.boolean().default(false).describe('Connect over HTTPS.'),
  urlBase: z.string().optional().describe('URL base when the server is behind a reverse proxy sub-path.'),
  apiKey: z.string().min(1).describe('API key (Dashboard > API Keys).'),
  updateLibrary: z.boolean().default(true).describe('Tell the server which folder changed so it rescans only that.'),
};

export const JellyfinSettings = z.object(mediaServerBase);
export type JellyfinSettings = z.infer<typeof JellyfinSettings>;

export const EmbySettings = z.object({
  ...mediaServerBase,
  notify: z.boolean().default(false).describe('Also show a notification in Emby for grabs/imports.'),
});
export type EmbySettings = z.infer<typeof EmbySettings>;

export const PlexSettings = z.object({
  host: z.string().min(1).describe('Hostname or IP of the Plex Media Server.'),
  port: z.number().int().min(1).max(65535).default(32400).describe('Port.'),
  useSsl: z.boolean().default(false).describe('Connect over HTTPS.'),
  authToken: z.string().min(1).describe('X-Plex-Token for the server owner.'),
  updateLibrary: z.boolean().default(true).describe('Refresh the library section containing the changed folder.'),
});
export type PlexSettings = z.infer<typeof PlexSettings>;

export const agentSettingsSchemas = {
  discord: DiscordSettings,
  telegram: TelegramSettings,
  webhook: WebhookSettings,
  email: EmailSettings,
  'custom-script': CustomScriptSettings,
  ntfy: NtfySettings,
  gotify: GotifySettings,
  pushover: PushoverSettings,
  jellyfin: JellyfinSettings,
  emby: EmbySettings,
  plex: PlexSettings,
} as const satisfies Record<(typeof NOTIFICATION_AGENT_KINDS)[number], z.ZodType>;

export type AgentSettingsMap = {
  [K in keyof typeof agentSettingsSchemas]: z.infer<(typeof agentSettingsSchemas)[K]>;
};
export type AgentSettingsInputMap = {
  [K in keyof typeof agentSettingsSchemas]: z.input<(typeof agentSettingsSchemas)[K]>;
};
