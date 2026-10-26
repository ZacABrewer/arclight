import { DiscordBotSettings, DiscordBotStatus, DiscordBotTestResult, DiscordLinkCode } from '@arclight/shared';
import { request } from './client.js';

// Paths mirror docs/API.md "## discord-bot" (apps/api/src/modules/discord-bot/routes.ts).

export const discordBotApi = {
  settings: () => request('/settings/discordbot', DiscordBotSettings),
  /** `botToken` sent back as the mask keeps the stored token. */
  update: (body: DiscordBotSettings) => request('/settings/discordbot', DiscordBotSettings, { method: 'PUT', json: body }),
  status: () => request('/discordbot/status', DiscordBotStatus),
  /** Checks the token (and posts a test embed to the request channel) with the unsaved draft. */
  test: (body: DiscordBotSettings) => request('/discordbot/test', DiscordBotTestResult, { method: 'POST', json: body }),
};

/** The signed-in user's own Discord link (Profile). */
export const discordLinkApi = {
  createCode: () => request('/user/me/discord/link-code', DiscordLinkCode, { method: 'POST', json: {} }),
  unlink: () => request('/user/me/discord/link', null, { method: 'DELETE' }),
};
