import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { fakeFetch } from '../test-utils.js';
import { PROWL_URL, ProwlAgent, ProwlSettings } from './prowl.js';

const KEY = 'k'.repeat(40);
const OK_XML = '<?xml version="1.0" encoding="UTF-8"?><prowl><success code="200" remaining="999" resetdate="0" /></prowl>';
const TEMPLATES = { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } };

describe('ProwlAgent', () => {
  it('posts a form-encoded add call', async () => {
    const http = fakeFetch(() => ({ status: 200, body: OK_XML }));
    const agent = new ProwlAgent(ProwlSettings.parse({ apiKey: `${KEY}, ${'j'.repeat(40)}`, priority: 1, providerKey: 'prov' }), { fetch: http.fetch });
    await agent.send(GRAB);

    const call = http.calls[0]!;
    expect(call.url).toBe(PROWL_URL);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.body);
    expect(form.get('apikey')).toBe(`${KEY},${'j'.repeat(40)}`);
    expect(form.get('providerkey')).toBe('prov');
    expect(form.get('application')).toBe('Arclight');
    expect(form.get('event')).toBe('Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave');
    expect(form.get('description')).toContain('Episode Grabbed\nQuality: WEBDL-1080p');
    expect(form.get('priority')).toBe('1');
    expect(form.get('url')).toBe('https://mt.example.com/series/7');
  });

  it('omits the url without a link, clips long text, and applies templates', () => {
    const agent = new ProwlAgent(ProwlSettings.parse({ apiKey: KEY }));
    expect(agent.buildForm(HEALTH_ISSUE).url).toBeUndefined();
    const long = agent.buildForm({ ...HEALTH_ISSUE, instanceName: 'x'.repeat(300) });
    expect(long.application).toHaveLength(256);

    const templated = new ProwlAgent(ProwlSettings.parse({ apiKey: KEY }), { templates: TEMPLATES }).buildForm(GRAB);
    expect(templated.event).toBe('T Signal Lost');
    expect(templated.description).toBe('B WEBDL-1080p');
  });

  it('maps a 401 XML error to unauthorized without leaking the key', async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><prowl><error code="401">Invalid API key</error></prowl>';
    const agent = new ProwlAgent(ProwlSettings.parse({ apiKey: KEY }), { fetch: fakeFetch(() => ({ status: 401, body: xml })).fetch });
    const error = await agent.send(GRAB).then(() => new Error('resolved'), (e: unknown) => e as Error);
    expect(error).toMatchObject({ agent: 'prowl', code: 'unauthorized', status: 401, message: 'Prowl responded 401: Invalid API key' });
    expect(error.message).not.toContain(KEY);
  });

  it('treats an <error> body on a 200 as failure', async () => {
    const xml = '<prowl><error code="406">Not acceptable, your IP address has exceeded the API limit</error></prowl>';
    const agent = new ProwlAgent(ProwlSettings.parse({ apiKey: KEY }), { fetch: fakeFetch(() => ({ status: 200, body: xml })).fetch });
    await expect(agent.send(GRAB)).rejects.toMatchObject({ code: 'rateLimited', message: expect.stringContaining('exceeded the API limit') });
  });

  it('validates settings', () => {
    expect(ProwlSettings.safeParse({}).success).toBe(false);
    expect(ProwlSettings.safeParse({ apiKey: KEY, priority: 3 }).success).toBe(false);
    expect(ProwlSettings.parse({ apiKey: KEY }).priority).toBe(0);
  });
});
