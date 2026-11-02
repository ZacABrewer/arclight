import { describe, expect, it } from 'vitest';
import { GRAB } from '../../fixtures/events.js';
import { sampleEvent } from '../samples.js';
import { fakeFetch } from '../test-utils.js';
import { MatrixAgent, MatrixSettings, type MatrixMessage } from './matrix.js';

const TOKEN = 'syt_secretAccessToken901';
const TITLE = 'Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave';
const NOW = () => new Date('2026-10-25T12:00:00.000Z');

describe('MatrixAgent', () => {
  it('PUTs an m.notice with plain and HTML bodies to the room, with a unique txn id', async () => {
    const http = fakeFetch(() => ({ status: 200, json: { event_id: '$e1' } }));
    const agent = new MatrixAgent(MatrixSettings.parse({ homeserverUrl: 'https://matrix.example.com/', accessToken: TOKEN, roomId: '!abc:example.com' }), {
      fetch: http.fetch,
      now: NOW,
    });
    await agent.send(GRAB);
    await agent.send(GRAB);

    const [first, second] = http.calls;
    expect(first!.method).toBe('PUT');
    expect(first!.url).toMatch(/^https:\/\/matrix\.example\.com\/_matrix\/client\/v3\/rooms\/!abc%3Aexample\.com\/send\/m\.room\.message\/arclight-1792929600000-\d+$/);
    expect(second!.url).not.toBe(first!.url);
    expect(first!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(first!.headers['content-type']).toBe('application/json');
    const message = first!.json() as MatrixMessage;
    expect(message.msgtype).toBe('m.notice');
    expect(message.format).toBe('org.matrix.custom.html');
    expect(message.body.startsWith(`${TITLE}\nEpisode Grabbed\nQuality: WEBDL-1080p`)).toBe(true);
    expect(message.body).toContain('Open: https://mt.example.com/series/7');
    expect(message.formatted_body.startsWith(`<b><a href="https://mt.example.com/series/7">${TITLE}</a></b><br><i>Episode Grabbed</i><br><b>Quality:</b> WEBDL-1080p`)).toBe(true);
  });

  it('resolves a room alias once, then sends to the room id', async () => {
    const http = fakeFetch((call) => (call.method === 'GET' ? { status: 200, json: { room_id: '!resolved:example.com', servers: ['example.com'] } } : { status: 200, json: {} }));
    const agent = new MatrixAgent(MatrixSettings.parse({ homeserverUrl: 'https://matrix.example.com', accessToken: TOKEN, roomId: '#media:example.com', msgtype: 'm.text' }), {
      fetch: http.fetch,
    });
    await agent.send(GRAB);
    await agent.test();

    expect(http.calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'PUT']);
    expect(http.calls[0]!.url).toBe('https://matrix.example.com/_matrix/client/v3/directory/room/%23media%3Aexample.com');
    expect(http.calls[1]!.url).toContain('/rooms/!resolved%3Aexample.com/send/m.room.message/');
    expect((http.calls[1]!.json() as MatrixMessage).msgtype).toBe('m.text');
  });

  it('HTML-escapes event text and links request actions', () => {
    const agent = new MatrixAgent(MatrixSettings.parse({ accessToken: TOKEN, roomId: '!abc:example.com' }));
    const event = sampleEvent('requestCreated', 'Arclight', 'https://arclight.example.com');
    if (event.type !== 'requestCreated') throw new Error('unreachable');
    const message = agent.buildPayload({ ...event, media: { ...event.media, title: 'Fish & <Chips>' } });
    expect(message.formatted_body).toContain('Fish &amp; &lt;Chips&gt;');
    expect(message.formatted_body).not.toContain('<Chips>');
    expect(message.formatted_body).toContain('<a href="https://arclight.example.com/requests/31?action=approve">Approve</a>');
    expect(message.body).toContain('Approve: https://arclight.example.com/requests/31?action=approve');
  });

  it('uses a templated body', () => {
    const agent = new MatrixAgent(MatrixSettings.parse({ accessToken: TOKEN, roomId: '!abc:example.com' }), { templates: { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } } });
    const message = agent.buildPayload(GRAB);
    expect(message.body.startsWith('T Signal Lost\nB WEBDL-1080p')).toBe(true);
    expect(message.formatted_body.startsWith('<b><a href="https://mt.example.com/series/7">T Signal Lost</a></b><br>B WEBDL-1080p')).toBe(true);
  });

  it('maps errors without leaking the token', async () => {
    const agent = new MatrixAgent(MatrixSettings.parse({ accessToken: TOKEN, roomId: '!abc:example.com' }), {
      fetch: fakeFetch(() => ({ status: 401, json: { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token passed.' } })).fetch,
    });
    const error = (await agent.send(GRAB).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ agent: 'matrix', code: 'unauthorized', status: 401 });
    expect(error.message).not.toContain(TOKEN);

    const missing = new MatrixAgent(MatrixSettings.parse({ accessToken: TOKEN, roomId: '#nope:example.com' }), { fetch: fakeFetch(() => ({ status: 404, json: { errcode: 'M_NOT_FOUND' } })).fetch });
    await expect(missing.test()).rejects.toMatchObject({ code: 'notFound' });
    const broken = new MatrixAgent(MatrixSettings.parse({ accessToken: TOKEN, roomId: '!abc:example.com' }), { fetch: fakeFetch(() => ({ status: 500 })).fetch });
    await expect(broken.test()).rejects.toMatchObject({ code: 'remoteError' });
  });

  it('validates settings', () => {
    expect(MatrixSettings.parse({ accessToken: TOKEN, roomId: '!abc:example.com' })).toMatchObject({ homeserverUrl: 'https://matrix.org', msgtype: 'm.notice' });
    expect(MatrixSettings.safeParse({ accessToken: TOKEN, roomId: 'abc' }).success).toBe(false);
    expect(MatrixSettings.safeParse({ accessToken: '', roomId: '!abc:example.com' }).success).toBe(false);
    expect(MatrixSettings.safeParse({ accessToken: TOKEN, roomId: '!abc:example.com', msgtype: 'm.image' }).success).toBe(false);
  });
});
