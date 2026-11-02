import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { sampleEvent } from '../samples.js';
import { fakeFetch } from '../test-utils.js';
import { ROCKETCHAT_COLOURS, RocketChatAgent, RocketChatSettings, type RocketChatPayload } from './rocketchat.js';

const HOOK = 'https://rocket.example.com/hooks/abc123/integrationToken678';
const TITLE = 'Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave';

describe('RocketChatAgent', () => {
  it('posts text plus an attachment with linked title, colour, fields and thumbnail', async () => {
    const http = fakeFetch(() => ({ status: 200, json: { success: true } }));
    const agent = new RocketChatAgent(
      RocketChatSettings.parse({ webhookUrl: HOOK, channel: '#media', alias: 'Arclight', emoji: ':clapper:' }),
      { fetch: http.fetch },
    );
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe(HOOK);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    const payload = call.json() as RocketChatPayload;
    expect(payload).toMatchObject({ text: '*Episode Grabbed* · Arclight', channel: '#media', alias: 'Arclight', emoji: ':clapper:' });
    expect(payload.avatar).toBeUndefined();
    const attachment = payload.attachments[0]!;
    expect(attachment).toMatchObject({
      title: TITLE,
      title_link: 'https://mt.example.com/series/7',
      text: '[Open](https://mt.example.com/series/7)',
      color: ROCKETCHAT_COLOURS.info,
      thumb_url: 'https://img.example/poster.jpg',
    });
    expect(attachment.image_url).toBeUndefined();
    expect(attachment.fields[0]).toEqual({ short: true, title: 'Quality', value: 'WEBDL-1080p' });
  });

  it('uses a large poster, the avatar URL, and request action links', () => {
    const agent = new RocketChatAgent(
      RocketChatSettings.parse({ webhookUrl: HOOK, largePoster: true, avatarUrl: 'https://img.example.com/a.png', emoji: ':clapper:' }),
    );
    const payload = agent.buildPayload(sampleEvent('requestCreated', 'Arclight', 'https://arclight.example.com'));
    expect(payload.avatar).toBe('https://img.example.com/a.png');
    expect(payload.emoji).toBeUndefined();
    const attachment = payload.attachments[0]!;
    expect(attachment.image_url).toBe('https://image.tmdb.org/t/p/w500/example-movie.jpg');
    expect(attachment.text).toContain('[Approve](https://arclight.example.com/requests/31?action=approve)');
    expect(agent.buildPayload(HEALTH_ISSUE).attachments[0]!.color).toBe(ROCKETCHAT_COLOURS.error);
  });

  it('shows a templated body as the attachment text', () => {
    const agent = new RocketChatAgent(RocketChatSettings.parse({ webhookUrl: HOOK }), { templates: { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } } });
    const attachment = agent.buildPayload(GRAB).attachments[0]!;
    expect(attachment.title).toBe('T Signal Lost');
    expect(attachment.text.startsWith('B WEBDL-1080p')).toBe(true);
  });

  it('maps errors, including success:false, without leaking the webhook token', async () => {
    const agent = new RocketChatAgent(RocketChatSettings.parse({ webhookUrl: HOOK }), { fetch: fakeFetch(() => ({ status: 401, body: 'nope' })).fetch });
    const error = (await agent.send(GRAB).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ agent: 'rocketchat', code: 'unauthorized', status: 401 });
    expect(error.message).not.toContain('integrationToken678');

    const rejected = new RocketChatAgent(RocketChatSettings.parse({ webhookUrl: HOOK }), {
      fetch: fakeFetch(() => ({ status: 200, json: { success: false, error: 'invalid-channel' } })).fetch,
    });
    const rejection = (await rejected.test().catch((e: unknown) => e)) as Error;
    expect(rejection).toMatchObject({ code: 'remoteError' });
    expect(rejection.message).toContain('invalid-channel');
    expect(rejection.message).not.toContain('integrationToken678');
  });

  it('validates settings', () => {
    expect(RocketChatSettings.safeParse({}).success).toBe(false);
    expect(RocketChatSettings.safeParse({ webhookUrl: HOOK, emoji: 'smile' }).success).toBe(false);
    expect(RocketChatSettings.parse({ webhookUrl: HOOK }).largePoster).toBe(false);
  });
});
