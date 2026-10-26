import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE, IMPORT } from '../../fixtures/events.js';
import { createAgent } from '../index.js';
import { fakeFetch } from '../test-utils.js';
import type { GotifyPayload } from './gotify.js';
import { PUSHOVER_URL } from './pushover.js';

describe('NtfyAgent', () => {
  it('publishes a grab to every topic with title, priority, tags, click and bearer auth', async () => {
    const http = fakeFetch();
    const agent = createAgent(
      'ntfy',
      { serverUrl: 'https://ntfy.example/', topics: ['media', 'tv shows'], priority: 4, tags: ['tv', 'tada'], accessToken: 'tk_abc' },
      { fetch: http.fetch },
    );
    await agent.send(GRAB);

    expect(http.calls.map((c) => c.url)).toEqual(['https://ntfy.example/media', 'https://ntfy.example/tv%20shows']);
    const call = http.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers).toMatchObject({
      title: 'Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave',
      priority: '4',
      tags: 'tv,tada',
      click: 'https://mt.example.com/series/7',
      attach: 'https://img.example/poster.jpg',
      authorization: 'Bearer tk_abc',
    });
    expect(call.body).toContain('Episode Grabbed\nQuality: WEBDL-1080p');
  });

  it('uses basic auth, the explicit click URL, and describes imports and health issues', async () => {
    const http = fakeFetch();
    const agent = createAgent('ntfy', { topics: ['t'], username: 'u', password: 'p', clickUrl: 'https://go.example' }, { fetch: http.fetch });
    await agent.send(IMPORT);
    await agent.send(HEALTH_ISSUE);

    expect(http.calls[0]!.url).toBe('https://ntfy.sh/t');
    expect(http.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(http.calls[0]!.headers.click).toBe('https://go.example');
    expect(http.calls[0]!.headers.title).toBe('Harbour Lights (2021)');
    expect(http.calls[0]!.body).toContain('Movie Imported');
    expect(http.calls[1]!.headers.title).toBe('Health Issue: Error');
    expect(http.calls[1]!.headers.attach).toBeUndefined();
    expect(http.calls[1]!.body).toContain('Message: Unable to communicate with qBittorrent.');
  });

  it('RFC 2047-encodes non-ASCII titles and maps 403 to unauthorized', async () => {
    const http = fakeFetch();
    const agent = createAgent('ntfy', { topics: ['t'] }, { fetch: http.fetch });
    await agent.send({ ...IMPORT, media: { ...IMPORT.media, title: 'Amélie' } });
    expect(http.calls[0]!.headers.title).toBe(`=?UTF-8?B?${Buffer.from('Amélie (2021)').toString('base64')}?=`);

    const denied = createAgent('ntfy', { topics: ['t'] }, { fetch: fakeFetch(() => ({ status: 403, body: 'forbidden' })).fetch });
    await expect(denied.send(GRAB)).rejects.toMatchObject({ agent: 'ntfy', code: 'unauthorized', status: 403 });
  });
});

describe('GotifyAgent', () => {
  it('posts a markdown grab message with the app token in a header', async () => {
    const http = fakeFetch();
    const agent = createAgent('gotify', { serverUrl: 'https://gotify.example', appToken: 'AppTok', priority: 7 }, { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe('https://gotify.example/message');
    expect(call.headers['x-gotify-key']).toBe('AppTok');
    const payload = call.json() as GotifyPayload;
    expect(payload.title).toBe('Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave');
    expect(payload.priority).toBe(7);
    expect(payload.message.startsWith('**Episode Grabbed**  \n**Quality:** WEBDL-1080p')).toBe(true);
    expect(payload.extras['client::display'].contentType).toBe('text/markdown');
    expect(payload.extras['client::notification']).toEqual({ click: { url: 'https://mt.example.com/series/7' }, bigImageUrl: 'https://img.example/poster.jpg' });
  });

  it('sends plain text when markdown is off, for imports and health issues', async () => {
    const http = fakeFetch();
    const agent = createAgent('gotify', { serverUrl: 'http://gotify:80', appToken: 'x', markdown: false }, { fetch: http.fetch });
    await agent.send(IMPORT);
    await agent.send(HEALTH_ISSUE);

    const imported = http.calls[0]!.json() as GotifyPayload;
    expect(imported.extras['client::display'].contentType).toBe('text/plain');
    expect(imported.message).toContain('Movie Imported\nQuality: Bluray-1080p');
    const health = http.calls[1]!.json() as GotifyPayload;
    expect(health.title).toBe('Health Issue: Error');
    expect(health.extras['client::notification']).toBeUndefined();
  });

  it('maps a 401 to unauthorized', async () => {
    const agent = createAgent('gotify', { serverUrl: 'http://gotify', appToken: 'x' }, { fetch: fakeFetch(() => ({ status: 401, json: { error: 'Unauthorized' } })).fetch });
    await expect(agent.send(GRAB)).rejects.toMatchObject({ agent: 'gotify', code: 'unauthorized', status: 401 });
  });
});

describe('PushoverAgent', () => {
  const SETTINGS = { apiToken: 'a'.repeat(30), userKey: 'u'.repeat(30), devices: ['phone', 'tablet'], sound: 'cosmic' };

  it('posts a form-encoded grab message', async () => {
    const http = fakeFetch(() => ({ status: 200, json: { status: 1 } }));
    const agent = createAgent('pushover', SETTINGS, { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe(PUSHOVER_URL);
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.body);
    expect(form.get('token')).toBe(SETTINGS.apiToken);
    expect(form.get('user')).toBe(SETTINGS.userKey);
    expect(form.get('device')).toBe('phone,tablet');
    expect(form.get('sound')).toBe('cosmic');
    expect(form.get('priority')).toBe('0');
    expect(form.get('title')).toBe('Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave');
    expect(form.get('message')).toContain('Episode Grabbed\nQuality: WEBDL-1080p');
    expect(form.get('url')).toBe('https://mt.example.com/series/7');
    expect(form.get('timestamp')).toBe(String(Date.parse(GRAB.timestamp) / 1000));
    expect(form.has('retry')).toBe(false);
  });

  it('adds retry/expire for emergency priority and describes imports and health issues', async () => {
    const http = fakeFetch(() => ({ status: 200, json: { status: 1 } }));
    const agent = createAgent('pushover', { ...SETTINGS, devices: [], priority: 2, retry: 90, expire: 600 }, { fetch: http.fetch });
    await agent.send(IMPORT);
    await agent.send(HEALTH_ISSUE);

    const imported = new URLSearchParams(http.calls[0]!.body);
    expect(imported.has('device')).toBe(false);
    expect(imported.get('priority')).toBe('2');
    expect(imported.get('retry')).toBe('90');
    expect(imported.get('expire')).toBe('600');
    expect(imported.get('title')).toBe('Harbour Lights (2021)');
    expect(imported.get('message')).toContain('Movie Imported');

    const health = new URLSearchParams(http.calls[1]!.body);
    expect(health.get('title')).toBe('Health Issue: Error');
    expect(health.has('url')).toBe(false);
  });

  it('maps a 400 to remoteError with the response detail and rejects bad keys up front', async () => {
    const agent = createAgent('pushover', SETTINGS, { fetch: fakeFetch(() => ({ status: 400, json: { status: 0, errors: ['user key is invalid'] } })).fetch });
    await expect(agent.send(GRAB)).rejects.toMatchObject({ agent: 'pushover', code: 'remoteError', status: 400, message: expect.stringContaining('user key is invalid') });
    expect(() => createAgent('pushover', { ...SETTINGS, userKey: 'short' })).toThrowError(expect.objectContaining({ code: 'invalidSettings' }));
  });
});
