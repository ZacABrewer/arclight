import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Test-only: a tiny RFC 6455 WebSocket server that speaks enough of the Chrome DevTools
 * protocol for ChallengeSolver (targets, navigation, evaluate, cookies). Sites are scripted as
 * a list of page states; each state is shown for `polls` snapshot evaluations, then the page
 * "reloads" into the next state (as a solved Cloudflare challenge does).
 */

export interface FakePageState {
  title: string;
  html: string;
  status?: number;
  headers?: Record<string, string>;
  /** Snapshot polls this state survives before the next one replaces it (default: forever). */
  polls?: number;
  readyState?: string;
}

export interface FakeSite {
  states: FakePageState[];
  cookies?: Array<Record<string, unknown>>;
  /** Result of the in-page fetch for POST. */
  post?: { status: number; body: string; headers?: Record<string, string> };
  /** Page.navigate errorText. */
  navigateError?: string;
}

export interface CdpCall {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

interface PageState {
  targetId: string;
  sessionId: string;
  url: string;
  site?: FakeSite;
  stateIndex: number;
  pollsInState: number;
}

export class FakeCdpServer {
  readonly calls: CdpCall[] = [];
  readonly sites = new Map<string, FakeSite>();
  userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36';
  /** Delay before answering each command (ms). */
  latencyMs = 0;
  /** Methods that answer with a CDP error. */
  readonly failing = new Map<string, string>();
  connections = 0;
  private readonly server = http.createServer((_req, res) => res.writeHead(404).end());
  private readonly sockets = new Set<Socket>();
  private readonly pages = new Map<string, PageState>();
  private nextTarget = 1;

  constructor() {
    this.server.on('upgrade', (req, socket: Socket) => this.upgrade(req, socket));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this.url;
  }

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/devtools/browser/fake`;
  }

  get openPages(): number {
    return this.pages.size;
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  /** Drop every client connection (simulates the browser crashing). */
  dropConnections(): void {
    for (const s of this.sockets) s.destroy();
  }

  async stop(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---- WebSocket plumbing --------------------------------------------------------------

  private upgrade(req: http.IncomingMessage, socket: Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    this.connections += 1;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = parseFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.length);
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame(Buffer.alloc(0), 0x8));
          return;
        }
        if (frame.opcode === 0x9) socket.write(encodeFrame(frame.payload, 0xa));
        if (frame.opcode === 0x1) void this.onText(socket, frame.payload.toString('utf8'));
      }
    });
  }

  private send(socket: Socket, message: unknown): void {
    if (!socket.destroyed) socket.write(encodeFrame(Buffer.from(JSON.stringify(message), 'utf8'), 0x1));
  }

  private async onText(socket: Socket, text: string): Promise<void> {
    const msg = JSON.parse(text) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
    const call: CdpCall = { method: msg.method, params: msg.params ?? {} };
    if (msg.sessionId !== undefined) call.sessionId = msg.sessionId;
    this.calls.push(call);
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const failure = this.failing.get(msg.method);
    if (failure !== undefined) {
      this.send(socket, { id: msg.id, error: { code: -32000, message: failure }, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
      return;
    }
    const events: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
    const result = this.handle(call, events);
    // Like Chrome, a navigation's response event can arrive before the command's reply.
    for (const ev of events) this.send(socket, ev);
    this.send(socket, { id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
    if (msg.method === 'Browser.close') setTimeout(() => socket.destroy(), 5);
  }

  // ---- CDP behaviour ---------------------------------------------------------------------

  private pageBySession(sessionId: string | undefined): PageState | undefined {
    for (const p of this.pages.values()) if (p.sessionId === sessionId) return p;
    return undefined;
  }

  private docEvent(page: PageState, state: FakePageState): { method: string; params: Record<string, unknown>; sessionId: string } {
    return {
      method: 'Network.responseReceived',
      sessionId: page.sessionId,
      params: {
        type: 'Document',
        frameId: page.targetId,
        response: { url: page.url, status: state.status ?? 200, headers: state.headers ?? { 'content-type': 'text/html' } },
      },
    };
  }

  private handle(call: CdpCall, events: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }>): Record<string, unknown> {
    const p = call.params;
    switch (call.method) {
      case 'Browser.getVersion':
        return { product: 'HeadlessChrome/130.0.0.0', userAgent: this.userAgent, protocolVersion: '1.3' };
      case 'Browser.close':
        return {};
      case 'Target.createTarget': {
        const targetId = `T${this.nextTarget++}`;
        this.pages.set(targetId, { targetId, sessionId: '', url: String(p['url'] ?? 'about:blank'), stateIndex: 0, pollsInState: 0 });
        return { targetId };
      }
      case 'Target.attachToTarget': {
        const page = this.pages.get(String(p['targetId']));
        if (!page) return {};
        page.sessionId = `S-${page.targetId}`;
        return { sessionId: page.sessionId };
      }
      case 'Target.closeTarget':
        return { success: this.pages.delete(String(p['targetId'])) };
      case 'Page.navigate': {
        const page = this.pageBySession(call.sessionId);
        if (!page) return {};
        page.url = String(p['url']);
        const site = this.sites.get(page.url);
        if (site?.navigateError) return { frameId: page.targetId, errorText: site.navigateError };
        if (site) page.site = site;
        else delete page.site;
        page.stateIndex = 0;
        page.pollsInState = 0;
        const state = site?.states[0];
        if (state) events.push(this.docEvent(page, state));
        return { frameId: page.targetId, loaderId: `L${this.calls.length}` };
      }
      case 'Runtime.evaluate': {
        const page = this.pageBySession(call.sessionId);
        const expr = String(p['expression'] ?? '');
        if (!page) return { result: { type: 'undefined' } };
        if (expr.includes('fetch(')) {
          const post = page.site?.post ?? { status: 200, body: '<html><body>posted</body></html>' };
          return { result: { type: 'string', value: JSON.stringify({ status: post.status, url: page.url, headers: post.headers ?? {}, body: post.body }) } };
        }
        const states = page.site?.states ?? [{ title: '', html: '<html><head></head><body></body></html>' }];
        let state = states[Math.min(page.stateIndex, states.length - 1)] as FakePageState;
        if (state.polls !== undefined && page.pollsInState >= state.polls && page.stateIndex < states.length - 1) {
          page.stateIndex += 1;
          page.pollsInState = 0;
          state = states[page.stateIndex] as FakePageState;
          events.push(this.docEvent(page, state));
        }
        page.pollsInState += 1;
        const value = JSON.stringify({ title: state.title, url: page.url, ready: state.readyState ?? 'complete', html: state.html });
        return { result: { type: 'string', value } };
      }
      case 'Network.getCookies': {
        const page = this.pageBySession(call.sessionId);
        return { cookies: page?.site?.cookies ?? [] };
      }
      default:
        return {};
    }
  }
}

function parseFrame(buf: Buffer): { opcode: number; payload: Buffer; length: number } | undefined {
  if (buf.length < 2) return undefined;
  const opcode = (buf[0] as number) & 0x0f;
  const masked = ((buf[1] as number) & 0x80) !== 0;
  let len = (buf[1] as number) & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return undefined;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return undefined;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return undefined;
  const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
  }
  return { opcode, payload, length: offset + maskLen + len };
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}
