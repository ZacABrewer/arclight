import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { fakeFetch } from '../test-utils.js';
import { PUSHBULLET_URL, PushbulletAgent, PushbulletSettings, type PushbulletPayload } from './pushbullet.js';

const TOKEN = 'o.pbtoken123';
const TEMPLATES = { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } };

describe('PushbulletAgent', () => {
  it('sends a link push with the access token header', async () => {
    const http = fakeFetch();
    const agent = new PushbulletAgent(PushbulletSettings.parse({ accessToken: TOKEN, deviceIden: 'ujdev1' }), { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe(PUSHBULLET_URL);
    expect(call.method).toBe('POST');
    expect(call.headers['access-token']).toBe(TOKEN);
    expect(call.headers['content-type']).toBe('application/json');
    const payload = call.json() as PushbulletPayload;
    expect(payload.type).toBe('link');
    expect(payload.title).toBe('Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave');
    expect(payload.body).toContain('Episode Grabbed\nQuality: WEBDL-1080p');
    expect(payload.url).toBe('https://mt.example.com/series/7');
    expect(payload.device_iden).toBe('ujdev1');
    expect(payload.channel_tag).toBeUndefined();
  });

  it('sends a note when there is no link, to a channel or email target', () => {
    const channel = new PushbulletAgent(PushbulletSettings.parse({ accessToken: TOKEN, channelTag: 'media' }));
    const note = channel.buildPayload(HEALTH_ISSUE);
    expect(note.type).toBe('note');
    expect(note.url).toBeUndefined();
    expect(note.channel_tag).toBe('media');

    const email = new PushbulletAgent(PushbulletSettings.parse({ accessToken: TOKEN, email: 'friend@example.com' }));
    expect(email.buildPayload(GRAB).email).toBe('friend@example.com');
  });

  it('applies templates', () => {
    const agent = new PushbulletAgent(PushbulletSettings.parse({ accessToken: TOKEN }), { templates: TEMPLATES });
    const payload = agent.buildPayload(GRAB);
    expect(payload.title).toBe('T Signal Lost');
    expect(payload.body).toBe('B WEBDL-1080p');
  });

  it('maps 401 to unauthorized without leaking the token', async () => {
    const http = fakeFetch(() => ({ status: 401, json: { error: { message: 'Access token is missing or invalid.' } } }));
    const agent = new PushbulletAgent(PushbulletSettings.parse({ accessToken: TOKEN }), { fetch: http.fetch });
    const error = await agent.send(GRAB).then(() => new Error('resolved'), (e: unknown) => e as Error);
    expect(error).toMatchObject({ agent: 'pushbullet', code: 'unauthorized', status: 401 });
    expect(error.message).not.toContain(TOKEN);
  });

  it('validates settings', () => {
    expect(PushbulletSettings.safeParse({}).success).toBe(false);
    expect(PushbulletSettings.safeParse({ accessToken: TOKEN, deviceIden: 'a', channelTag: 'b' }).success).toBe(false);
    expect(PushbulletSettings.safeParse({ accessToken: TOKEN, email: 'not-an-email' }).success).toBe(false);
  });
});
