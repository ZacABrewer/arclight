/**
 * Test support: an in-memory NZBGet JSON-RPC endpoint on top of FakeHttpServer. Checks HTTP
 * Basic auth like NZBGet (401 on mismatch), dispatches `{method, params}` to stateful handlers
 * and records every call. Not exported from the package entry point.
 */
import { FakeHttpServer, type FakeHttpReply, type FakeRequest } from '../fake-http.js';

export interface FakeRpcCall {
  method: string;
  params: unknown[];
}

export type FakeRpcHandler = (params: unknown[]) => unknown;

/** Loose record shape for queue groups and history records (fixtures are plain JSON). */
export type FakeRecord = Record<string, unknown> & { NZBID: number };

export interface FakeAppend {
  filename: string;
  content: string;
  category: string;
  priority: number;
  addToTop: boolean;
  addPaused: boolean;
  dupeKey: string;
  dupeScore: number;
  dupeMode: string;
  ppParameters: unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class FakeNzbget extends FakeHttpServer {
  username = 'nzbget';
  password = 'tegbzn6789';
  version = '24.3';
  config: Array<{ Name: string; Value: string }> = [];
  groups: FakeRecord[] = [];
  history: FakeRecord[] = [];
  status: Record<string, unknown> = { DownloadRate: 0, DownloadPaused: false };
  readonly rpcCalls: FakeRpcCall[] = [];
  readonly appended: FakeAppend[] = [];
  /** NZBID handed out by the next append; 0 or less simulates a refusal. */
  nextId = 100;

  private readonly overrides = new Map<string, FakeRpcHandler[]>();

  constructor(fixtures: { config?: unknown; groups?: unknown; history?: unknown; status?: unknown } = {}) {
    super();
    if (fixtures.config !== undefined) this.config = clone(fixtures.config) as FakeNzbget['config'];
    if (fixtures.groups !== undefined) this.groups = clone(fixtures.groups) as FakeRecord[];
    if (fixtures.history !== undefined) this.history = clone(fixtures.history) as FakeRecord[];
    if (fixtures.status !== undefined) this.status = clone(fixtures.status) as Record<string, unknown>;

    this.guard = (request) => this.checkAuth(request);
    this.on('POST', '/jsonrpc', (request) => this.dispatch(request));
  }

  /** Replaces the next call of `method` with `handler` (its return value becomes `result`; throw for an RPC error). */
  onceRpc(method: string, handler: FakeRpcHandler): this {
    const list = this.overrides.get(method) ?? [];
    list.push(handler);
    this.overrides.set(method, list);
    return this;
  }

  callsTo(method: string): FakeRpcCall[] {
    return this.rpcCalls.filter((c) => c.method === method);
  }

  setOption(name: string, value: string): void {
    const existing = this.config.find((o) => o.Name === name);
    if (existing) existing.Value = value;
    else this.config.push({ Name: name, Value: value });
  }

  private checkAuth(request: FakeRequest): FakeHttpReply | undefined {
    const expected = `Basic ${btoa(`${this.username}:${this.password}`)}`;
    if (request.headers.get('authorization') !== expected) {
      return { status: 401, body: 'Unauthorized', headers: { 'www-authenticate': 'Basic realm="NZBGet"' } };
    }
    return undefined;
  }

  private dispatch(request: FakeRequest): FakeHttpReply {
    const body = JSON.parse(request.bodyText) as { method: string; params?: unknown[]; id?: unknown };
    const params = body.params ?? [];
    this.rpcCalls.push({ method: body.method, params });
    try {
      const override = this.overrides.get(body.method)?.shift();
      const result = override ? override(params) : this.handle(body.method, params);
      return { body: { version: '1.1', id: body.id, result } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { body: { version: '1.1', id: body.id, error: { name: 'JSONRPCError', code: 1, message } } };
    }
  }

  private handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'version':
        return this.version;
      case 'config':
        return this.config;
      case 'status':
        return this.status;
      case 'listgroups':
        return this.groups;
      case 'history':
        return this.history;
      case 'append':
        return this.append(params);
      case 'editqueue':
        return this.editQueue(params);
      default:
        throw new Error('Invalid procedure');
    }
  }

  private append(params: unknown[]): number {
    if (params.length !== 10) throw new Error('Invalid parameter');
    const [filename, content, category, priority, addToTop, addPaused, dupeKey, dupeScore, dupeMode, ppParameters] = params;
    this.appended.push({
      filename: String(filename),
      content: String(content),
      category: String(category),
      priority: Number(priority),
      addToTop: addToTop === true,
      addPaused: addPaused === true,
      dupeKey: String(dupeKey),
      dupeScore: Number(dupeScore),
      dupeMode: String(dupeMode),
      ppParameters,
    });
    const id = this.nextId;
    if (id <= 0) return id;
    this.nextId++;
    this.groups.push({
      NZBID: id,
      NZBName: String(filename).replace(/\.nzb$/i, ''),
      Category: String(category),
      Status: addPaused === true ? 'PAUSED' : 'QUEUED',
      FileSizeLo: 0,
      FileSizeHi: 0,
      RemainingSizeLo: 0,
      RemainingSizeHi: 0,
      DestDir: '',
    });
    return id;
  }

  /** v18+ editqueue: [Command, Param, IDs]; versions before 18: [Command, Offset, Param, IDs]. */
  private editQueue(params: unknown[]): boolean {
    const modern = Number(this.version.split('.')[0]) >= 18;
    if (params.length !== (modern ? 3 : 4)) throw new Error('Invalid parameter');
    const [command, param, ids] = (modern ? params : [params[0], params[2], params[3]]) as [string, string, number[]];
    const id = ids[0];
    const groupIndex = this.groups.findIndex((g) => g.NZBID === id);
    const historyIndex = this.history.findIndex((h) => h.NZBID === id);
    const group = this.groups[groupIndex];
    const record = this.history[historyIndex];

    switch (command) {
      case 'GroupPause':
        if (!group) return false;
        group['Status'] = 'PAUSED';
        return true;
      case 'GroupResume':
        if (!group) return false;
        group['Status'] = 'QUEUED';
        return true;
      case 'GroupApplyCategory':
        if (!group) return false;
        group['Category'] = param;
        return true;
      case 'GroupDelete':
        if (!group) return false;
        this.groups.splice(groupIndex, 1);
        this.history.unshift({ ...group, Name: group['NZBName'], Status: 'DELETED/MANUAL', DeleteStatus: 'MANUAL' });
        return true;
      case 'GroupFinalDelete':
        if (!group) return false;
        this.groups.splice(groupIndex, 1);
        return true;
      case 'HistoryDelete':
      case 'HistoryFinalDelete':
        if (!record) return false;
        this.history.splice(historyIndex, 1);
        return true;
      case 'HistorySetCategory':
        if (!record) return false;
        record['Category'] = param;
        return true;
      default:
        return false;
    }
  }
}
