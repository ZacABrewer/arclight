/** Fakes shared by the tests: fetch, SMTP connection, child process. Not exported from index. */

import { EventEmitter } from 'node:events';
import type { FetchLike } from './http.js';
import type { SmtpConnect, SmtpConnection, SmtpReply } from './smtp.js';
import { SmtpReplyParser } from './smtp.js';
import type { ChildLike, SpawnLike } from './agents/custom-script.js';
import type { SocketConnect, SocketLike } from './agents/base.js';
import type { NotificationAgentKind } from './types.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  json(): unknown;
}

export type FakeResponder = (call: RecordedCall) => Response | { status: number; body?: string; json?: unknown };

export interface FakeFetch {
  fetch: FetchLike;
  calls: RecordedCall[];
}

export function fakeFetch(responder: FakeResponder = () => ({ status: 200 })): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body,
      json: () => (body === undefined ? undefined : JSON.parse(body)),
    };
    calls.push(call);
    const result = responder(call);
    if (result instanceof Response) return result;
    const text = result.json !== undefined ? JSON.stringify(result.json) : (result.body ?? '');
    return new Response(text, { status: result.status });
  };
  return { fetch, calls };
}

export function failingFetch(error: Error = new TypeError('fetch failed')): FetchLike {
  return async () => {
    throw error;
  };
}

/**
 * Scripted SMTP server: replies are consumed one per client write, after the greeting.
 * Each reply is raw wire text, e.g. "250-smtp.example\r\n250 AUTH PLAIN LOGIN\r\n".
 */
export class FakeSmtpConnection implements SmtpConnection {
  readonly written: string[] = [];
  tlsStarted = false;
  closed = false;
  private readonly queue: SmtpReply[] = [];
  private readonly parser = new SmtpReplyParser();

  constructor(
    private readonly replies: string[],
    private readonly greeting = '220 smtp.example ESMTP\r\n',
  ) {
    this.enqueue(this.greeting);
  }

  write(data: string): void {
    this.written.push(data);
    const next = this.replies.shift();
    if (next !== undefined) this.enqueue(next);
  }

  readReply(): Promise<SmtpReply> {
    const reply = this.queue.shift();
    return reply ? Promise.resolve(reply) : Promise.reject(new Error('fake server has nothing more to say'));
  }

  startTls(): Promise<void> {
    this.tlsStarted = true;
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
  }

  /** Commands as the server saw them, without CRLF. */
  commands(): string[] {
    return this.written.map((w) => w.replace(/\r\n$/, ''));
  }

  private enqueue(wire: string): void {
    this.queue.push(...this.parser.push(wire));
  }
}

export function fakeSmtp(replies: string[]): { connect: SmtpConnect; connections: FakeSmtpConnection[]; options: Array<{ host: string; port: number; tls: boolean }> } {
  const connections: FakeSmtpConnection[] = [];
  const options: Array<{ host: string; port: number; tls: boolean }> = [];
  const connect: SmtpConnect = async (opts) => {
    options.push({ host: opts.host, port: opts.port, tls: opts.tls });
    const connection = new FakeSmtpConnection([...replies]);
    connections.push(connection);
    return connection;
  };
  return { connect, connections, options };
}

export class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killedWith: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal ?? 'SIGTERM';
    return true;
  }
}

export interface SpawnRecord {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  child: FakeChild;
}

/** `onSpawn` runs after the child is handed back, so it can emit close/error asynchronously. */
export function fakeSpawn(onSpawn: (record: SpawnRecord) => void): { spawn: SpawnLike; records: SpawnRecord[] } {
  const records: SpawnRecord[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    const child = new FakeChild();
    const record = { command, args, env: options.env, child };
    records.push(record);
    queueMicrotask(() => onSpawn(record));
    return child;
  };
  return { spawn, records };
}

/** Minimal valid settings for every agent kind (tests that loop over all of them). */
export const MINIMAL_SETTINGS: Record<NotificationAgentKind, Record<string, unknown>> = {
  discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x' },
  telegram: { botToken: 't', chatId: '1' },
  webhook: { url: 'https://example.com/hook' },
  email: { host: 'smtp.example', from: 'mt@example.com', to: ['ops@example.org'], security: 'none', username: 'u', password: 'p' },
  'custom-script': { path: '/bin/true' },
  ntfy: { topics: ['t'] },
  gotify: { serverUrl: 'http://g', appToken: 'x' },
  pushover: { apiToken: 'a'.repeat(30), userKey: 'b'.repeat(30) },
  jellyfin: { host: 'jf', apiKey: 'k' },
  emby: { host: 'emby', apiKey: 'k', notify: true },
  plex: { host: 'plex', authToken: 't' },
  slack: { webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX' },
  teams: { webhookUrl: 'https://prod.example.com/workflows/abc/triggers/manual/paths/invoke?sig=secretsig123456' },
  matrix: { homeserverUrl: 'https://matrix.example.com', accessToken: 'syt_secret_token', roomId: '!room:example.com' },
  mattermost: { webhookUrl: 'https://chat.example.com/hooks/abcdefghijklmnop' },
  rocketchat: { webhookUrl: 'https://rocket.example.com/hooks/abc/defghijklmnop' },
  googlechat: { webhookUrl: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=tokentokentoken' },
  signal: { serverUrl: 'http://signal.example.com:8080', number: '+15550100', recipients: ['+15550101'], attachPoster: false },
  pushbullet: { accessToken: 'o.secretpushbullet' },
  prowl: { apiKey: 'p'.repeat(40) },
  bark: { deviceKey: 'barkdevicekey' },
  join: { apiKey: 'joinapikey1234' },
  simplepush: { apiKey: 'simplekey' },
  homeassistant: { baseUrl: 'http://ha.example.com:8123', accessToken: 'ha-long-lived-token', mode: 'both' },
  mqtt: { host: 'broker.example.com' },
  twilio: { accountSid: `AC${'0'.repeat(32)}`, authToken: 'twilio-auth-token', from: '+15550100', to: ['+15550101'] },
  apprise: { serverUrl: 'http://apprise.example.com:8000', configKey: 'arclight' },
  notifiarr: { apiKey: 'notifiarr-api-key', channelId: '123456789012345678' },
  lunasea: { webhookUrl: 'https://notify.lunasea.app/v1/custom/user/abcdefghijkl' },
};

/** A fetch responder that answers like each service does on success. */
export function serviceResponder(call: RecordedCall): { status: number; body?: string; json?: unknown } {
  const url = new URL(call.url);
  if (url.pathname === '/library/sections') {
    return { status: 200, json: { MediaContainer: { Directory: [{ key: 1, title: 'Movies', type: 'movie', Location: [{ path: '/movies' }] }] } } };
  }
  if (url.hostname === 'api.telegram.org') return { status: 200, json: { ok: true } };
  if (url.hostname === 'api.day.app') return { status: 200, json: { code: 200, message: 'success' } };
  if (url.hostname === 'joinjoaomgcd.appspot.com') return { status: 200, json: { success: true } };
  if (url.hostname === 'api.simplepush.io') return { status: 200, json: { status: 'OK' } };
  if (url.hostname === 'api.prowlapp.com') return { status: 200, body: '<?xml version="1.0"?><prowl><success code="200" remaining="999"/></prowl>' };
  if (url.hostname === 'api.twilio.com') return { status: 201, json: { sid: 'SM1' } };
  if (url.pathname.includes('/send/m.room.message/')) return { status: 200, json: { event_id: '$1' } };
  return { status: 200, json: {} };
}

/** An in-memory MQTT broker: CONNACK for CONNECT, PUBACK for QoS 1 PUBLISH; records publishes. */
export function fakeMqtt(): { socket: SocketConnect; published: Array<{ topic: string; payload: string }> } {
  const published: Array<{ topic: string; payload: string }> = [];
  const socket: SocketConnect = async () => {
    const listeners: { data: Array<(c: Uint8Array) => void>; close: Array<() => void> } = { data: [], close: [] };
    const reply = (bytes: number[]) => queueMicrotask(() => listeners.data.forEach((l) => l(Uint8Array.from(bytes))));
    return {
      write(data: Uint8Array) {
        const buf = Buffer.from(data);
        const type = buf[0]! >> 4;
        if (type === 1) reply([0x20, 0x02, 0x00, 0x00]);
        if (type === 3) {
          // Fixed header, remaining length (varint), topic, [packet id], payload.
          let i = 1;
          let len = 0;
          let mul = 1;
          for (;;) {
            const b = buf[i++]!;
            len += (b & 0x7f) * mul;
            mul *= 128;
            if ((b & 0x80) === 0) break;
          }
          const topicLen = buf.readUInt16BE(i);
          const topic = buf.subarray(i + 2, i + 2 + topicLen).toString('utf8');
          let p = i + 2 + topicLen;
          const qos = (buf[0]! >> 1) & 0x03;
          let id = 0;
          if (qos > 0) {
            id = buf.readUInt16BE(p);
            p += 2;
          }
          published.push({ topic, payload: buf.subarray(p, i + len).toString('utf8') });
          if (qos > 0) reply([0x40, 0x02, id >> 8, id & 0xff]);
        }
      },
      on(event: string, listener: (...args: never[]) => void) {
        if (event === 'data') listeners.data.push(listener as (c: Uint8Array) => void);
        if (event === 'close') listeners.close.push(listener as () => void);
      },
      end() {
        listeners.close.forEach((l) => l());
      },
      destroy() {},
    } as SocketLike;
  };
  return { socket, published };
}
