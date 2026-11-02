import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { fakeFetch } from '../test-utils.js';
import { NotificationError } from '../types.js';
import { NOTIFIARR_PASSTHROUGH_URL, NotifiarrAgent, NotifiarrSettings, SEVERITY_COLORS } from './notifiarr.js';

const API_KEY = 'nfy-api-key-1234';
const CHANNEL = '735481457153277994'; // larger than Number.MAX_SAFE_INTEGER

describe('NotifiarrAgent', () => {
  it('POSTs the passthrough payload with the API key header', async () => {
    const http = fakeFetch(() => ({ status: 200, json: { result: 'success', details: { response: 'Pass through payload processed.' } } }));
    const agent = new NotifiarrAgent(NotifiarrSettings.parse({ apiKey: API_KEY, channelId: CHANNEL }), { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(NOTIFIARR_PASSTHROUGH_URL);
    expect(call.url).not.toContain(API_KEY);
    expect(call.headers['x-api-key']).toBe(API_KEY);
    expect(call.headers['content-type']).toBe('application/json');
    // The snowflake is sent as an exact integer literal.
    expect(call.body).toContain(`"ids":{"channel":${CHANNEL}}`);

    const body = call.json() as { notification: unknown; discord: { color: string; ping: unknown; images: unknown; text: Record<string, unknown> } };
    expect(body.notification).toEqual({ update: false, name: GRAB.instanceName, event: 'grab' });
    expect(body.discord.color).toMatch(/^[0-9A-F]{6}$/);
    expect(body.discord.ping).toEqual({ pingUser: 0, pingRole: 0 });
    expect(body.discord.images).toEqual({ thumbnail: 'https://img.example/poster.jpg', image: '' });
    expect(body.discord.text).toMatchObject({ icon: '', content: '', footer: GRAB.instanceName });
    expect(body.discord.text.title).toContain('Signal Lost');
    const fields = body.discord.text.fields as Array<{ title: string; text: string; inline: boolean }>;
    expect(fields.length).toBeGreaterThan(0);
    expect(fields[0]).toEqual({ title: expect.any(String), text: expect.any(String), inline: expect.any(Boolean) });
  });

  it('colours by severity unless overridden', () => {
    const plain = new NotifiarrAgent(NotifiarrSettings.parse({ apiKey: API_KEY, channelId: CHANNEL }));
    expect(Object.values(SEVERITY_COLORS)).toContain(plain.buildPayload(HEALTH_ISSUE).discord.color);
    expect(plain.buildPayload(HEALTH_ISSUE).discord.color).not.toBe(plain.buildPayload(GRAB).discord.color);
    const custom = new NotifiarrAgent(NotifiarrSettings.parse({ apiKey: API_KEY, channelId: CHANNEL, color: '#3fa9f5' }));
    expect(custom.buildPayload(HEALTH_ISSUE).discord.color).toBe('3FA9F5');
  });

  it('applies user templates', () => {
    const agent = new NotifiarrAgent(NotifiarrSettings.parse({ apiKey: API_KEY, channelId: CHANNEL }), {
      templates: { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } },
    });
    const text = agent.buildPayload(GRAB).discord.text;
    expect(text.title).toBe('T Signal Lost');
    expect(text.description).toBe('B WEBDL-1080p');
  });

  it('maps 401 to unauthorized without leaking the API key', async () => {
    const http = fakeFetch(() => ({ status: 401, body: 'Invalid API key' }));
    const agent = new NotifiarrAgent(NotifiarrSettings.parse({ apiKey: API_KEY, channelId: CHANNEL }), { fetch: http.fetch });
    const error = await agent.send(GRAB).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotificationError);
    expect((error as NotificationError).code).toBe('unauthorized');
    expect((error as NotificationError).message).not.toContain(API_KEY);
  });

  it('treats a 200 with result "error" as a remote error', async () => {
    const http = fakeFetch(() => ({ status: 200, json: { result: 'error', details: { response: 'channel not found' } } }));
    const agent = new NotifiarrAgent(NotifiarrSettings.parse({ apiKey: API_KEY, channelId: CHANNEL }), { fetch: http.fetch });
    await expect(agent.test()).rejects.toMatchObject({ code: 'remoteError', message: expect.stringContaining('channel not found') });
  });

  it('validates settings', () => {
    expect(NotifiarrSettings.safeParse({ apiKey: API_KEY, channelId: CHANNEL }).success).toBe(true);
    expect(NotifiarrSettings.safeParse({ apiKey: '', channelId: CHANNEL }).success).toBe(false);
    expect(NotifiarrSettings.safeParse({ apiKey: API_KEY, channelId: '#general' }).success).toBe(false);
    expect(NotifiarrSettings.safeParse({ apiKey: API_KEY, channelId: CHANNEL, color: 'blue' }).success).toBe(false);
  });
});
