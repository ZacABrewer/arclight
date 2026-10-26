import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GRAB } from '../fixtures/events.js';
import {
  NOTIFICATION_AGENT_KINDS,
  NOTIFICATION_EVENT_TYPES,
  NotificationError,
  agentSettingsSchemas,
  createAgent,
  parseAgentSettings,
  type NotificationAgentKind,
} from './index.js';
import { fakeFetch } from './test-utils.js';

const VALID: Record<NotificationAgentKind, unknown> = {
  discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x' },
  telegram: { botToken: 't', chatId: '1' },
  webhook: { url: 'https://example.com/hook' },
  email: { host: 'smtp', from: 'mt@example.com', to: ['ops@example.org'] },
  'custom-script': { path: '/bin/true' },
  ntfy: { topics: ['t'] },
  gotify: { serverUrl: 'http://g', appToken: 'x' },
  pushover: { apiToken: 'a'.repeat(30), userKey: 'b'.repeat(30) },
  jellyfin: { host: 'jf', apiKey: 'k' },
  emby: { host: 'emby', apiKey: 'k' },
  plex: { host: 'plex', authToken: 't' },
};

describe('createAgent', () => {
  it('builds every kind from minimal settings and reports its kind', () => {
    for (const kind of NOTIFICATION_AGENT_KINDS) {
      const agent = createAgent(kind, VALID[kind], { fetch: fakeFetch().fetch });
      expect(agent.kind).toBe(kind);
      expect(agent.supportedEvents.size).toBeGreaterThan(0);
      for (const type of agent.supportedEvents) expect(NOTIFICATION_EVENT_TYPES).toContain(type);
    }
  });

  it('applies schema defaults when parsing stored settings', () => {
    expect(parseAgentSettings('ntfy', { topics: ['a'] })).toMatchObject({ serverUrl: 'https://ntfy.sh', priority: 3, tags: [] });
    expect(parseAgentSettings('email', VALID.email)).toMatchObject({ port: 587, security: 'starttls', cc: [], subjectPrefix: '[Arclight]' });
    expect(parseAgentSettings('discord', VALID.discord).grabFields).toContain('quality');
  });

  it('throws invalidSettings with the offending path for bad settings or kinds', async () => {
    const error = (() => {
      try {
        createAgent('telegram', { chatId: '1' });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(NotificationError);
    expect(error).toMatchObject({ code: 'invalidSettings', message: expect.stringContaining('botToken') });

    expect(() => createAgent('pager' as NotificationAgentKind, {})).toThrowError(expect.objectContaining({ code: 'invalidSettings' }));

    // Settings parsing happens up front, so no request is made.
    const http = fakeFetch();
    await expect(Promise.resolve().then(() => createAgent('gotify', { serverUrl: 'nope', appToken: '' }, { fetch: http.fetch }).send(GRAB))).rejects.toMatchObject({ code: 'invalidSettings' });
    expect(http.calls).toHaveLength(0);
  });
});

describe('agentSettingsSchemas', () => {
  it('covers every kind and describes every field for the settings form', () => {
    expect(Object.keys(agentSettingsSchemas).sort()).toEqual([...NOTIFICATION_AGENT_KINDS].sort());
    for (const [kind, schema] of Object.entries(agentSettingsSchemas)) {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      for (const [field, fieldSchema] of Object.entries(shape)) {
        expect((fieldSchema as z.ZodType).description, `${kind}.${field} needs .describe()`).toBeTruthy();
      }
    }
  });

  it('can be turned into JSON Schema for the UI', () => {
    const json = z.toJSONSchema(agentSettingsSchemas.discord) as { properties: Record<string, { description?: string }> };
    expect(json.properties.webhookUrl?.description).toContain('webhook');
  });
});
