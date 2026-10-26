/**
 * Test support: an in-memory Transmission daemon behind a fake `fetch`, enforcing HTTP Basic
 * auth and the X-Transmission-Session-Id handshake. Not exported from the package entry point.
 */
import { FakeHttpServer, type FakeHttpReply, type FakeRequest } from '../fake-http.js';
import { fromBase64 } from '../http.js';
import { hashFromMagnet, hashFromTorrentFile } from '../torrent-hash.js';
import { SESSION_ID_HEADER } from './rpc.js';

export const RPC_PATH = '/transmission/rpc';

export type RawTorrent = Record<string, unknown> & { hashString: string };

export interface RpcCall {
  method: string;
  arguments: Record<string, unknown>;
  sessionId: string | null;
}

export class FakeTransmission extends FakeHttpServer {
  /** Session id the daemon currently accepts. Change it to simulate a restart. */
  sessionId = 'session-1';
  username = 'admin';
  password = 'secret';
  requireAuth = true;
  session: Record<string, unknown>;
  torrents: RawTorrent[];
  /** Successful (post-handshake) RPC calls, in order. */
  readonly rpcCalls: RpcCall[] = [];
  /** Methods that answer with a non-success `result` string. */
  readonly failures = new Map<string, string>();

  constructor(session: Record<string, unknown>, torrents: RawTorrent[] = []) {
    super();
    this.session = { ...session };
    this.torrents = torrents.map((t) => ({ ...t }));
    this.guard = (request) => this.checkAccess(request);
    this.on('POST', RPC_PATH, (request) => this.handle(request));
  }

  rpc(method: string): RpcCall[] {
    return this.rpcCalls.filter((c) => c.method === method);
  }

  private checkAccess(request: FakeRequest): FakeHttpReply | undefined {
    if (this.requireAuth) {
      const auth = request.headers.get('authorization') ?? '';
      const expected = `Basic ${btoa(`${this.username}:${this.password}`)}`;
      if (auth !== expected) return { status: 401, body: '<h1>401: Unauthorized</h1>' };
    }
    if (request.headers.get(SESSION_ID_HEADER) !== this.sessionId) {
      return {
        status: 409,
        headers: { [SESSION_ID_HEADER]: this.sessionId },
        body: `<h1>409: Conflict</h1><p><code>${SESSION_ID_HEADER}: ${this.sessionId}</code></p>`,
      };
    }
    return undefined;
  }

  private async handle(request: FakeRequest): Promise<FakeHttpReply> {
    const parsed = JSON.parse(request.bodyText) as { method: string; arguments?: Record<string, unknown> };
    const args = parsed.arguments ?? {};
    this.rpcCalls.push({ method: parsed.method, arguments: args, sessionId: request.headers.get(SESSION_ID_HEADER) });
    const failure = this.failures.get(parsed.method);
    if (failure !== undefined) return { body: { result: failure, arguments: {} } };
    const ok = (out: Record<string, unknown> = {}): FakeHttpReply => ({ body: { result: 'success', arguments: out } });

    switch (parsed.method) {
      case 'session-get':
        return ok(this.session);
      case 'session-set':
        Object.assign(this.session, args);
        return ok();
      case 'torrent-get':
        return ok({ torrents: this.select(args['ids']) });
      case 'torrent-add':
        return ok(await this.add(args));
      case 'torrent-remove': {
        const ids = new Set(this.select(args['ids']).map((t) => t.hashString));
        this.torrents = this.torrents.filter((t) => !ids.has(t.hashString));
        return ok();
      }
      case 'torrent-set': {
        const { ids, ...rest } = args;
        for (const t of this.select(ids)) Object.assign(t, rest);
        return ok();
      }
      case 'torrent-start':
        for (const t of this.select(args['ids'])) t['status'] = 4;
        return ok();
      case 'torrent-stop':
        for (const t of this.select(args['ids'])) t['status'] = 0;
        return ok();
      case 'queue-move-top':
        return ok();
      default:
        return { body: { result: 'method name not recognized', arguments: {} } };
    }
  }

  private select(ids: unknown): RawTorrent[] {
    if (!Array.isArray(ids)) return this.torrents;
    const wanted = new Set(ids.map((id) => String(id).toLowerCase()));
    return this.torrents.filter((t) => wanted.has(t.hashString.toLowerCase()));
  }

  private async add(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let hash: string | undefined;
    if (typeof args['metainfo'] === 'string') hash = await hashFromTorrentFile(fromBase64(args['metainfo']));
    else if (typeof args['filename'] === 'string') hash = hashFromMagnet(args['filename']);
    if (hash === undefined) throw new Error('fake transmission: no torrent in torrent-add');
    const existing = this.torrents.find((t) => t.hashString === hash);
    const name = `Added ${hash.slice(0, 8)}`;
    if (existing) return { 'torrent-duplicate': { hashString: hash, id: 1, name: existing['name'] } };
    this.torrents.push({
      hashString: hash,
      name,
      downloadDir: typeof args['download-dir'] === 'string' ? args['download-dir'] : this.session['download-dir'],
      labels: Array.isArray(args['labels']) ? args['labels'] : [],
      status: args['paused'] === true ? 0 : 4,
      totalSize: 0,
      leftUntilDone: 0,
      percentDone: 0,
      eta: -1,
    });
    return { 'torrent-added': { hashString: hash, id: this.torrents.length, name } };
  }
}
