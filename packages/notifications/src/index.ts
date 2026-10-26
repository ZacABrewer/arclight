/**
 * @arclight/notifications: notification agents behind one event model.
 *
 *   const agent = createAgent('discord', storedSettingsJson);
 *   await agent.send(event);
 *
 * Settings are validated with the per-kind Zod schema (`agentSettingsSchemas`), which also
 * drives the settings form in the web UI.
 */

import { z } from 'zod';
import { type AgentDeps } from './agents/base.js';
import { CustomScriptAgent } from './agents/custom-script.js';
import { DiscordAgent } from './agents/discord.js';
import { EmailAgent } from './agents/email.js';
import { GotifyAgent } from './agents/gotify.js';
import { MediaBrowserAgent } from './agents/media-browser.js';
import { NtfyAgent } from './agents/ntfy.js';
import { PlexAgent } from './agents/plex.js';
import { PushoverAgent } from './agents/pushover.js';
import { TelegramAgent } from './agents/telegram.js';
import { WebhookAgent } from './agents/webhook.js';
import { agentSettingsSchemas, type AgentSettingsInputMap, type AgentSettingsMap } from './settings.js';
import { NOTIFICATION_AGENT_KINDS, NotificationError, type NotificationAgent, type NotificationAgentKind } from './types.js';

export * from './types.js';
export * from './settings.js';
export {
  formatEvent,
  formatBytes,
  episodeLabel,
  mediaHeadline,
  mediaLabel,
  mediaLink,
  eventSubject,
  eventSeverity,
  qualityLabel,
  formatDuration,
  timelineTypeLabel,
  EVENT_LABELS,
  requestLinks,
  type FormattedAction,
  type FormattedEvent,
  type FormattedField,
  type Severity,
} from './format.js';
export { eventToEnv, splitArguments, type SpawnLike, type ChildLike } from './agents/custom-script.js';
export { escapeMarkdownV2 } from './agents/telegram.js';
export { DISCORD_COLOURS, type DiscordPayload, type DiscordEmbed } from './agents/discord.js';
export { type WebhookPayload } from './agents/webhook.js';
export { type MediaBrowserUpdate } from './agents/media-browser.js';
export { type PlexSection, pathIsInside } from './agents/plex.js';
export {
  MediaBrowserClient,
  PlexServerClient,
  PlexTvClient,
  PLEX_CLIENT_ID,
  PLEX_TV_URL,
  idsMatch,
  plexGuidIds,
  providerIdsOf,
  type LibraryMatch,
  type MediaBrowserClientOptions,
  type MediaServerAccount,
  type MediaServerAuthResult,
  type MediaServerItem,
  type PlexPinResult,
  type ProviderIds,
  type SeasonPresence,
  type ServerInfo,
} from './media-server.js';
export { type FetchLike } from './http.js';
export { sendMail, connectSmtp, SmtpReplyParser, type SmtpConnect, type SmtpConnection, type SmtpReply } from './smtp.js';
export { type AgentDeps, testEvent, ALL_EVENTS, MESSAGE_EVENTS, LIBRARY_EVENTS } from './agents/base.js';
export { DiscordAgent, TelegramAgent, WebhookAgent, EmailAgent, CustomScriptAgent, NtfyAgent, GotifyAgent, PushoverAgent, MediaBrowserAgent, PlexAgent };

export const NotificationAgentKindSchema = z.enum(NOTIFICATION_AGENT_KINDS);

export function isAgentKind(value: unknown): value is NotificationAgentKind {
  return typeof value === 'string' && (NOTIFICATION_AGENT_KINDS as readonly string[]).includes(value);
}

/**
 * Validate `settings` with the schema for `kind` (applying defaults) or throw a
 * `NotificationError` with code `invalidSettings`.
 */
export function parseAgentSettings<K extends NotificationAgentKind>(kind: K, settings: unknown): AgentSettingsMap[K] {
  const result = agentSettingsSchemas[kind].safeParse(settings);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new NotificationError(kind, 'invalidSettings', `Invalid ${kind} settings: ${issues}`, { cause: result.error });
  }
  return result.data as AgentSettingsMap[K];
}

/**
 * Build an agent from stored settings. `settings` may be the raw JSON the api persisted; it is
 * validated here. Pass `deps` only from tests (fake fetch/socket/spawn).
 */
export function createAgent<K extends NotificationAgentKind>(
  kind: K,
  settings: AgentSettingsInputMap[K] | unknown,
  deps: AgentDeps = {},
): NotificationAgent {
  if (!isAgentKind(kind)) {
    throw new NotificationError('webhook', 'invalidSettings', `Unknown notification agent kind "${String(kind)}"`);
  }
  switch (kind) {
    case 'discord':
      return new DiscordAgent(parseAgentSettings('discord', settings), deps);
    case 'telegram':
      return new TelegramAgent(parseAgentSettings('telegram', settings), deps);
    case 'webhook':
      return new WebhookAgent(parseAgentSettings('webhook', settings), deps);
    case 'email':
      return new EmailAgent(parseAgentSettings('email', settings), deps);
    case 'custom-script':
      return new CustomScriptAgent(parseAgentSettings('custom-script', settings), deps);
    case 'ntfy':
      return new NtfyAgent(parseAgentSettings('ntfy', settings), deps);
    case 'gotify':
      return new GotifyAgent(parseAgentSettings('gotify', settings), deps);
    case 'pushover':
      return new PushoverAgent(parseAgentSettings('pushover', settings), deps);
    case 'jellyfin':
      return new MediaBrowserAgent('jellyfin', parseAgentSettings('jellyfin', settings), deps);
    case 'emby':
      return new MediaBrowserAgent('emby', parseAgentSettings('emby', settings), deps);
    case 'plex':
      return new PlexAgent(parseAgentSettings('plex', settings), deps);
  }
  // Every kind is handled above; TypeScript narrows `kind` to never here.
  throw new NotificationError('webhook', 'invalidSettings', `Unhandled agent kind "${String(kind)}"`);
}
