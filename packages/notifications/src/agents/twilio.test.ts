import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE } from '../../fixtures/events.js';
import { fakeFetch } from '../test-utils.js';
import { TWILIO_BODY_LIMIT, TwilioAgent, TwilioSettings } from './twilio.js';

const SID = `AC${'0'.repeat(32)}`;
const TOKEN = 'twilioAuthToken987';
const BASE = { accountSid: SID, authToken: TOKEN, from: '+15550100', to: ['+15550101', '+15550102'] };
const CREATED = { status: 201, json: { sid: 'SM1', status: 'queued' } };
const TEMPLATES = { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } };

describe('TwilioAgent', () => {
  it('posts one message per recipient with basic auth', async () => {
    const http = fakeFetch(() => CREATED);
    const agent = new TwilioAgent(TwilioSettings.parse(BASE), { fetch: http.fetch });
    await agent.send(GRAB);

    expect(http.calls).toHaveLength(2);
    const call = http.calls[0]!;
    expect(call.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.body);
    expect(form.get('To')).toBe('+15550101');
    expect(form.get('From')).toBe('+15550100');
    const body = form.get('Body')!;
    expect(body.startsWith('Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave\nEpisode Grabbed')).toBe(true);
    expect(body.endsWith('\nhttps://mt.example.com/series/7')).toBe(true);
    expect(body.split('https://mt.example.com/series/7')).toHaveLength(2);
    expect(form.has('MediaUrl')).toBe(false);
    expect(new URLSearchParams(http.calls[1]!.body).get('To')).toBe('+15550102');
  });

  it('prefixes WhatsApp addresses, attaches the poster, and uses a messaging service', () => {
    const wa = new TwilioAgent(TwilioSettings.parse({ ...BASE, to: ['+15550101'], channel: 'whatsapp', attachPoster: true, includeLink: false }));
    const [form] = wa.buildForms(GRAB);
    expect(form).toMatchObject({ To: 'whatsapp:+15550101', From: 'whatsapp:+15550100', MediaUrl: 'https://img.example/poster.jpg' });
    expect(form!.Body).not.toContain('https://mt.example.com');

    const mg = `MG${'a'.repeat(32)}`;
    const [service] = new TwilioAgent(TwilioSettings.parse({ ...BASE, from: mg })).buildForms(HEALTH_ISSUE);
    expect(service!.MessagingServiceSid).toBe(mg);
    expect(service!.From).toBeUndefined();
  });

  it('clips the body and applies templates', () => {
    const agent = new TwilioAgent(TwilioSettings.parse(BASE));
    const long = agent.buildForms({ ...HEALTH_ISSUE, health: { ...HEALTH_ISSUE.health, message: 'x'.repeat(3000) } });
    expect(long[0]!.Body!.length).toBe(TWILIO_BODY_LIMIT);
    const linked = agent.buildForms({ ...GRAB, media: { ...GRAB.media, overview: 'y'.repeat(300) }, release: { ...GRAB.release, title: 'z'.repeat(1700) } });
    expect(linked[0]!.Body!.length).toBe(TWILIO_BODY_LIMIT);
    expect(linked[0]!.Body!.endsWith('\nhttps://mt.example.com/series/7')).toBe(true);

    const [templated] = new TwilioAgent(TwilioSettings.parse(BASE), { templates: TEMPLATES }).buildForms(GRAB);
    expect(templated!.Body).toBe('T Signal Lost\nB WEBDL-1080p\nhttps://mt.example.com/series/7');
  });

  it('attempts every recipient and aggregates failures without leaking the token', async () => {
    const http = fakeFetch((call) =>
      new URLSearchParams(call.body).get('To') === '+15550101'
        ? { status: 400, json: { code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 } }
        : CREATED,
    );
    const agent = new TwilioAgent(TwilioSettings.parse({ ...BASE, to: ['+15550101', '+15550102'] }), { fetch: http.fetch });
    const error = await agent.send(GRAB).then(() => new Error('resolved'), (e: unknown) => e as Error);
    expect(http.calls).toHaveLength(2);
    expect(error).toMatchObject({ agent: 'twilio', code: 'remoteError', status: 400 });
    expect(error.message).toContain('1 of 2');
    expect(error.message).toContain('+15550101');
    expect(error.message).not.toContain(TOKEN);

    const denied = new TwilioAgent(TwilioSettings.parse(BASE), { fetch: fakeFetch(() => ({ status: 401, json: { code: 20003 } })).fetch });
    await expect(denied.send(GRAB)).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringContaining('2 of 2') });
  });

  it('validates settings', () => {
    expect(TwilioSettings.safeParse({ ...BASE, accountSid: 'XX123' }).success).toBe(false);
    expect(TwilioSettings.safeParse({ ...BASE, from: '5550100' }).success).toBe(false);
    expect(TwilioSettings.safeParse({ ...BASE, to: [] }).success).toBe(false);
    expect(TwilioSettings.safeParse({ ...BASE, to: ['555-0101'] }).success).toBe(false);
    expect(TwilioSettings.parse(BASE)).toMatchObject({ channel: 'sms', includeLink: true, attachPoster: false });
  });
});
