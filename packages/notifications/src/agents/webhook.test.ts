import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE, IMPORT, RENAME } from '../../fixtures/events.js';
import { createAgent } from '../index.js';
import { failingFetch, fakeFetch } from '../test-utils.js';

describe('WebhookAgent', () => {
  it('POSTs the full grab event as JSON with basic auth and custom headers', async () => {
    const http = fakeFetch();
    const agent = createAgent(
      'webhook',
      { url: 'https://hooks.example.com/mt', username: 'user', password: 'pass', headers: { 'X-Api-Key': 'k1' } },
      { fetch: http.fetch },
    );
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://hooks.example.com/mt');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['x-api-key']).toBe('k1');
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
    expect(call.json()).toEqual({ eventType: 'grab', ...GRAB });
  });

  it('uses PUT when configured and forwards import, health and rename payloads verbatim', async () => {
    const http = fakeFetch();
    const agent = createAgent('webhook', { url: 'http://localhost:9000/hook', method: 'PUT' }, { fetch: http.fetch });
    await agent.send(IMPORT);
    await agent.send(HEALTH_ISSUE);
    await agent.send(RENAME);

    expect(http.calls.map((c) => c.method)).toEqual(['PUT', 'PUT', 'PUT']);
    expect(http.calls[0]!.headers.authorization).toBeUndefined();
    expect(http.calls[0]!.json()).toMatchObject({ eventType: 'import', file: { relativePath: IMPORT.file.relativePath }, release: { title: IMPORT.release?.title } });
    expect(http.calls[1]!.json()).toMatchObject({ eventType: 'healthIssue', health: HEALTH_ISSUE.health });
    expect(http.calls[2]!.json()).toMatchObject({ eventType: 'rename', renamedFiles: RENAME.renamedFiles });
  });

  it('maps non-2xx responses and network failures to NotificationError', async () => {
    const failing = createAgent('webhook', { url: 'https://hooks.example.com/mt' }, { fetch: fakeFetch(() => ({ status: 500, body: 'boom' })).fetch });
    await expect(failing.send(GRAB)).rejects.toMatchObject({ agent: 'webhook', code: 'remoteError', status: 500, message: expect.stringContaining('boom') });

    const unreachable = createAgent('webhook', { url: 'https://hooks.example.com/mt' }, { fetch: failingFetch(new TypeError('ECONNREFUSED')) });
    await expect(unreachable.send(GRAB)).rejects.toMatchObject({ code: 'network', message: expect.stringContaining('ECONNREFUSED') });
  });

  it('rejects invalid settings before sending anything', () => {
    expect(() => createAgent('webhook', { url: 'not a url' })).toThrowError(expect.objectContaining({ code: 'invalidSettings' }));
  });
});
