import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { sampleEvent } from '../samples.js';
import { fakeFetch } from '../test-utils.js';
import { NotificationError } from '../types.js';
import { AppriseAgent, AppriseSettings, appriseType } from './apprise.js';

const KEY = 'secret-config-key';

describe('AppriseAgent', () => {
  it('stateful: POSTs to /notify/{key} with tags, type and markdown body', async () => {
    const http = fakeFetch();
    const agent = new AppriseAgent(AppriseSettings.parse({ serverUrl: 'http://apprise.example.com:8000/', configKey: KEY, tags: ['tv', 'admin'] }), {
      fetch: http.fetch,
    });
    await agent.send(sampleEvent('requestCreated', 'Arclight', 'https://arclight.example.com'));

    const call = http.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`http://apprise.example.com:8000/notify/${KEY}`);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers.authorization).toBeUndefined();
    const body = call.json() as Record<string, string>;
    expect(body).toMatchObject({ format: 'markdown', tag: 'tv,admin', type: 'info' });
    expect(body).not.toHaveProperty('urls');
    expect(body).not.toHaveProperty('attach');
    expect(body.title).toEqual(expect.any(String));
    // Link first, then actions, deduplicated (the "View request" action is the link).
    expect(body.body).toMatch(
      /\n\n\[Open\]\(https:\/\/arclight\.example\.com\/requests\/31\) \| \[Approve\]\(https:\/\/arclight\.example\.com\/requests\/31\?action=approve\) \| \[Decline\]\([^)]+\)$/,
    );
  });

  it('stateless: sends the URLs in the body with basic auth and the poster attached', async () => {
    const http = fakeFetch();
    const agent = new AppriseAgent(
      AppriseSettings.parse({
        serverUrl: 'https://apprise.example.com',
        urls: ['json://hooks.example.com/a', 'mailto://user:pass@example.com'],
        tags: ['ignored'],
        format: 'text',
        attachPoster: true,
        username: 'admin',
        password: 'pw',
      }),
      { fetch: http.fetch },
    );
    await agent.send(GRAB);
    const call = http.calls[0]!;
    expect(call.url).toBe('https://apprise.example.com/notify');
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from('admin:pw').toString('base64')}`);
    const body = call.json() as Record<string, string>;
    expect(body.urls).toBe('json://hooks.example.com/a,mailto://user:pass@example.com');
    expect(body).not.toHaveProperty('tag');
    expect(body.attach).toBe('https://img.example/poster.jpg');
    expect(body.format).toBe('text');
    expect(body.body).toMatch(/Download Client: qBittorrent\n[\s\S]*\n\nOpen: https:\/\/mt\.example\.com\/series\/7$/);
    // The default body's trailing link line is not repeated.
    expect(body.body!.split('https://mt.example.com/series/7')).toHaveLength(2);
  });

  it('renders html with escaped text and anchors', () => {
    const agent = new AppriseAgent(AppriseSettings.parse({ serverUrl: 'http://a.example.com', configKey: 'k', format: 'html' }), {
      templates: { grab: { body: 'a < b\nnext' } },
    });
    expect(agent.buildPayload(GRAB).body).toBe('a &lt; b<br>next<br><br><a href="https://mt.example.com/series/7">Open</a>');
  });

  it('maps severity to the Apprise type', () => {
    expect(appriseType('error')).toBe('failure');
    expect(appriseType('warning')).toBe('warning');
    expect(appriseType('success')).toBe('success');
    expect(appriseType('upgrade')).toBe('success');
    expect(appriseType('info')).toBe('info');
    const agent = new AppriseAgent(AppriseSettings.parse({ serverUrl: 'http://a.example.com', configKey: 'k' }));
    expect(agent.buildPayload(HEALTH_ISSUE).type).not.toBe('info');
  });

  it('applies user templates', () => {
    const agent = new AppriseAgent(AppriseSettings.parse({ serverUrl: 'http://a.example.com', configKey: 'k', format: 'text' }), {
      templates: { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } },
    });
    const payload = agent.buildPayload(GRAB);
    expect(payload.title).toBe('T Signal Lost');
    expect(payload.body).toBe('B WEBDL-1080p\n\nOpen: https://mt.example.com/series/7');
  });

  it('maps a 424 to remoteError and never echoes the key or URLs', async () => {
    const http = fakeFetch(() => ({ status: 424, body: 'One or more notification could not be sent.' }));
    const keyed = new AppriseAgent(AppriseSettings.parse({ serverUrl: 'http://a.example.com', configKey: KEY }), { fetch: http.fetch });
    const error = await keyed.send(GRAB).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotificationError);
    expect((error as NotificationError).code).toBe('remoteError');
    expect((error as NotificationError).message).toContain('Apprise API');
    expect((error as NotificationError).message).not.toContain(KEY);

    const unauthorized = fakeFetch(() => ({ status: 401 }));
    const stateless = new AppriseAgent(AppriseSettings.parse({ serverUrl: 'http://a.example.com', urls: ['tgram://bot-secret/123'] }), {
      fetch: unauthorized.fetch,
    });
    const error2 = (await stateless.send(GRAB).catch((e: unknown) => e)) as NotificationError;
    expect(error2.code).toBe('unauthorized');
    expect(error2.message).not.toContain('bot-secret');
  });

  it('validates settings: exactly one of configKey and urls', () => {
    expect(AppriseSettings.parse({ serverUrl: 'http://a.example.com', configKey: 'k' })).toMatchObject({ format: 'markdown', tags: [], attachPoster: false });
    expect(AppriseSettings.safeParse({ serverUrl: 'http://a.example.com' }).success).toBe(false);
    expect(AppriseSettings.safeParse({ serverUrl: 'http://a.example.com', urls: [] }).success).toBe(false);
    expect(AppriseSettings.safeParse({ serverUrl: 'http://a.example.com', configKey: 'k', urls: ['json://x.example.com'] }).success).toBe(false);
    expect(AppriseSettings.safeParse({ serverUrl: 'http://a.example.com', configKey: 'bad key/../' }).success).toBe(false);
    expect(AppriseSettings.safeParse({ serverUrl: 'file:///etc', configKey: 'k' }).success).toBe(false);
    expect(AppriseSettings.safeParse({ serverUrl: 'http://a.example.com', configKey: 'k', format: 'rtf' }).success).toBe(false);
  });
});
