/**
 * Test support: an in-memory rTorrent behind an XML-RPC-over-HTTP endpoint, built on the
 * generic FakeHttpServer. Not exported from the package entry point.
 *
 * Torrents are records keyed by rTorrent command names without the trailing "="
 * (`d.hash`, `d.state`, ...), which is also the shape of fixtures/rtorrent/torrents.json.
 */
import { basicAuth } from '../http.js';
import { FakeHttpServer, type FakeHttpReply, type FakeRequest } from '../fake-http.js';
import { hashFromMagnet, hashFromTorrentFile } from '../torrent-hash.js';
import { decodeMethodCall, encodeFault, encodeMethodResponse, type XmlRpcDecoded, type XmlRpcValue } from './xmlrpc.js';

export type FakeTorrent = Record<string, string | number>;

export interface FakeCall {
  method: string;
  params: XmlRpcDecoded[];
}

const XML_HEADERS = { 'content-type': 'text/xml' };

/** Splits `d.custom1.set="value"` into the field and its unquoted value. */
export function parseLoadCommand(command: string): { field: string; value: string } | undefined {
  const match = /^(d\.[\w.]+)\.set=(.*)$/s.exec(command);
  if (!match) return undefined;
  const field = match[1] ?? '';
  let value = match[2] ?? '';
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return { field, value };
}

export class FakeRTorrent extends FakeHttpServer {
  readonly torrents = new Map<string, FakeTorrent>();
  readonly rpcCalls: FakeCall[] = [];
  clientVersion = '0.9.8';
  libraryVersion = '0.13.8';
  defaultDirectory = '/downloads';
  /** Basic auth credentials the web server demands; undefined means no auth. */
  credentials: { username: string; password: string } | undefined;
  /** When true, load.* accepts the call but never adds anything (rTorrent's silent failure). */
  dropLoads = false;
  /** Number of d.hash lookups for a freshly loaded torrent that still answer "not found". */
  appearAfterPolls = 0;

  private pendingPolls = new Map<string, number>();

  constructor(
    torrents: FakeTorrent[] = [],
    /** Endpoint path. */
    readonly rpcPath = '/RPC2',
  ) {
    super();
    for (const t of torrents) this.torrents.set(String(t['d.hash']).toUpperCase(), { ...t });
    this.guard = (request) => {
      if (this.credentials === undefined) return undefined;
      const expected = basicAuth(this.credentials.username, this.credentials.password);
      return request.headers.get('authorization') === expected
        ? undefined
        : { status: 401, body: 'Unauthorized', headers: { 'www-authenticate': 'Basic realm="rtorrent"' } };
    };
    this.on('POST', this.rpcPath, (request) => this.handle(request));
  }

  callsTo(method: string): FakeCall[] {
    return this.rpcCalls.filter((c) => c.method === method);
  }

  private async handle(request: FakeRequest): Promise<FakeHttpReply> {
    const { method, params } = decodeMethodCall(request.bodyText);
    this.rpcCalls.push({ method, params });
    try {
      const result = await this.dispatch(method, params);
      return { body: encodeMethodResponse(result), headers: XML_HEADERS };
    } catch (error) {
      if (error instanceof FakeFault) return { body: encodeFault(error.code, error.message), headers: XML_HEADERS };
      throw error;
    }
  }

  private torrentFor(params: XmlRpcDecoded[]): FakeTorrent {
    const hash = typeof params[0] === 'string' ? params[0].toUpperCase() : '';
    const torrent = this.torrents.get(hash);
    const pending = this.pendingPolls.get(hash) ?? 0;
    if (torrent === undefined || pending > 0) {
      if (pending > 0) this.pendingPolls.set(hash, pending - 1);
      throw new FakeFault(-501, 'Could not find info-hash.');
    }
    return torrent;
  }

  private async dispatch(method: string, params: XmlRpcDecoded[]): Promise<XmlRpcValue> {
    switch (method) {
      case 'system.client_version':
        return this.clientVersion;
      case 'system.library_version':
        return this.libraryVersion;
      case 'directory.default':
        return this.defaultDirectory;
      case 'load.raw':
      case 'load.raw_start':
      case 'load.normal':
      case 'load.start':
        await this.load(method, params);
        return 0;
      case 'd.multicall2':
        return this.multicall(params);
      case 'd.hash':
        return String(this.torrentFor(params)['d.hash']);
      case 'd.custom1.set':
      case 'd.custom5.set': {
        const torrent = this.torrentFor(params);
        torrent[method.slice(0, -'.set'.length)] = typeof params[1] === 'string' ? params[1] : '';
        return 0;
      }
      case 'd.erase': {
        const torrent = this.torrentFor(params);
        this.torrents.delete(String(torrent['d.hash']).toUpperCase());
        return 0;
      }
      case 'd.start':
        this.torrentFor(params)['d.state'] = 1;
        return 0;
      case 'd.stop':
        this.torrentFor(params)['d.state'] = 0;
        return 0;
      case 'd.pause':
        this.torrentFor(params)['d.is_active'] = 0;
        return 0;
      case 'd.resume': {
        const torrent = this.torrentFor(params);
        if (torrent['d.state'] === 1) torrent['d.is_active'] = 1;
        return 0;
      }
      default:
        throw new FakeFault(-506, `Method '${method}' not defined`);
    }
  }

  private async load(method: string, params: XmlRpcDecoded[]): Promise<void> {
    if (params[0] !== '') throw new FakeFault(-503, 'Wrong object type.');
    if (this.dropLoads) return;
    const data = params[1];
    let hash: string | undefined;
    if (data instanceof Uint8Array) {
      try {
        hash = await hashFromTorrentFile(data);
      } catch {
        return; // rTorrent logs bad torrents and still answers 0.
      }
    } else if (typeof data === 'string') {
      hash = hashFromMagnet(data);
    }
    if (hash === undefined) return;
    const upper = hash.toUpperCase();
    const started = method === 'load.raw_start' || method === 'load.start' ? 1 : 0;
    const torrent: FakeTorrent = {
      'd.hash': upper,
      'd.name': upper,
      'd.state': started,
      'd.is_active': started,
      'd.is_open': 1,
      'd.directory': this.defaultDirectory,
    };
    for (const command of params.slice(2)) {
      if (typeof command !== 'string') continue;
      const parsed = parseLoadCommand(command);
      if (parsed !== undefined) torrent[parsed.field] = parsed.value;
    }
    this.torrents.set(upper, torrent);
    if (this.appearAfterPolls > 0) this.pendingPolls.set(upper, this.appearAfterPolls);
  }

  private multicall(params: XmlRpcDecoded[]): XmlRpcValue {
    if (params[0] !== '' || params[1] !== 'main') throw new FakeFault(-503, 'Wrong object type.');
    const fields = params.slice(2).map((f) => (typeof f === 'string' ? f.replace(/=$/, '') : ''));
    return [...this.torrents.values()].map((torrent) =>
      fields.map((field): XmlRpcValue => {
        const value = torrent[field];
        if (value !== undefined) return value;
        return field === 'd.hash' || field === 'd.name' || field === 'd.custom1' || field === 'd.base_path' ||
          field === 'd.directory' || field === 'd.message'
          ? ''
          : 0;
      }),
    );
  }
}

class FakeFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
