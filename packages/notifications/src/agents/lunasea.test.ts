import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { fakeFetch } from '../test-utils.js';
import { LunaSeaAgent, LunaSeaSettings } from './lunasea.js';

const SECRET = 'u5er1d0123';
const URL_USER = `https://notify.lunasea.app/v1/custom/user/${SECRET}`;
const TEMPLATES = { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } };

describe('LunaSeaAgent', () => {
  it('posts title, body and poster to the custom URL', async () => {
    const http = fakeFetch();
    await new LunaSeaAgent(LunaSeaSettings.parse({ webhookUrl: URL_USER }), { fetch: http.fetch }).send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe(URL_USER);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.json()).toEqual({
      title: 'Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave',
      body: expect.stringContaining('Episode Grabbed\nQuality: WEBDL-1080p'),
      image: 'https://img.example/poster.jpg',
    });
  });

  it('omits the image without a poster, and applies templates', () => {
    const agent = new LunaSeaAgent(LunaSeaSettings.parse({ webhookUrl: 'https://notify.lunasea.app/v1/custom/device/abc' }));
    expect(agent.buildPayload(HEALTH_ISSUE).image).toBeUndefined();
    const templated = new LunaSeaAgent(LunaSeaSettings.parse({ webhookUrl: URL_USER }), { templates: TEMPLATES }).buildPayload(GRAB);
    expect(templated).toMatchObject({ title: 'T Signal Lost', body: 'B WEBDL-1080p' });
  });

  it('maps a 404 to notFound without leaking the URL id', async () => {
    const agent = new LunaSeaAgent(LunaSeaSettings.parse({ webhookUrl: URL_USER }), { fetch: fakeFetch(() => ({ status: 404, body: 'not found' })).fetch });
    const error = await agent.send(GRAB).then(() => new Error('resolved'), (e: unknown) => e as Error);
    expect(error).toMatchObject({ agent: 'lunasea', code: 'notFound', status: 404, message: 'LunaSea responded 404: not found' });
    expect(error.message).not.toContain(SECRET);
  });

  it('validates settings', () => {
    expect(LunaSeaSettings.safeParse({}).success).toBe(false);
    expect(LunaSeaSettings.safeParse({ webhookUrl: 'https://notify.lunasea.app/v1/sonarr/user/abc' }).success).toBe(false);
    expect(LunaSeaSettings.safeParse({ webhookUrl: 'ftp://notify.lunasea.app/v1/custom/user/abc' }).success).toBe(false);
  });
});
