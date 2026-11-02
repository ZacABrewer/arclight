import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GRAB, IMPORT } from '../fixtures/events.js';
import { createAgent, NOTIFICATION_AGENT_KINDS, NOTIFICATION_EVENT_TYPES, type NotificationAgentKind } from './index.js';
import { sampleEvent } from './samples.js';
import { applyTemplate, renderTemplate, templateContext, templateFor, validateTemplate } from './template.js';
import { formatEvent } from './format.js';
import { collectSecrets, redactSecrets } from './redact.js';
import { fakeFetch, fakeMqtt, MINIMAL_SETTINGS, serviceResponder } from './test-utils.js';
import type { FetchLike } from './http.js';

describe('renderTemplate', () => {
  const ctx = { a: 'x', n: 0, list: ['p', 'q'], empty: [], nested: { deep: { v: 'd' } }, quote: 'say "hi"\n' };

  it('substitutes variables, dotted paths and joins lists', () => {
    expect(renderTemplate('{{a}}-{{ nested.deep.v }}-{{list}}-{{missing}}-{{n}}', ctx)).toBe('x-d-p, q--0');
  });

  it('renders sections and inverted sections', () => {
    expect(renderTemplate('{{#a}}has {{a}}{{/a}}{{^missing}} none{{/missing}}{{#empty}}never{{/empty}}', ctx)).toBe('has x none');
  });

  it('escapes for JSON and inserts raw JSON values', () => {
    expect(renderTemplate('{"t":"{{quote}}","l":{{json list}},"m":{{json missing}}}', ctx, 'json')).toBe('{"t":"say \\"hi\\"\\n","l":["p","q"],"m":null}');
    expect(JSON.parse(renderTemplate('{"t":"{{quote}}"}', ctx, 'json'))).toEqual({ t: 'say "hi"\n' });
  });

  it('never walks the prototype chain', () => {
    expect(renderTemplate('{{a.constructor}}{{constructor.name}}{{__proto__}}', ctx)).toBe('');
  });

  it('reports unbalanced sections', () => {
    expect(validateTemplate('{{#a}}open')).toMatch(/never closed/);
    expect(validateTemplate('{{/a}}')).toMatch(/Unexpected/);
    expect(validateTemplate('{{#a}}{{/a}}')).toBeUndefined();
  });
});

describe('applyTemplate', () => {
  it('replaces title and body for the event type, falling back to default', () => {
    const formatted = formatEvent(GRAB);
    const out = applyTemplate(GRAB, formatted, { grab: { title: '{{mediaTitle}} {{episode}}', body: 'Got {{quality}} from {{indexer}}' } });
    expect(out.title).toBe('Signal Lost S02E03-E04');
    expect(out.body).toBe('Got WEBDL-1080p from Example Indexer');
    expect(out.templated).toEqual({ title: true, body: true });
    expect(out.posterUrl).toBe(formatted.posterUrl);

    const fallback = applyTemplate(IMPORT, formatEvent(IMPORT), { default: { body: '{{subject}}: {{title}}' }, grab: { title: 'unused' } });
    expect(fallback.body).toBe('Movie Imported: Harbour Lights (2021)');
    expect(fallback.title).toBe('Harbour Lights (2021)');
  });

  it('keeps the default text for blank templates, and for tests unless the test has its own', () => {
    expect(templateFor({ grab: { title: '  ', body: '' } }, 'grab')).toBeUndefined();
    const test = sampleEvent('test');
    expect(applyTemplate(test, formatEvent(test), { default: { title: 'nope' } }).title).toBe(formatEvent(test).title);
    expect(applyTemplate(test, formatEvent(test), { test: { title: 'yes' } }).title).toBe('yes');
  });

  it('builds a context for every sample event', () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      const event = sampleEvent(type, 'Arclight', 'https://arclight.example.com');
      const ctx = templateContext(event);
      expect(ctx.eventType).toBe(type);
      expect(typeof ctx.title).toBe('string');
    }
    const request = templateContext(sampleEvent('requestDeclined'));
    expect(request).toMatchObject({ requestedBy: 'alex', reason: 'Already in the library in 4K', mediaTitle: 'Harbour Lights' });
  });
});

describe('templates reach every messaging agent', () => {
  for (const kind of NOTIFICATION_AGENT_KINDS) {
    it(kind, async () => {
      const http = fakeFetch(serviceResponder);
      const mqtt = fakeMqtt();
      const agent = createAgent(kind, MINIMAL_SETTINGS[kind], {
        fetch: http.fetch,
        socket: mqtt.socket,
        templates: { grab: { title: 'TPL-TITLE {{mediaTitle}}', body: 'TPL-BODY {{quality}}' } },
      });
      if (!agent.supportedEvents.has('grab') || kind === 'custom-script' || kind === 'email' || kind === 'plex' || kind === 'jellyfin') return;
      await agent.send(GRAB);
      const sent = http.calls.map((c) => decodeURIComponent(`${c.url} ${JSON.stringify(c.headers)} ${c.body ?? ''}`.replace(/\+/g, ' '))).join('\n') + mqtt.published.map((p) => p.payload).join('\n');
      if (kind === 'webhook' || kind === 'emby') return; // raw event JSON / server notification
      expect(sent.replace(/\\/g, '')).toContain('TPL-BODY WEBDL-1080p');
    });
  }
});

describe('webhook body template', () => {
  it('sends a custom JSON body with escaped variables and a custom method', async () => {
    const http = fakeFetch();
    const agent = createAgent('webhook', {
      url: 'https://hooks.example.com/x',
      method: 'PATCH',
      headers: { Authorization: 'Bearer abc' },
      bodyTemplate: '{"text":"{{title}}","overview":"{{overview}}","ids":{{json event.episodes}}}',
    }, { fetch: http.fetch });
    await agent.send(GRAB);
    const call = http.calls[0]!;
    expect(call.method).toBe('PATCH');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers.authorization).toBe('Bearer abc');
    expect(call.json()).toMatchObject({ text: 'Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave', ids: [{ id: 701 }, { id: 702 }] });
  });

  it('refuses a template that does not produce JSON, and plain text bodies pass through', async () => {
    const bad = createAgent('webhook', { url: 'https://hooks.example.com/x', bodyTemplate: '{"a": {{title}} }' }, { fetch: fakeFetch().fetch });
    await expect(bad.send(GRAB)).rejects.toMatchObject({ code: 'invalidSettings' });
    const http = fakeFetch();
    await createAgent('webhook', { url: 'https://hooks.example.com/x', bodyTemplate: 'New: {{title}}', contentType: 'text/plain' }, { fetch: http.fetch }).send(IMPORT);
    expect(http.calls[0]!.body).toBe('New: Harbour Lights (2021)');
    expect(http.calls[0]!.headers['content-type']).toBe('text/plain');
    expect(() => createAgent('webhook', { url: 'https://hooks.example.com/x', bodyTemplate: '{{#a}}' })).toThrowError(expect.objectContaining({ code: 'invalidSettings' }));
  });
});

describe('redactSecrets', () => {
  it('removes secret values, token parts of secret URLs, header values and Apprise URLs', () => {
    const settings = {
      webhookUrl: 'https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz',
      apiKey: 'k-1234567',
      headers: { 'X-Token': 'header-secret-value' },
      urls: ['tgram://bottoken123456/chat'],
      host: 'example.com',
      short: 'abc',
    };
    expect(collectSecrets(settings)).toContain('abcdefghijklmnopqrstuvwxyz');
    const text = 'failed https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz and abcdefghijklmnopqrstuvwxyz k-1234567 header-secret-value tgram://bottoken123456/chat at example.com';
    const out = redactSecrets(text, settings);
    expect(out).not.toMatch(/abcdefghijklmnop|k-1234567|header-secret|bottoken/);
    expect(out).toContain('example.com');
  });
});

// Every HTTP agent against a real local HTTP server: fetch is real, only the host is rewritten.
describe('every HTTP agent over a real socket', () => {
  const received: Array<{ host: string; method: string; path: string; body: string }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const host = req.headers['x-original-host'] as string;
      received.push({ host, method: req.method ?? '', path: req.url ?? '', body });
      const reply = serviceResponder({ url: `https://${host}${req.url}`, method: req.method ?? 'GET', headers: {}, body, json: () => undefined });
      res.writeHead(reply.status, { 'Content-Type': reply.json !== undefined ? 'application/json' : 'text/xml' });
      res.end(reply.json !== undefined ? JSON.stringify(reply.json) : (reply.body ?? ''));
    });
  });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const rewrite: FetchLike = (input, init) => {
    const url = new URL(input);
    const headers = { ...(init?.headers as Record<string, string>), 'X-Original-Host': url.host };
    return globalThis.fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...init, headers });
  };

  const HTTP_KINDS = NOTIFICATION_AGENT_KINDS.filter((k): k is NotificationAgentKind => !['email', 'custom-script', 'mqtt'].includes(k));
  for (const kind of HTTP_KINDS) {
    it(kind, async () => {
      const before = received.length;
      await createAgent(kind, MINIMAL_SETTINGS[kind], { fetch: rewrite }).send(IMPORT);
      expect(received.length).toBeGreaterThan(before);
    });
  }
});
