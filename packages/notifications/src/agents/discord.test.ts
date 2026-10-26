import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE, IMPORT, RENAME, UPGRADE } from '../../fixtures/events.js';
import { createAgent } from '../index.js';
import { fakeFetch } from '../test-utils.js';
import { NotificationError } from '../types.js';
import { DISCORD_COLOURS, DiscordAgent, type DiscordPayload } from './discord.js';

const SETTINGS = { webhookUrl: 'https://discord.com/api/webhooks/1/secret-token', username: 'Arclight', avatarUrl: 'https://mt.example.com/logo.png' };

function agentWith(responder?: Parameters<typeof fakeFetch>[0]) {
  const http = fakeFetch(responder);
  const agent = createAgent('discord', SETTINGS, { fetch: http.fetch });
  return { agent, http };
}

describe('DiscordAgent', () => {
  it('posts a grab embed with the selected fields, poster and colour', async () => {
    const { agent, http } = agentWith();
    await agent.send(GRAB);

    expect(http.calls).toHaveLength(1);
    const call = http.calls[0]!;
    expect(call.url).toBe(SETTINGS.webhookUrl);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');

    const payload = call.json() as DiscordPayload;
    expect(payload.username).toBe('Arclight');
    expect(payload.avatar_url).toBe(SETTINGS.avatarUrl);
    const embed = payload.embeds[0]!;
    expect(embed.title).toBe('Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave');
    expect(embed.description).toBe('Episode Grabbed');
    expect(embed.color).toBe(DISCORD_COLOURS.info);
    expect(embed.url).toBe('https://mt.example.com/series/7');
    expect(embed.thumbnail).toEqual({ url: 'https://img.example/poster.jpg' });
    expect(embed.image).toBeUndefined(); // fanart not in default grab fields
    expect(embed.timestamp).toBe(GRAB.timestamp);
    expect(embed.author).toEqual({ name: 'Arclight', icon_url: SETTINGS.avatarUrl });

    const names = embed.fields.map((f) => f.name);
    expect(names).toEqual(['Overview', 'Quality', 'Group', 'Size', 'Links', 'Release', 'Indexer', 'Custom Formats', 'Custom Format Score']);
    expect(embed.fields.find((f) => f.name === 'Release')?.value).toBe('```Signal.Lost.S02E03E04.1080p.WEB.H264-GRP```');
    expect(embed.fields.find((f) => f.name === 'Links')?.value).toContain('[TMDB](https://www.themoviedb.org/tv/123456)');
    expect(embed.fields.find((f) => f.name === 'Overview')?.value).toBe('Episode overview.');
    expect(embed.fields.find((f) => f.name === 'Size')).toMatchObject({ value: '3.00 GB', inline: true });
  });

  it('honours a custom field selection for grabs', async () => {
    const http = fakeFetch();
    const agent = createAgent('discord', { ...SETTINGS, grabFields: ['fanart', 'quality'] }, { fetch: http.fetch });
    await agent.send(GRAB);
    const embed = (http.calls[0]!.json() as DiscordPayload).embeds[0]!;
    expect(embed.fields.map((f) => f.name)).toEqual(['Quality']);
    expect(embed.thumbnail).toBeUndefined();
    expect(embed.image).toEqual({ url: 'https://img.example/fanart.jpg' });
  });

  it('builds import and upgrade embeds from the file', () => {
    const agent = new DiscordAgent({ ...SETTINGS, grabFields: [], importFields: ['quality', 'codecs', 'size', 'languages', 'subtitles', 'release'], manualInteractionFields: [] });
    const imported = agent.buildPayload(IMPORT).embeds[0]!;
    expect(imported.color).toBe(DISCORD_COLOURS.success);
    expect(imported.description).toBe('Movie Imported');
    expect(imported.fields).toEqual([
      { name: 'Quality', value: 'Bluray-1080p', inline: true },
      { name: 'Codecs', value: 'x264 / DTS 5.1', inline: true },
      { name: 'Size', value: '8.00 GB', inline: true },
      { name: 'Languages', value: 'English', inline: true },
      { name: 'Subtitles', value: 'English, French', inline: true },
      { name: 'Release', value: '```Harbour.Lights.2021.1080p.BluRay.x264-GRP```', inline: false },
    ]);

    const upgraded = agent.buildPayload(UPGRADE).embeds[0]!;
    expect(upgraded.color).toBe(DISCORD_COLOURS.upgrade);
    expect(upgraded.fields.at(-1)).toMatchObject({ name: 'Replaced', value: 'Harbour Lights (2021) WEBDL-720p.mkv (WEBDL-720p)' });
  });

  it('renders health issues in red with source and message', async () => {
    const { agent, http } = agentWith();
    await agent.send(HEALTH_ISSUE);
    const embed = (http.calls[0]!.json() as DiscordPayload).embeds[0]!;
    expect(embed.color).toBe(DISCORD_COLOURS.error);
    expect(embed.title).toBe('Health Issue: Error');
    expect(embed.thumbnail).toBeUndefined();
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        { name: 'Source', value: 'downloadClients', inline: true },
        { name: 'Message', value: 'Unable to communicate with qBittorrent.', inline: false },
      ]),
    );
  });

  it('maps non-2xx responses to error codes without leaking the webhook token', async () => {
    for (const [status, code] of [
      [400, 'remoteError'],
      [401, 'unauthorized'],
      [404, 'notFound'],
      [429, 'rateLimited'],
      [500, 'remoteError'],
    ] as const) {
      const { agent } = agentWith(() => ({ status, body: '{"message":"nope"}' }));
      const error = await agent.send(GRAB).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotificationError);
      expect(error).toMatchObject({ agent: 'discord', code, status });
      expect((error as Error).message).not.toContain('secret-token');
    }
  });

  it('refuses unsupported events and sends a test embed', async () => {
    const { agent, http } = agentWith();
    await expect(agent.send(RENAME)).rejects.toMatchObject({ code: 'unsupportedEvent' });
    expect(agent.supportedEvents.has('rename')).toBe(false);
    await agent.test();
    const embed = (http.calls[0]!.json() as DiscordPayload).embeds[0]!;
    expect(embed.title).toBe('Test Notification');
    expect(embed.fields[0]?.value).toContain('test notification');
  });
});
