import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { sampleEvent } from '../samples.js';
import { fakeFetch } from '../test-utils.js';
import { TeamsAgent, TeamsSettings, type TeamsPayload } from './teams.js';

const HOOK = 'https://prod-00.westus.logic.example.com/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=secretSig456';
const TITLE = 'Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave';

describe('TeamsAgent', () => {
  it('posts an Adaptive Card message with poster, title, facts and an open action; accepts 202', async () => {
    const http = fakeFetch(() => ({ status: 202 }));
    const agent = new TeamsAgent(TeamsSettings.parse({ webhookUrl: HOOK }), { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe(HOOK);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    const payload = call.json() as TeamsPayload;
    expect(payload.type).toBe('message');
    const attachment = payload.attachments[0]!;
    expect(attachment).toMatchObject({ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null });
    const card = attachment.content;
    expect(card).toMatchObject({ type: 'AdaptiveCard', version: '1.4' });
    expect(card.body[0]).toMatchObject({
      type: 'ColumnSet',
      columns: [
        { width: 'auto', items: [{ type: 'Image', url: 'https://img.example/poster.jpg' }] },
        { width: 'stretch', items: [{ type: 'TextBlock', text: TITLE, weight: 'Bolder' }, { type: 'TextBlock', text: 'Episode Grabbed · Arclight' }] },
      ],
      selectAction: { type: 'Action.OpenUrl', url: 'https://mt.example.com/series/7' },
    });
    const facts = card.body.find((b) => b.type === 'FactSet');
    expect(facts).toMatchObject({ facts: expect.arrayContaining([{ title: 'Quality', value: 'WEBDL-1080p' }]) });
    expect(card.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Open', url: 'https://mt.example.com/series/7' }]);
  });

  it('adds request actions and skips the poster column when there is none', () => {
    const agent = new TeamsAgent(TeamsSettings.parse({ webhookUrl: HOOK }));
    const card = agent.buildPayload(sampleEvent('requestCreated', 'Arclight', 'https://arclight.example.com')).attachments[0]!.content;
    expect(card.actions!.map((a) => a.title)).toEqual(['Approve', 'Decline', 'View request']);
    const health = agent.buildPayload(HEALTH_ISSUE).attachments[0]!.content;
    const header = health.body[0]!;
    if (header.type !== 'ColumnSet') throw new Error('no header');
    expect(header.columns).toHaveLength(1);
    expect(health.actions).toBeUndefined();
  });

  it('shows a templated body as a wrapped text block', () => {
    const agent = new TeamsAgent(TeamsSettings.parse({ webhookUrl: HOOK }), { templates: { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } } });
    const card = agent.buildPayload(GRAB).attachments[0]!.content;
    expect(JSON.stringify(card.body[0])).toContain('T Signal Lost');
    expect(card.body[1]).toEqual({ type: 'TextBlock', text: 'B WEBDL-1080p', wrap: true });
  });

  it('maps errors without leaking the webhook URL', async () => {
    const agent = new TeamsAgent(TeamsSettings.parse({ webhookUrl: HOOK }), { fetch: fakeFetch(() => ({ status: 400, body: 'bad request' })).fetch });
    const error = (await agent.send(GRAB).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ agent: 'teams', code: 'remoteError', status: 400 });
    expect(error.message).not.toContain('secretSig456');
    expect(error.message).not.toContain('logic.example.com');
    const denied = new TeamsAgent(TeamsSettings.parse({ webhookUrl: HOOK }), { fetch: fakeFetch(() => ({ status: 401 })).fetch });
    await expect(denied.test()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('validates settings', () => {
    expect(TeamsSettings.safeParse({}).success).toBe(false);
    expect(TeamsSettings.safeParse({ webhookUrl: 'not a url' }).success).toBe(false);
    expect(TeamsSettings.safeParse({ webhookUrl: HOOK }).success).toBe(true);
  });
});
