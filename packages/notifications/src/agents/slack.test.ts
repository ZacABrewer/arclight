import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { sampleEvent } from '../samples.js';
import { fakeFetch } from '../test-utils.js';
import { SlackAgent, SlackSettings, type SlackPayload } from './slack.js';

const HOOK = 'https://hooks.slack.example.com/services/T000/B000/secretPart123';
const TITLE = 'Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave';

describe('SlackAgent', () => {
  it('posts Block Kit with a linked headline, poster, fields, context and an Open button', async () => {
    const http = fakeFetch(() => ({ status: 200, body: 'ok' }));
    const agent = new SlackAgent(SlackSettings.parse({ webhookUrl: HOOK, channel: '#media', username: 'Arclight', iconEmoji: ':clapper:' }), { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe(HOOK);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    const payload = call.json() as SlackPayload;
    expect(payload).toMatchObject({ channel: '#media', username: 'Arclight', icon_emoji: ':clapper:', text: `Episode Grabbed: ${TITLE}` });
    expect(payload.blocks[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: `*<https://mt.example.com/series/7|${TITLE}>*\nEpisode Grabbed` },
      accessory: { type: 'image', image_url: 'https://img.example/poster.jpg', alt_text: TITLE },
    });
    const fields = payload.blocks[1]!;
    expect(fields.type).toBe('section');
    if (fields.type !== 'section') throw new Error('unreachable');
    expect(fields.fields!.length).toBeLessThanOrEqual(10);
    expect(fields.fields![0]).toEqual({ type: 'mrkdwn', text: '*Quality*\nWEBDL-1080p' });
    expect(payload.blocks[2]).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Arclight · Episode Grabbed' }] });
    expect(payload.blocks[3]).toMatchObject({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open' }, url: 'https://mt.example.com/series/7' }],
    });
  });

  it('turns request actions into styled buttons without duplicating the link', () => {
    const agent = new SlackAgent(SlackSettings.parse({ webhookUrl: HOOK }));
    const payload = agent.buildPayload(sampleEvent('requestCreated', 'Arclight', 'https://arclight.example.com'));
    const actions = payload.blocks.find((b) => b.type === 'actions');
    if (actions?.type !== 'actions') throw new Error('no actions block');
    expect(actions.elements.map((e) => [e.text.text, e.url, e.style])).toEqual([
      ['Approve', 'https://arclight.example.com/requests/31?action=approve', 'primary'],
      ['Decline', 'https://arclight.example.com/requests/31?action=decline', 'danger'],
      ['View request', 'https://arclight.example.com/requests/31', undefined],
    ]);
    expect(payload.channel).toBeUndefined();
  });

  it('escapes mrkdwn control characters and omits the poster when there is none', () => {
    const agent = new SlackAgent(SlackSettings.parse({ webhookUrl: HOOK }));
    const payload = agent.buildPayload({ ...HEALTH_ISSUE, health: { ...HEALTH_ISSUE.health, message: 'a <b> & c' } });
    expect(payload.blocks[0]).not.toHaveProperty('accessory');
    expect(JSON.stringify(payload.blocks[1])).toContain('a &lt;b&gt; &amp; c');
  });

  it('shows a templated body as the main text', () => {
    const agent = new SlackAgent(SlackSettings.parse({ webhookUrl: HOOK }), { templates: { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } } });
    const payload = agent.buildPayload(GRAB);
    expect(payload.blocks[0]).toMatchObject({ text: { text: '*<https://mt.example.com/series/7|T Signal Lost>*\nB WEBDL-1080p' } });
    expect(payload.text).toBe('T Signal Lost\nB WEBDL-1080p');
  });

  it('maps errors without leaking the webhook URL', async () => {
    const agent = new SlackAgent(SlackSettings.parse({ webhookUrl: HOOK }), { fetch: fakeFetch(() => ({ status: 403, body: 'invalid_token' })).fetch });
    const error = (await agent.send(GRAB).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ agent: 'slack', code: 'unauthorized', status: 403 });
    expect(error.message).not.toContain('secretPart123');
    const broken = new SlackAgent(SlackSettings.parse({ webhookUrl: HOOK }), { fetch: fakeFetch(() => ({ status: 500 })).fetch });
    await expect(broken.test()).rejects.toMatchObject({ code: 'remoteError' });
  });

  it('validates settings', () => {
    expect(SlackSettings.safeParse({ webhookUrl: 'ftp://x.example.com' }).success).toBe(false);
    expect(SlackSettings.safeParse({}).success).toBe(false);
    expect(SlackSettings.safeParse({ webhookUrl: HOOK, iconEmoji: 'clapper' }).success).toBe(false);
    expect(SlackSettings.safeParse({ webhookUrl: HOOK, iconEmoji: ':clapper:' }).success).toBe(true);
  });
});
