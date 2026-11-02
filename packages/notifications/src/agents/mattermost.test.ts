import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { sampleEvent } from '../samples.js';
import { fakeFetch } from '../test-utils.js';
import { MATTERMOST_COLOURS, MattermostAgent, MattermostSettings, type MattermostPayload } from './mattermost.js';

const HOOK = 'https://chat.example.com/hooks/hookSecret345';
const TITLE = 'Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave';

describe('MattermostAgent', () => {
  it('posts a Slack-style attachment with colour, linked title, fields, thumbnail and links', async () => {
    const http = fakeFetch(() => ({ status: 200, body: 'ok' }));
    const agent = new MattermostAgent(
      MattermostSettings.parse({ webhookUrl: HOOK, channel: 'media', username: 'Arclight', iconUrl: 'https://img.example.com/icon.png' }),
      { fetch: http.fetch },
    );
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe(HOOK);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    const payload = call.json() as MattermostPayload;
    expect(payload).toMatchObject({ channel: 'media', username: 'Arclight', icon_url: 'https://img.example.com/icon.png' });
    const attachment = payload.attachments[0]!;
    expect(attachment).toMatchObject({
      fallback: `Episode Grabbed: ${TITLE}`,
      color: MATTERMOST_COLOURS.info,
      title: TITLE,
      title_link: 'https://mt.example.com/series/7',
      text: 'Episode Grabbed\n\n[Open](https://mt.example.com/series/7)',
      thumb_url: 'https://img.example/poster.jpg',
      footer: 'Arclight',
    });
    expect(attachment.fields[0]).toEqual({ short: true, title: 'Quality', value: 'WEBDL-1080p' });
    expect(attachment.fields.find((f) => f.title === 'Release')).toMatchObject({ short: false });
  });

  it('puts request actions in the text as Markdown links and colours by severity', () => {
    const agent = new MattermostAgent(MattermostSettings.parse({ webhookUrl: HOOK }));
    const request = agent.buildPayload(sampleEvent('requestCreated', 'Arclight', 'https://arclight.example.com')).attachments[0]!;
    expect(request.text).toContain(
      '[Approve](https://arclight.example.com/requests/31?action=approve) · [Decline](https://arclight.example.com/requests/31?action=decline) · [View request](https://arclight.example.com/requests/31)',
    );
    expect(request.author_name).toBe('Requested by alex');
    const health = agent.buildPayload(HEALTH_ISSUE).attachments[0]!;
    expect(health.color).toBe(MATTERMOST_COLOURS.error);
    expect(health.thumb_url).toBeUndefined();
  });

  it('shows a templated body as the attachment text', () => {
    const agent = new MattermostAgent(MattermostSettings.parse({ webhookUrl: HOOK }), { templates: { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } } });
    const attachment = agent.buildPayload(GRAB).attachments[0]!;
    expect(attachment.title).toBe('T Signal Lost');
    expect(attachment.text.startsWith('B WEBDL-1080p')).toBe(true);
  });

  it('maps errors without leaking the webhook URL', async () => {
    const agent = new MattermostAgent(MattermostSettings.parse({ webhookUrl: HOOK }), { fetch: fakeFetch(() => ({ status: 400, body: 'Invalid webhook' })).fetch });
    const error = (await agent.send(GRAB).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ agent: 'mattermost', code: 'remoteError', status: 400 });
    expect(error.message).not.toContain('hookSecret345');
    const denied = new MattermostAgent(MattermostSettings.parse({ webhookUrl: HOOK }), { fetch: fakeFetch(() => ({ status: 403 })).fetch });
    await expect(denied.test()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('validates settings', () => {
    expect(MattermostSettings.safeParse({}).success).toBe(false);
    expect(MattermostSettings.safeParse({ webhookUrl: HOOK, iconUrl: 'file:///x.png' }).success).toBe(false);
    expect(MattermostSettings.safeParse({ webhookUrl: HOOK }).success).toBe(true);
  });
});
