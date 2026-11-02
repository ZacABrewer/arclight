import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { fakeFetch } from '../test-utils.js';
import { SIMPLEPUSH_URL, SimplePushAgent, SimplePushSettings } from './simplepush.js';

const KEY = 'HuxgBB';
const OK = { status: 200, json: { status: 'OK' } };
const TEMPLATES = { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } };

describe('SimplePushAgent', () => {
  it('posts a form with key, title, msg and event', async () => {
    const http = fakeFetch(() => OK);
    const agent = new SimplePushAgent(SimplePushSettings.parse({ apiKey: KEY, event: 'media' }), { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe(SIMPLEPUSH_URL);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.body);
    expect(form.get('key')).toBe(KEY);
    expect(form.get('event')).toBe('media');
    expect(form.get('title')).toBe('Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave');
    expect(form.get('msg')).toContain('Episode Grabbed\nQuality: WEBDL-1080p');
    expect(form.get('msg')!.endsWith('\nhttps://mt.example.com/series/7')).toBe(true);
    expect(form.get('msg')!.split('https://mt.example.com/series/7')).toHaveLength(2);
  });

  it('omits the event and link when absent, and applies templates', () => {
    const form = new SimplePushAgent(SimplePushSettings.parse({ apiKey: KEY })).buildForm(HEALTH_ISSUE);
    expect(form.event).toBeUndefined();
    expect(form.msg).toBe(
      'Health Issue: Error\nSource: downloadClients\nLevel: error\nMessage: Unable to communicate with qBittorrent.\nMore Info: https://mt.example.com/wiki/health#download-clients',
    );

    const templated = new SimplePushAgent(SimplePushSettings.parse({ apiKey: KEY }), { templates: TEMPLATES }).buildForm(GRAB);
    expect(templated.title).toBe('T Signal Lost');
    expect(templated.msg).toBe('B WEBDL-1080p\nhttps://mt.example.com/series/7');
  });

  it('maps failures without leaking the key', async () => {
    const http = fakeFetch(() => ({ status: 400, json: { status: 'BadRequest', message: 'Invalid key' } }));
    const error = await new SimplePushAgent(SimplePushSettings.parse({ apiKey: KEY }), { fetch: http.fetch }).send(GRAB).then(() => new Error('resolved'), (e: unknown) => e as Error);
    expect(error).toMatchObject({ agent: 'simplepush', code: 'remoteError', status: 400 });
    expect(error.message).not.toContain(KEY);

    const soft = fakeFetch(() => ({ status: 200, json: { status: 'UnknownError' } }));
    await expect(new SimplePushAgent(SimplePushSettings.parse({ apiKey: KEY }), { fetch: soft.fetch }).send(GRAB)).rejects.toMatchObject({
      message: 'SimplePush rejected the message: UnknownError',
    });
  });

  it('validates settings', () => {
    expect(SimplePushSettings.safeParse({}).success).toBe(false);
    expect(SimplePushSettings.safeParse({ apiKey: '' }).success).toBe(false);
  });
});
