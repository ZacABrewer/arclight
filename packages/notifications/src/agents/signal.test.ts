import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { sampleEvent } from '../samples.js';
import { fakeFetch } from '../test-utils.js';
import { POSTER_MAX_BYTES, SignalAgent, SignalSettings, type SignalPayload } from './signal.js';

const TITLE = 'Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave';
const BASE = { serverUrl: 'http://signal.example.com:8080/', number: '+15550100', recipients: ['+15550101', 'group.YWJjZGVm'] };
const POSTER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('SignalAgent', () => {
  it('fetches the poster and posts styled text with it attached to /v2/send', async () => {
    const http = fakeFetch((call) =>
      call.url === 'https://img.example/poster.jpg'
        ? new Response(POSTER, { status: 200, headers: { 'content-type': 'image/jpeg' } })
        : { status: 201, json: { timestamp: '1' } },
    );
    const agent = new SignalAgent(SignalSettings.parse({ ...BASE, username: 'u', password: 'basicSecret234' }), { fetch: http.fetch });
    await agent.send(GRAB);

    expect(http.calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', 'https://img.example/poster.jpg'],
      ['POST', 'http://signal.example.com:8080/v2/send'],
    ]);
    const send = http.calls[1]!;
    expect(send.headers.authorization).toBe(`Basic ${Buffer.from('u:basicSecret234').toString('base64')}`);
    expect(send.headers['content-type']).toBe('application/json');
    const payload = send.json() as SignalPayload;
    expect(payload).toMatchObject({ number: '+15550100', recipients: ['+15550101', 'group.YWJjZGVm'], text_mode: 'styled' });
    expect(payload.message.startsWith(`**${TITLE}**\nEpisode Grabbed\nQuality: WEBDL-1080p`)).toBe(true);
    expect(payload.message).toContain('Open: https://mt.example.com/series/7');
    expect(payload.base64_attachments).toEqual([`data:image/jpeg;filename=poster.jpg;base64,${POSTER.toString('base64')}`]);
  });

  it('skips the poster when disabled, missing, failing, too big or not an image', async () => {
    const off = fakeFetch(() => ({ status: 201 }));
    await new SignalAgent(SignalSettings.parse({ ...BASE, attachPoster: false }), { fetch: off.fetch }).send(GRAB);
    expect(off.calls).toHaveLength(1);
    expect(off.calls[0]!.json()).not.toHaveProperty('base64_attachments');
    expect(off.calls[0]!.headers.authorization).toBeUndefined();

    const none = fakeFetch(() => ({ status: 201 }));
    await new SignalAgent(SignalSettings.parse(BASE), { fetch: none.fetch }).send(HEALTH_ISSUE);
    expect(none.calls).toHaveLength(1);

    const responders: Array<() => Response> = [
      () => new Response('gone', { status: 404 }),
      () => new Response(new Uint8Array(POSTER_MAX_BYTES + 1), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ];
    for (const poster of responders) {
      const http = fakeFetch((call) => (call.method === 'GET' ? poster() : { status: 201 }));
      await new SignalAgent(SignalSettings.parse(BASE), { fetch: http.fetch }).send(GRAB);
      expect(http.calls[1]!.json()).not.toHaveProperty('base64_attachments');
    }
  });

  it('lists request actions as links', () => {
    const agent = new SignalAgent(SignalSettings.parse(BASE));
    const payload = agent.buildPayload(sampleEvent('requestCreated', 'Arclight', 'https://arclight.example.com'));
    expect(payload.message).toContain('Approve: https://arclight.example.com/requests/31?action=approve');
    expect(payload.message).toContain('Requested by alex');
  });

  it('uses a templated body', () => {
    const agent = new SignalAgent(SignalSettings.parse(BASE), { templates: { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } } });
    expect(agent.buildPayload(GRAB).message.startsWith('**T Signal Lost**\nB WEBDL-1080p')).toBe(true);
  });

  it('maps errors without leaking the password', async () => {
    const agent = new SignalAgent(SignalSettings.parse({ ...BASE, username: 'u', password: 'basicSecret234', attachPoster: false }), {
      fetch: fakeFetch(() => ({ status: 400, json: { error: 'Invalid recipient' } })).fetch,
    });
    const error = (await agent.send(GRAB).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ agent: 'signal', code: 'remoteError', status: 400 });
    expect(error.message).not.toContain('basicSecret234');
    const denied = new SignalAgent(SignalSettings.parse(BASE), { fetch: fakeFetch(() => ({ status: 401 })).fetch });
    await expect(denied.test()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('validates settings', () => {
    expect(SignalSettings.parse(BASE).attachPoster).toBe(true);
    expect(SignalSettings.safeParse({ ...BASE, number: '5550100' }).success).toBe(false);
    expect(SignalSettings.safeParse({ ...BASE, recipients: [] }).success).toBe(false);
    expect(SignalSettings.safeParse({ ...BASE, recipients: ['someone'] }).success).toBe(false);
    expect(SignalSettings.safeParse({ ...BASE, recipients: ['3f2a6b8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'] }).success).toBe(true);
    expect(SignalSettings.safeParse({ ...BASE, username: 'u' }).success).toBe(false);
  });
});
