/**
 * A deliberately small SMTP client: EHLO, STARTTLS or implicit TLS, AUTH PLAIN/LOGIN, one
 * message, QUIT. The conversation is written against the `SmtpConnection` interface so tests
 * drive it with a scripted fake instead of a socket.
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { NotificationError } from './types.js';

export interface SmtpReply {
  code: number;
  /** Text of each reply line without the code and separator. */
  lines: string[];
}

export interface SmtpConnection {
  write(data: string): void;
  /** Next complete (possibly multi-line) server reply. Rejects on close/error/timeout. */
  readReply(): Promise<SmtpReply>;
  /** Upgrade the open connection to TLS (after a 220 to STARTTLS). */
  startTls(): Promise<void>;
  close(): void;
}

export interface SmtpConnectOptions {
  host: string;
  port: number;
  /** Encrypt from the first byte (implicit TLS, port 465). */
  tls: boolean;
  timeoutMs: number;
}

export type SmtpConnect = (options: SmtpConnectOptions) => Promise<SmtpConnection>;

export interface SmtpSendOptions {
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'tls';
  username?: string | undefined;
  password?: string | undefined;
  from: string;
  recipients: string[];
  /** Full RFC 5322 message with CRLF line endings. */
  message: string;
  timeoutMs?: number;
  /** Name sent in EHLO. */
  clientName?: string;
}

const REPLY_LINE = /^(\d{3})([ -])(.*)$/;

/** Parses a buffered stream of SMTP reply lines into complete replies. */
export class SmtpReplyParser {
  private buffer = '';
  private pending: string[] = [];

  /** Feed raw bytes; returns every reply completed by this chunk. */
  push(chunk: string): SmtpReply[] {
    this.buffer += chunk;
    const replies: SmtpReply[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      const match = REPLY_LINE.exec(line);
      if (!match) {
        this.pending.push(line);
        continue;
      }
      this.pending.push(match[3] ?? '');
      if (match[2] === ' ') {
        replies.push({ code: Number(match[1]), lines: this.pending });
        this.pending = [];
      }
    }
    return replies;
  }
}

class SocketConnection implements SmtpConnection {
  private socket: Socket;
  private readonly parser = new SmtpReplyParser();
  private readonly ready: SmtpReply[] = [];
  private readonly waiting: Array<{ resolve: (r: SmtpReply) => void; reject: (e: Error) => void }> = [];
  private failure: Error | undefined;

  constructor(
    socket: Socket,
    private readonly host: string,
    private readonly timeoutMs: number,
  ) {
    this.socket = socket;
    this.attach(socket);
  }

  write(data: string): void {
    this.socket.write(data);
  }

  readReply(): Promise<SmtpReply> {
    const queued = this.ready.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  startTls(): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('close');
      plain.removeAllListeners('error');
      plain.removeAllListeners('timeout');
      const secure = tlsConnect({ socket: plain, servername: this.host }, () => {
        this.socket = secure;
        this.attach(secure);
        resolve();
      });
      secure.once('error', (error: Error) => reject(error));
    });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }

  private attach(socket: Socket): void {
    socket.setEncoding('utf8');
    socket.setTimeout(this.timeoutMs);
    socket.on('data', (chunk: string) => {
      for (const reply of this.parser.push(chunk)) {
        const waiter = this.waiting.shift();
        if (waiter) waiter.resolve(reply);
        else this.ready.push(reply);
      }
    });
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('timeout', () => this.fail(new Error('SMTP connection timed out')));
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }
}

/** Production connection factory over node:net / node:tls. */
export const connectSmtp: SmtpConnect = ({ host, port, tls, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    if (tls) {
      const socket = tlsConnect({ host, port, servername: host }, () => {
        socket.off('error', onError);
        resolve(new SocketConnection(socket, host, timeoutMs));
      });
      socket.once('error', onError);
    } else {
      const socket = netConnect({ host, port }, () => {
        socket.off('error', onError);
        resolve(new SocketConnection(socket, host, timeoutMs));
      });
      socket.once('error', onError);
    }
  });

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** Lines starting with "." must be doubled inside DATA (RFC 5321 4.5.2). */
export function dotStuff(message: string): string {
  return message.replace(/(^|\r\n)\./g, '$1..');
}

export async function sendMail(connect: SmtpConnect, options: SmtpSendOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const clientName = options.clientName ?? 'arclight';
  let connection: SmtpConnection;
  try {
    connection = await connect({ host: options.host, port: options.port, tls: options.security === 'tls', timeoutMs });
  } catch (error) {
    throw new NotificationError('email', 'network', `Could not connect to ${options.host}:${options.port}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  const expect = async (accepted: number[], context: string): Promise<SmtpReply> => {
    let reply: SmtpReply;
    try {
      reply = await connection.readReply();
    } catch (error) {
      throw new NotificationError('email', 'network', `Connection lost while waiting for ${context}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    if (!accepted.includes(reply.code)) {
      const code = reply.code === 535 || reply.code === 530 ? 'unauthorized' : 'smtp';
      throw new NotificationError('email', code, `SMTP ${context} failed: ${reply.code} ${reply.lines.join(' ')}`.trim(), {
        status: reply.code,
      });
    }
    return reply;
  };
  const command = async (line: string, accepted: number[], context = line.split(' ')[0] ?? line): Promise<SmtpReply> => {
    connection.write(`${line}\r\n`);
    return expect(accepted, context);
  };

  try {
    await expect([220], 'greeting');
    let ehlo = await command(`EHLO ${clientName}`, [250]);

    if (options.security === 'starttls') {
      if (!hasExtension(ehlo, 'STARTTLS')) {
        throw new NotificationError('email', 'smtp', 'Server does not offer STARTTLS; choose a different security mode');
      }
      await command('STARTTLS', [220]);
      try {
        await connection.startTls();
      } catch (error) {
        throw new NotificationError('email', 'network', `TLS handshake failed: ${(error as Error).message}`, { cause: error });
      }
      ehlo = await command(`EHLO ${clientName}`, [250]);
    }

    if (options.username) {
      const password = options.password ?? '';
      const mechanisms = authMechanisms(ehlo);
      if (mechanisms.includes('PLAIN') || !mechanisms.includes('LOGIN')) {
        await command(`AUTH PLAIN ${b64(`\0${options.username}\0${password}`)}`, [235], 'AUTH PLAIN');
      } else {
        await command('AUTH LOGIN', [334]);
        await command(b64(options.username), [334], 'AUTH LOGIN username');
        await command(b64(password), [235], 'AUTH LOGIN password');
      }
    }

    await command(`MAIL FROM:<${options.from}>`, [250], 'MAIL FROM');
    for (const recipient of options.recipients) {
      await command(`RCPT TO:<${recipient}>`, [250, 251], `RCPT TO <${recipient}>`);
    }
    await command('DATA', [354]);
    connection.write(`${dotStuff(options.message)}\r\n.\r\n`);
    await expect([250], 'message body');
    connection.write('QUIT\r\n');
    await connection.readReply().catch(() => undefined);
  } finally {
    connection.close();
  }
}

function hasExtension(ehlo: SmtpReply, name: string): boolean {
  return ehlo.lines.slice(1).some((l) => l.toUpperCase().split(' ')[0] === name);
}

function authMechanisms(ehlo: SmtpReply): string[] {
  for (const line of ehlo.lines.slice(1)) {
    const upper = line.toUpperCase();
    if (upper.startsWith('AUTH ') || upper.startsWith('AUTH=')) return upper.slice(5).split(/[\s=]+/).filter(Boolean);
  }
  return [];
}
