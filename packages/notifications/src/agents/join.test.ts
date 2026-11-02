import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { fakeFetch } from '../test-utils.js';
import { JOIN_URL, JoinAgent, JoinSettings } from './join.js';

const KEY = 'joinapikey0123456789';
const OK = { status: 200, json: { success: true } };
const TEMPLATES = { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } };

describe('JoinAgent', () => {
  it('sends a GET with everything in the query', async () => {
    const http = fakeFetch(() => OK);
    const agent = new JoinAgent(JoinSettings.parse({ apiKey: KEY, deviceIds: ['dev1', 'dev2'], priority: 2 }), { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.method).toBe('GET');
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(JOIN_URL);
    const q = url.searchParams;
    expect(q.get('apikey')).toBe(KEY);
    expect(q.get('deviceId')).toBe('dev1,dev2');
    expect(q.get('title')).toBe('Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave');
    expect(q.get('text')).toContain('Episode Grabbed\nQuality: WEBDL-1080p');
    expect(q.get('icon')).toBe('https://img.example/poster.jpg');
    expect(q.get('image')).toBe('https://img.example/poster.jpg');
    expect(q.get('url')).toBe('https://mt.example.com/series/7');
    expect(q.get('group')).toBe('Arclight');
    expect(q.get('priority')).toBe('2');
  });

  it('targets all devices by default, or device names', () => {
    expect(new JoinAgent(JoinSettings.parse({ apiKey: KEY })).buildQuery(HEALTH_ISSUE)).toMatchObject({ deviceId: 'group.all' });
    const named = new JoinAgent(JoinSettings.parse({ apiKey: KEY, deviceNames: ['Phone', 'Tablet'] })).buildQuery(HEALTH_ISSUE);
    expect(named.deviceNames).toBe('Phone,Tablet');
    expect(named.deviceId).toBeUndefined();
    expect(named.icon).toBeUndefined();
  });

  it('applies templates', () => {
    const q = new JoinAgent(JoinSettings.parse({ apiKey: KEY }), { templates: TEMPLATES }).buildQuery(GRAB);
    expect(q.title).toBe('T Signal Lost');
    expect(q.text).toBe('B WEBDL-1080p');
  });

  it('maps failures without leaking the key', async () => {
    const http = fakeFetch(() => ({ status: 500, body: 'oops' }));
    const error = await new JoinAgent(JoinSettings.parse({ apiKey: KEY }), { fetch: http.fetch }).send(GRAB).then(() => new Error('resolved'), (e: unknown) => e as Error);
    expect(error).toMatchObject({ agent: 'join', code: 'remoteError', status: 500, message: 'Join API responded 500: oops' });
    expect(error.message).not.toContain(KEY);

    const soft = fakeFetch(() => ({ status: 200, json: { success: false, errorMessage: 'User Not Authenticated' } }));
    await expect(new JoinAgent(JoinSettings.parse({ apiKey: KEY }), { fetch: soft.fetch }).send(GRAB)).rejects.toMatchObject({
      code: 'remoteError',
      message: 'Join rejected the message: User Not Authenticated',
    });
  });

  it('validates settings', () => {
    expect(JoinSettings.safeParse({}).success).toBe(false);
    expect(JoinSettings.safeParse({ apiKey: KEY, priority: -3 }).success).toBe(false);
    expect(JoinSettings.parse({ apiKey: KEY }).deviceIds).toEqual([]);
  });
});
