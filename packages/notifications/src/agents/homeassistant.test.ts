import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE, RENAME } from '../../fixtures/events.js';
import { sampleEvent } from '../samples.js';
import { failingFetch, fakeFetch } from '../test-utils.js';
import { NotificationError } from '../types.js';
import { HomeAssistantAgent, HomeAssistantSettings } from './homeassistant.js';

const TOKEN = 'ha-long-lived-token-xyz';
const base = { baseUrl: 'http://homeassistant.example.com:8123/', accessToken: TOKEN };

describe('HomeAssistantAgent', () => {
  it('calls the notify service with bearer auth, link, image and up to three actions', async () => {
    const http = fakeFetch();
    const agent = new HomeAssistantAgent(HomeAssistantSettings.parse({ ...base, notifyService: 'mobile_app_pixel' }), { fetch: http.fetch });
    const event = sampleEvent('requestCreated', 'Arclight', 'https://arclight.example.com');
    await agent.send(event);

    expect(http.calls).toHaveLength(1);
    const call = http.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('http://homeassistant.example.com:8123/api/services/notify/mobile_app_pixel');
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers['content-type']).toBe('application/json');
    const body = call.json() as { title: string; message: string; data: Record<string, unknown> };
    expect(body.title).toEqual(expect.any(String));
    expect(body.message).toEqual(expect.any(String));
    expect(body.data.url).toBe('https://arclight.example.com/requests/31');
    expect(body.data.clickAction).toBe('https://arclight.example.com/requests/31');
    expect(body.data.image).toEqual(expect.stringMatching(/^https:\/\//));
    expect(body.data.actions).toEqual([
      { action: 'URI', title: 'Approve', uri: 'https://arclight.example.com/requests/31?action=approve' },
      { action: 'URI', title: 'Decline', uri: 'https://arclight.example.com/requests/31?action=decline' },
      { action: 'URI', title: 'View request', uri: 'https://arclight.example.com/requests/31' },
    ]);
  });

  it('accepts a "notify." prefix and omits empty data keys', () => {
    const agent = new HomeAssistantAgent(HomeAssistantSettings.parse({ ...base, notifyService: 'notify.family' }));
    const [request] = agent.buildPayload(HEALTH_ISSUE);
    expect(request!.url).toBe('http://homeassistant.example.com:8123/api/services/notify/family');
    expect((request!.body as { data: object }).data).not.toHaveProperty('actions');
  });

  it('fires an event with the formatted text and the raw event fields', async () => {
    const http = fakeFetch();
    const agent = new HomeAssistantAgent(HomeAssistantSettings.parse({ ...base, mode: 'event', eventType: 'media_event' }), { fetch: http.fetch });
    expect(agent.supportedEvents.has('rename')).toBe(true);
    await agent.send(GRAB);
    const call = http.calls[0]!;
    expect(call.url).toBe('http://homeassistant.example.com:8123/api/events/media_event');
    const body = call.json() as Record<string, unknown>;
    expect(body).toMatchObject({ eventType: 'grab', type: 'grab', downloadId: 'abc123def456', posterUrl: 'https://img.example/poster.jpg' });
    expect(body.title).toContain('Signal Lost');
    expect(body.severity).toEqual(expect.any(String));
  });

  it('in both mode sends notify + event for messages and only the event for rename', async () => {
    const http = fakeFetch();
    const agent = new HomeAssistantAgent(HomeAssistantSettings.parse({ ...base, mode: 'both' }), { fetch: http.fetch });
    await agent.send(GRAB);
    await agent.send(RENAME);
    expect(http.calls.map((c) => c.url)).toEqual([
      'http://homeassistant.example.com:8123/api/services/notify/notify',
      'http://homeassistant.example.com:8123/api/events/arclight_event',
      'http://homeassistant.example.com:8123/api/events/arclight_event',
    ]);
  });

  it('notify mode does not handle rename', async () => {
    const agent = new HomeAssistantAgent(HomeAssistantSettings.parse(base), { fetch: fakeFetch().fetch });
    expect(agent.supportedEvents.has('rename')).toBe(false);
    await expect(agent.send(RENAME)).rejects.toMatchObject({ code: 'unsupportedEvent' });
  });

  it('applies user templates', () => {
    const agent = new HomeAssistantAgent(HomeAssistantSettings.parse({ ...base, mode: 'both' }), {
      templates: { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } },
    });
    const [notify, event] = agent.buildPayload(GRAB);
    expect(notify!.body).toMatchObject({ title: 'T Signal Lost', message: 'B WEBDL-1080p' });
    expect(event!.body).toMatchObject({ title: 'T Signal Lost', body: 'B WEBDL-1080p' });
  });

  it('maps 401 to unauthorized without leaking the token', async () => {
    const http = fakeFetch(() => ({ status: 401, body: '401: Unauthorized' }));
    const agent = new HomeAssistantAgent(HomeAssistantSettings.parse(base), { fetch: http.fetch });
    const error = await agent.send(GRAB).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotificationError);
    expect((error as NotificationError).code).toBe('unauthorized');
    expect((error as NotificationError).message).not.toContain(TOKEN);
  });

  it('maps transport failures to network', async () => {
    const agent = new HomeAssistantAgent(HomeAssistantSettings.parse(base), { fetch: failingFetch() });
    await expect(agent.test()).rejects.toMatchObject({ code: 'network' });
  });

  it('validates settings', () => {
    expect(HomeAssistantSettings.parse(base)).toMatchObject({ mode: 'notify', notifyService: 'notify', eventType: 'arclight_event' });
    expect(HomeAssistantSettings.safeParse({ ...base, baseUrl: 'ftp://ha.example.com' }).success).toBe(false);
    expect(HomeAssistantSettings.safeParse({ ...base, accessToken: '' }).success).toBe(false);
    expect(HomeAssistantSettings.safeParse({ ...base, notifyService: 'Mobile App' }).success).toBe(false);
    expect(HomeAssistantSettings.safeParse({ ...base, eventType: 'a/b' }).success).toBe(false);
    expect(HomeAssistantSettings.safeParse({ ...base, mode: 'sms' }).success).toBe(false);
  });
});
