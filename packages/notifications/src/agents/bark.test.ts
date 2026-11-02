import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { fakeFetch } from '../test-utils.js';
import { BarkAgent, BarkSettings, type BarkPayload } from './bark.js';

const KEY = 'barkDeviceKey123';
const OK = { status: 200, json: { code: 200, message: 'success' } };
const TEMPLATES = { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } };

describe('BarkAgent', () => {
  it('posts JSON to the default server with poster, link and group', async () => {
    const http = fakeFetch(() => OK);
    const agent = new BarkAgent(BarkSettings.parse({ deviceKey: KEY, sound: 'minuet', level: 'timeSensitive' }), { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe('https://api.day.app/push');
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toContain('application/json');
    expect(call.json()).toEqual({
      device_key: KEY,
      title: 'Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave',
      body: expect.stringContaining('Episode Grabbed\nQuality: WEBDL-1080p'),
      group: 'Arclight',
      url: 'https://mt.example.com/series/7',
      icon: 'https://img.example/poster.jpg',
      image: 'https://img.example/poster.jpg',
      sound: 'minuet',
      level: 'timeSensitive',
    } satisfies BarkPayload);
  });

  it('uses a self-hosted server and icon override, and drops media fields without a poster', async () => {
    const http = fakeFetch(() => OK);
    const agent = new BarkAgent(BarkSettings.parse({ serverUrl: 'https://bark.example.com/', deviceKey: KEY, icon: 'https://example.com/i.png' }), { fetch: http.fetch });
    await agent.send(HEALTH_ISSUE);
    expect(http.calls[0]!.url).toBe('https://bark.example.com/push');
    const payload = http.calls[0]!.json() as BarkPayload;
    expect(payload.icon).toBe('https://example.com/i.png');
    expect(payload.image).toBeUndefined();
    expect(payload.url).toBeUndefined();
    expect(payload.sound).toBeUndefined();
  });

  it('applies templates', () => {
    const payload = new BarkAgent(BarkSettings.parse({ deviceKey: KEY }), { templates: TEMPLATES }).buildPayload(GRAB);
    expect(payload.title).toBe('T Signal Lost');
    expect(payload.body).toBe('B WEBDL-1080p');
  });

  it('maps errors without leaking the device key', async () => {
    const http = fakeFetch(() => ({ status: 400, json: { code: 400, message: 'failed to get device token' } }));
    const agent = new BarkAgent(BarkSettings.parse({ deviceKey: KEY }), { fetch: http.fetch });
    const error = await agent.send(GRAB).then(() => new Error('resolved'), (e: unknown) => e as Error);
    expect(error).toMatchObject({ agent: 'bark', code: 'remoteError', status: 400 });
    expect(error.message).not.toContain(KEY);

    const soft = new BarkAgent(BarkSettings.parse({ deviceKey: KEY }), { fetch: fakeFetch(() => ({ status: 200, json: { code: 500, message: 'push failed' } })).fetch });
    await expect(soft.send(GRAB)).rejects.toMatchObject({ code: 'remoteError', message: 'Bark rejected the message: push failed' });
  });

  it('validates settings', () => {
    expect(BarkSettings.safeParse({}).success).toBe(false);
    expect(BarkSettings.safeParse({ deviceKey: KEY, level: 'loud' }).success).toBe(false);
    expect(BarkSettings.safeParse({ deviceKey: KEY, serverUrl: 'ftp://example.com' }).success).toBe(false);
  });
});
