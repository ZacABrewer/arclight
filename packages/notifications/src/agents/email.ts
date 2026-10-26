import { randomBytes } from 'node:crypto';
import { formatEvent } from '../format.js';
import type { EmailSettings } from '../settings.js';
import { connectSmtp, sendMail, type SmtpConnect } from '../smtp.js';
import type { NotificationEvent } from '../types.js';
import { BaseAgent, MESSAGE_EVENTS, type AgentDeps } from './base.js';

export interface MailMessage {
  from: string;
  recipients: string[];
  subject: string;
  /** Full RFC 5322 message, CRLF line endings. */
  raw: string;
}

/** RFC 2047 "B" encoding for header values that are not plain ASCII. */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrap76(base64: string): string {
  return base64.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

export class EmailAgent extends BaseAgent {
  readonly kind = 'email' as const;
  readonly supportedEvents = MESSAGE_EVENTS;
  private readonly connect: SmtpConnect;

  constructor(
    private readonly settings: EmailSettings,
    deps: AgentDeps = {},
  ) {
    super(deps);
    this.connect = deps.connect ?? connectSmtp;
  }

  buildMessage(event: NotificationEvent): MailMessage {
    const formatted = formatEvent(event);
    const subject = `${this.settings.subjectPrefix} ${formatted.subject}: ${formatted.title}`.trim();
    const text = `${formatted.title}\r\n\r\n${formatted.body.replace(/\r?\n/g, '\r\n')}\r\n`;
    const domain = this.settings.from.split('@')[1] ?? 'arclight';
    const headers = [
      `From: ${encodeHeaderValue(event.instanceName)} <${this.settings.from}>`,
      `To: ${this.settings.to.join(', ')}`,
      ...(this.settings.cc.length > 0 ? [`Cc: ${this.settings.cc.join(', ')}`] : []),
      `Subject: ${encodeHeaderValue(subject)}`,
      `Date: ${this.now().toUTCString()}`,
      `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      'X-Mailer: Arclight',
    ];
    const raw = `${headers.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(text, 'utf8').toString('base64'))}`;
    return {
      from: this.settings.from,
      recipients: [...new Set([...this.settings.to, ...this.settings.cc, ...this.settings.bcc])],
      subject,
      raw,
    };
  }

  protected async deliver(event: NotificationEvent): Promise<void> {
    const message = this.buildMessage(event);
    await sendMail(this.connect, {
      host: this.settings.host,
      port: this.settings.port,
      security: this.settings.security,
      username: this.settings.username,
      password: this.settings.password,
      from: message.from,
      recipients: message.recipients,
      message: message.raw,
    });
  }
}
