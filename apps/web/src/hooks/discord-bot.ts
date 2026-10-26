import { useMutation, useQuery } from '@tanstack/react-query';
import type { DiscordBotSettings } from '@arclight/shared';
import { discordBotApi, discordLinkApi } from '../api/discord-bot.js';
import { authKeys } from '../auth/guard.js';
import { useInvalidatingMutation } from './settings-keys.js';
import { t } from '../i18n/index.js';

// Settings live under ['settings'] (a `settings` event refreshes them); the status pane polls.
export const discordBotKeys = {
  settings: ['settings', 'discordbot'] as const,
  status: ['discordbot', 'status'] as const,
};

/** How often the status pane re-reads GET /discordbot/status. */
export const DISCORD_STATUS_POLL_MS = 5000;

export function useDiscordBotSettings() {
  return useQuery({ queryKey: discordBotKeys.settings, queryFn: discordBotApi.settings, retry: false });
}

export function useDiscordBotStatus(pollMs: number | false = DISCORD_STATUS_POLL_MS) {
  return useQuery({ queryKey: discordBotKeys.status, queryFn: discordBotApi.status, retry: false, refetchInterval: pollMs });
}

export function useSaveDiscordBotSettings() {
  return useInvalidatingMutation((body: DiscordBotSettings) => discordBotApi.update(body), [discordBotKeys.settings, discordBotKeys.status], {
    errorTitle: t('settings.discordBot.couldNotSave'),
  });
}

/** Probe the draft; the result is shown inline, not cached. */
export function useTestDiscordBot() {
  return useMutation({ mutationFn: (body: DiscordBotSettings) => discordBotApi.test(body), meta: { silent: true } });
}

export function useCreateDiscordLinkCode() {
  return useMutation({ mutationFn: () => discordLinkApi.createCode(), meta: { silent: true } });
}

/** Removing the link changes `settings.discordUserId` on the signed-in user. */
export function useUnlinkDiscord() {
  return useInvalidatingMutation(() => discordLinkApi.unlink(), [authKeys.me, authKeys.status], { silent: true });
}
