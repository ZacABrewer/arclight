import { describe, expect, it } from 'vitest';
import { GRAB, HEALTH_ISSUE, IMPORT } from '../../fixtures/events.js';
import { createAgent } from '../index.js';
import { fakeSmtp } from '../test-utils.js';
import { EmailAgent, encodeHeaderValue } from './email.js';

const SETTINGS = {
  host: 'smtp.example',
  port: 587,
  username: 'mt',
  password: 'pw',
  from: 'mt@example.com',
  to: ['a@example.com'],
  cc: ['c@example.com'],
  bcc: ['hidden@example.com'],
};

const OK_SCRIPT = [
  '250-smtp.example\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n',
  '220 go\r\n',
  '250-smtp.example\r\n250 AUTH PLAIN\r\n',
  '235 ok\r\n',
  '250 ok\r\n',
  '250 ok\r\n',
  '250 ok\r\n',
  '250 ok\r\n',
  '354 go\r\n',
  '250 queued\r\n',
  '221 bye\r\n',
];

function decodeBody(raw: string): string {
  const body = raw.split('\r\n\r\n')[1] ?? '';
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('EmailAgent', () => {
  it('builds a grab message with proper headers and a base64 UTF-8 body', () => {
    const agent = new EmailAgent({ ...SETTINGS, security: 'starttls', subjectPrefix: '[MT]' }, { now: () => new Date('2026-10-25T12:00:00Z') });
    const message = agent.buildMessage(GRAB);
    expect(message.subject).toBe('[MT] Episode Grabbed: Signal Lost (2023) - S02E03-E04 - Dead Air + Carrier Wave');
    expect(message.recipients).toEqual(['a@example.com', 'c@example.com', 'hidden@example.com']);

    const headers = message.raw.split('\r\n\r\n')[0]!.split('\r\n');
    expect(headers).toContain('From: Arclight <mt@example.com>');
    expect(headers).toContain('To: a@example.com');
    expect(headers).toContain('Cc: c@example.com');
    expect(headers.some((h) => h.startsWith('Bcc:'))).toBe(false);
    expect(headers).toContain('Date: Sun, 25 Oct 2026 12:00:00 GMT');
    expect(headers).toContain('Content-Type: text/plain; charset=utf-8');
    expect(headers.some((h) => /^Message-ID: <[0-9a-f]{24}@example\.com>$/.test(h))).toBe(true);
    expect(message.raw).not.toContain('\n\n'); // CRLF only
    expect(decodeBody(message.raw)).toContain('Quality: WEBDL-1080p');
  });

  it('encodes non-ASCII subjects and describes imports and health issues', () => {
    const agent = new EmailAgent({ ...SETTINGS, security: 'starttls', subjectPrefix: '[Média]' });
    const imported = agent.buildMessage(IMPORT);
    expect(imported.subject).toBe('[Média] Movie Imported: Harbour Lights (2021)');
    expect(imported.raw).toContain(`Subject: ${encodeHeaderValue(imported.subject)}`);
    expect(imported.raw).toContain('Subject: =?UTF-8?B?');
    expect(decodeBody(imported.raw)).toContain('Path: Harbour Lights (2021) Bluray-1080p.mkv');

    const health = agent.buildMessage(HEALTH_ISSUE);
    expect(health.subject).toBe('[Média] Health Issue: Error: Health Issue: Error');
    expect(decodeBody(health.raw)).toContain('Source: downloadClients');
  });

  it('delivers through the SMTP client with the configured security and recipients', async () => {
    const server = fakeSmtp(OK_SCRIPT);
    const agent = createAgent('email', SETTINGS, { connect: server.connect });
    await agent.send(GRAB);

    expect(server.options).toEqual([{ host: 'smtp.example', port: 587, tls: false }]);
    const commands = server.connections[0]!.commands();
    expect(commands).toContain('STARTTLS');
    expect(commands.filter((c) => c.startsWith('RCPT TO'))).toEqual(['RCPT TO:<a@example.com>', 'RCPT TO:<c@example.com>', 'RCPT TO:<hidden@example.com>']);
    expect(commands.find((c) => c.startsWith('From:'))).toContain('Subject: [Arclight] Episode Grabbed');
  });

  it('surfaces SMTP failures from test()', async () => {
    const server = fakeSmtp(['250-x\r\n250 AUTH PLAIN\r\n', '535 bad credentials\r\n']);
    const agent = createAgent('email', { ...SETTINGS, security: 'none' }, { connect: server.connect });
    await expect(agent.test()).rejects.toMatchObject({ agent: 'email', code: 'unauthorized' });
  });
});
