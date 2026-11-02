import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { sampleEvent } from '../samples.js';
import { fakeFetch } from '../test-utils.js';
import { GoogleChatAgent, GoogleChatSettings, type GoogleChatPayload } from './googlechat.js';

const HOOK = 'https://chat.example.com/v1/spaces/AAAA/messages?key=keyValue789&token=tokenValue012';
const TITLE = 'Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave';

describe('GoogleChatAgent', () => {
  it('posts a cardsV2 message with poster header, field rows and link buttons', async () => {
    const http = fakeFetch(() => ({ status: 200, json: { name: 'spaces/AAAA/messages/1' } }));
    const agent = new GoogleChatAgent(GoogleChatSettings.parse({ webhookUrl: HOOK }), { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe(HOOK);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json; charset=UTF-8');
    const payload = call.json() as GoogleChatPayload;
    expect(payload.text).toBe(`Episode Grabbed: ${TITLE}`);
    const { cardId, card } = payload.cardsV2[0]!;
    expect(cardId).toBe('arclight-grab');
    expect(card.header).toEqual({
      title: TITLE,
      subtitle: 'Episode Grabbed · Arclight',
      imageUrl: 'https://img.example/poster.jpg',
      imageType: 'SQUARE',
      imageAltText: 'Poster',
    });
    expect(card.sections[0]!.widgets[0]).toEqual({ decoratedText: { topLabel: 'Quality', text: 'WEBDL-1080p', wrapText: true } });
    expect(card.sections[1]!.widgets).toEqual([
      { buttonList: { buttons: [{ text: 'Open', onClick: { openLink: { url: 'https://mt.example.com/series/7' } } }] } },
    ]);
  });

  it('adds the thread parameters when a thread key is set', async () => {
    const http = fakeFetch();
    const agent = new GoogleChatAgent(GoogleChatSettings.parse({ webhookUrl: HOOK, threadKey: 'arclight grabs' }), { fetch: http.fetch });
    await agent.send(GRAB);
    const url = new URL(http.calls[0]!.url);
    expect(url.searchParams.get('key')).toBe('keyValue789');
    expect(url.searchParams.get('token')).toBe('tokenValue012');
    expect(url.searchParams.get('threadKey')).toBe('arclight grabs');
    expect(url.searchParams.get('messageReplyOption')).toBe('REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  });

  it('renders request actions as buttons and HTML-escapes text', () => {
    const agent = new GoogleChatAgent(GoogleChatSettings.parse({ webhookUrl: HOOK }));
    const card = agent.buildPayload(sampleEvent('requestCreated', 'Arclight', 'https://arclight.example.com')).cardsV2[0]!.card;
    const buttons = card.sections.at(-1)!.widgets[0]!;
    if (!('buttonList' in buttons)) throw new Error('no buttons');
    expect(buttons.buttonList.buttons.map((b) => b.text)).toEqual(['Approve', 'Decline', 'View request']);

    const health = agent.buildPayload({ ...HEALTH_ISSUE, health: { ...HEALTH_ISSUE.health, message: 'a <b> & c' } }).cardsV2[0]!.card;
    expect(health.header.imageUrl).toBeUndefined();
    expect(JSON.stringify(health.sections)).toContain('a &lt;b&gt; &amp; c');
  });

  it('shows a templated body as a text paragraph', () => {
    const agent = new GoogleChatAgent(GoogleChatSettings.parse({ webhookUrl: HOOK }), { templates: { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } } });
    const card = agent.buildPayload(GRAB).cardsV2[0]!.card;
    expect(card.header.title).toBe('T Signal Lost');
    expect(card.sections[0]!.widgets[0]).toEqual({ textParagraph: { text: 'B WEBDL-1080p' } });
  });

  it('maps errors without leaking the key or token', async () => {
    const agent = new GoogleChatAgent(GoogleChatSettings.parse({ webhookUrl: HOOK }), { fetch: fakeFetch(() => ({ status: 403, json: { error: { message: 'denied' } } })).fetch });
    const error = (await agent.send(GRAB).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ agent: 'googlechat', code: 'unauthorized', status: 403 });
    expect(error.message).not.toContain('keyValue789');
    expect(error.message).not.toContain('tokenValue012');
    const broken = new GoogleChatAgent(GoogleChatSettings.parse({ webhookUrl: HOOK }), { fetch: fakeFetch(() => ({ status: 500 })).fetch });
    await expect(broken.test()).rejects.toMatchObject({ code: 'remoteError' });
  });

  it('validates settings', () => {
    expect(GoogleChatSettings.safeParse({}).success).toBe(false);
    expect(GoogleChatSettings.safeParse({ webhookUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(GoogleChatSettings.safeParse({ webhookUrl: HOOK, threadKey: 'x'.repeat(201) }).success).toBe(false);
  });
});
