import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DISCORD_BOT_TOKEN_MASK, DiscordBotSettings, DiscordBotStatus } from '@arclight/shared';
import { renderAt, stubApi } from '../../../features/requests/test-utils.js';
import { discordBotErrors, discordStateTone, discordStatusItems, snowflakeError, toDiscordBotBody } from './discord-bot-page.js';

afterEach(() => vi.unstubAllGlobals());

const settings = DiscordBotSettings.parse({ enabled: true, botToken: DISCORD_BOT_TOKEN_MASK, guildId: '123456789012345678', requestChannelId: null, adminRoleId: null });
const status = DiscordBotStatus.parse({
  enabled: true,
  state: 'connected',
  botUser: { id: '555555555555', username: 'Arclight' },
  connectedAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastError: null,
  reconnectAttempts: 2,
  commandsRegistered: true,
  linkedUsers: 3,
});

describe('discord bot helpers', () => {
  it('validates snowflakes, builds the body and flags a missing token', () => {
    expect(snowflakeError(null)).toBeNull();
    expect(snowflakeError(' 123456 ')).toBeNull();
    expect(snowflakeError('abc')).toBe('Use the numeric Discord id (5 to 25 digits).');
    expect(toDiscordBotBody({ ...settings, requestChannelId: '  ', adminRoleId: ' 22222 ' })).toEqual({ ...settings, requestChannelId: null, adminRoleId: '22222' });
    expect(discordBotErrors({ ...settings, botToken: '' })).toEqual(['Enter the bot token to run the bot.']);
    expect(discordBotErrors({ ...settings, enabled: false, botToken: '' })).toEqual([]);
    expect(discordStateTone('error')).toBe('danger');
    expect(discordStateTone('reconnecting')).toBe('warn');
    const items = discordStatusItems({ ...status, lastError: 'close 4004' });
    expect(items.map((i) => i.value)).toContain('Arclight · 555555555555');
    expect(items.at(-1)).toMatchObject({ value: 'close 4004' });
  });
});

describe('settings → discord bot', () => {
  it('shows the polled status and sends the masked token back on save', async () => {
    const calls = stubApi({ '/api/v1/settings/discordbot': settings, '/api/v1/discordbot/status': status }, (url, method, body) =>
      method === 'PUT' && url === '/api/v1/settings/discordbot' ? { body } : undefined,
    );
    renderAt('/settings/discordbot');
    const pane = await screen.findByRole('region', { name: 'Live status' });
    expect(await within(pane).findByText('Connected')).toBeTruthy();
    expect(within(pane).getByText('Arclight · 555555555555')).toBeTruthy();
    expect(within(pane).getByText('Registered')).toBeTruthy();
    expect(within(pane).getByText('3')).toBeTruthy();

    const token = screen.getByLabelText('Bot token') as HTMLInputElement;
    expect(token.value).toBe(DISCORD_BOT_TOKEN_MASK);
    expect(screen.getByText('A token is stored. Leave it as is to keep it.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Request channel id'), { target: { value: '987654321098765432' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(DiscordBotSettings.parse(calls.find((c) => c.method === 'PUT')?.body)).toEqual({ ...settings, requestChannelId: '987654321098765432' });
  });

  it('tests the unsaved draft and blocks saving an invalid id', async () => {
    const calls = stubApi({ '/api/v1/settings/discordbot': settings, '/api/v1/discordbot/status': { ...status, state: 'error', botUser: null, lastError: 'Authentication failed' } }, (url, method) =>
      method === 'POST' && url === '/api/v1/discordbot/test' ? { body: { ok: false, message: '401: Unauthorized' } } : undefined,
    );
    renderAt('/settings/discordbot');
    const pane = await screen.findByRole('region', { name: 'Live status' });
    expect(await within(pane).findByText('Stopped · error')).toBeTruthy();
    expect(within(pane).getByText('Authentication failed')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: 'new-token' } });
    fireEvent.change(screen.getByLabelText('Admin role id'), { target: { value: 'admins' } });
    expect(screen.getByText('Use the numeric Discord id (5 to 25 digits).')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const result = await screen.findByRole('region', { name: 'Test result' });
    expect(await within(result).findByText('Token rejected')).toBeTruthy();
    expect(within(result).getByText('401: Unauthorized')).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/discordbot/test')?.body).toEqual({ ...settings, botToken: 'new-token', adminRoleId: 'admins' });
  });
});
