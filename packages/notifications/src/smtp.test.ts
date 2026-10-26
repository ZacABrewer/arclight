import { describe, expect, it } from 'vitest';
import { SmtpReplyParser, dotStuff, sendMail } from './smtp.js';
import { fakeSmtp } from './test-utils.js';

const MESSAGE = 'Subject: hi\r\n\r\nhello\r\n.leading dot\r\n';

describe('SmtpReplyParser', () => {
  it('assembles multi-line replies and tolerates split chunks', () => {
    const parser = new SmtpReplyParser();
    expect(parser.push('250-smtp.example\r\n250-SIZE 1000')).toEqual([]);
    expect(parser.push('0\r\n250 AUTH PLAIN LOGIN\r\n220 go\r\n')).toEqual([
      { code: 250, lines: ['smtp.example', 'SIZE 10000', 'AUTH PLAIN LOGIN'] },
      { code: 220, lines: ['go'] },
    ]);
  });
});

describe('dotStuff', () => {
  it('doubles leading dots on each line', () => {
    expect(dotStuff('a\r\n.b\r\n..c\r\nd.')).toBe('a\r\n..b\r\n...c\r\nd.');
    expect(dotStuff('.first')).toBe('..first');
  });
});

describe('sendMail', () => {
  it('runs EHLO, STARTTLS, re-EHLO, AUTH PLAIN, envelope, DATA and QUIT', async () => {
    const server = fakeSmtp([
      '250-smtp.example\r\n250-STARTTLS\r\n250 8BITMIME\r\n', // EHLO
      '220 Ready to start TLS\r\n', // STARTTLS
      '250-smtp.example\r\n250 AUTH PLAIN LOGIN\r\n', // EHLO again
      '235 Authentication successful\r\n', // AUTH PLAIN
      '250 OK\r\n', // MAIL FROM
      '250 OK\r\n', // RCPT TO 1
      '251 User not local; will forward\r\n', // RCPT TO 2
      '354 End data with <CR><LF>.<CR><LF>\r\n', // DATA
      '250 OK: queued\r\n', // message
      '221 Bye\r\n', // QUIT
    ]);
    await sendMail(server.connect, {
      host: 'smtp.example',
      port: 587,
      security: 'starttls',
      username: 'alice',
      password: 'pw',
      from: 'mt@example.com',
      recipients: ['a@example.com', 'b@example.org'],
      message: MESSAGE,
    });

    expect(server.options).toEqual([{ host: 'smtp.example', port: 587, tls: false }]);
    const conn = server.connections[0]!;
    expect(conn.tlsStarted).toBe(true);
    expect(conn.closed).toBe(true);
    expect(conn.commands()).toEqual([
      'EHLO media-tron',
      'STARTTLS',
      'EHLO media-tron',
      `AUTH PLAIN ${Buffer.from('\0alice\0pw').toString('base64')}`,
      'MAIL FROM:<mt@example.com>',
      'RCPT TO:<a@example.com>',
      'RCPT TO:<b@example.org>',
      'DATA',
      'Subject: hi\r\n\r\nhello\r\n..leading dot\r\n\r\n.',
      'QUIT',
    ]);
    // STARTTLS must happen before credentials are sent.
    expect(conn.commands().indexOf('STARTTLS')).toBeLessThan(conn.commands().findIndex((c) => c.startsWith('AUTH')));
  });

  it('falls back to AUTH LOGIN when the server only advertises LOGIN, over implicit TLS', async () => {
    const server = fakeSmtp([
      '250-smtp.example\r\n250 AUTH LOGIN\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '235 ok\r\n',
      '250 ok\r\n',
      '250 ok\r\n',
      '354 go\r\n',
      '250 queued\r\n',
      '221 bye\r\n',
    ]);
    await sendMail(server.connect, {
      host: 'smtp.example',
      port: 465,
      security: 'tls',
      username: 'bob',
      password: 'secret',
      from: 'mt@example.com',
      recipients: ['a@example.com'],
      message: MESSAGE,
    });
    expect(server.options[0]).toMatchObject({ tls: true, port: 465 });
    const conn = server.connections[0]!;
    expect(conn.tlsStarted).toBe(false);
    expect(conn.commands().slice(0, 4)).toEqual([
      'EHLO media-tron',
      'AUTH LOGIN',
      Buffer.from('bob').toString('base64'),
      Buffer.from('secret').toString('base64'),
    ]);
  });

  it('skips AUTH without a username and sends in plaintext when security is none', async () => {
    const server = fakeSmtp(['250 smtp.example\r\n', '250 ok\r\n', '250 ok\r\n', '354 go\r\n', '250 queued\r\n', '221 bye\r\n']);
    await sendMail(server.connect, { host: 'relay', port: 25, security: 'none', from: 'a@b.c', recipients: ['x@y.z'], message: MESSAGE });
    const commands = server.connections[0]!.commands();
    expect(commands.some((c) => c.startsWith('AUTH'))).toBe(false);
    expect(commands[1]).toBe('MAIL FROM:<a@b.c>');
  });

  it('maps a 535 to unauthorized and other unexpected codes to smtp errors', async () => {
    const badAuth = fakeSmtp(['250-x\r\n250 AUTH PLAIN\r\n', '535 5.7.8 Authentication credentials invalid\r\n']);
    await expect(
      sendMail(badAuth.connect, { host: 'h', port: 25, security: 'none', username: 'u', password: 'p', from: 'a@b.c', recipients: ['x@y.z'], message: MESSAGE }),
    ).rejects.toMatchObject({ agent: 'email', code: 'unauthorized', status: 535, message: expect.stringContaining('AUTH PLAIN failed: 535') });
    expect(badAuth.connections[0]!.closed).toBe(true);

    const badRcpt = fakeSmtp(['250 x\r\n', '250 ok\r\n', '550 No such user\r\n']);
    await expect(
      sendMail(badRcpt.connect, { host: 'h', port: 25, security: 'none', from: 'a@b.c', recipients: ['x@y.z'], message: MESSAGE }),
    ).rejects.toMatchObject({ code: 'smtp', status: 550, message: expect.stringContaining('RCPT TO <x@y.z> failed: 550 No such user') });

    const noStartTls = fakeSmtp(['250 x\r\n']);
    await expect(
      sendMail(noStartTls.connect, { host: 'h', port: 25, security: 'starttls', from: 'a@b.c', recipients: ['x@y.z'], message: MESSAGE }),
    ).rejects.toMatchObject({ code: 'smtp', message: expect.stringContaining('STARTTLS') });
  });

  it('reports connection failures as network errors', async () => {
    const connect = async (): Promise<never> => {
      throw new Error('ECONNREFUSED');
    };
    await expect(sendMail(connect, { host: 'h', port: 25, security: 'none', from: 'a@b.c', recipients: ['x@y.z'], message: MESSAGE })).rejects.toMatchObject({
      code: 'network',
      message: expect.stringContaining('ECONNREFUSED'),
    });
  });
});
