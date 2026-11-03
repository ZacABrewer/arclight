import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { describe, expect, it } from 'vitest';
import type { RequestAuth } from './modules/auth/service.js';
import { admitSocket, sendBounded, WS_MAX_BUFFERED, WS_MAX_PAYLOAD, WS_MAX_PER_OWNER, type LimitedSocket } from './ws-limits.js';

class FakeSocket extends EventEmitter implements LimitedSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed: number | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed = code ?? 1000;
    this.readyState = 3;
    this.emit('close');
  }
}

const auth = (id: number) => ({ user: { id }, via: 'session', isAdmin: false, appAccess: [] }) as unknown as RequestAuth;

describe('websocket limits (DATA-36)', () => {
  it('closes a client that stops reading instead of buffering for it', () => {
    const s = new FakeSocket();
    sendBounded(s, 'a');
    s.bufferedAmount = WS_MAX_BUFFERED + 1;
    sendBounded(s, 'b');
    expect(s.sent).toEqual(['a']);
    expect(s.closed).toBe(1013);
  });

  it('caps open sockets per user and frees the slot on close', () => {
    const sockets = Array.from({ length: WS_MAX_PER_OWNER }, () => new FakeSocket());
    for (const s of sockets) expect(admitSocket(s, auth(7))).toBe(true);
    const extra = new FakeSocket();
    expect(admitSocket(extra, auth(7))).toBe(false);
    expect(extra.closed).toBe(1013);
    expect(admitSocket(new FakeSocket(), auth(8))).toBe(true);
    sockets[0]!.close();
    expect(admitSocket(new FakeSocket(), auth(7))).toBe(true);
  });

  it('rejects a frame larger than the payload cap', async () => {
    const app = Fastify();
    await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD } });
    app.get('/ws', { websocket: true }, () => undefined);
    await app.ready();
    const ws = await app.injectWS('/ws');
    const closed = new Promise<number>((resolve) => ws.on('close', (code: number) => resolve(code)));
    ws.send(Buffer.alloc(1024 * 1024));
    expect(await closed).toBe(1009);
    await app.close();
  });
});
