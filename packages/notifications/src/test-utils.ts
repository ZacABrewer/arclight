/** Fakes shared by the tests: fetch, SMTP connection, child process. Not exported from index. */

import { EventEmitter } from 'node:events';
import type { FetchLike } from './http.js';
import type { SmtpConnect, SmtpConnection, SmtpReply } from './smtp.js';
import { SmtpReplyParser } from './smtp.js';
import type { ChildLike, SpawnLike } from './agents/custom-script.js';

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
