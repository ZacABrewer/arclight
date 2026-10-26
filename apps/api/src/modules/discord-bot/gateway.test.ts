import { afterEach, describe, expect, it } from 'vitest';
import { GatewayClient, GATEWAY_INTENTS, type ReadyInfo } from './gateway.js';
import { DiscordRest } from './rest.js';
import { FakeGateway, fakeRest, waitFor } from './test-support.js';

const clients: GatewayClient[] = [];

function client(gateway: FakeGateway, extra: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {}) {
  const ready: ReadyInfo[] = [];
  const events: string[] = [];
  const c = new GatewayClient({
    token: 'secret-token',
    webSocket: gateway.ctor,
    baseDelayMs: 5,
    maxDelayMs: 40,
    random: () => 0,
    onReady: (info) => ready.push(info),
    onDispatch: (t) => events.push(t),
    ...extra,
  });
  clients.push(c);
  return { c, ready, events };
}

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

describe('gateway client', () => {
  it('identifies with the token and the guild + message intents after Hello, then is connected on Ready', async () => {
    const gw = new FakeGateway();
    const { c, ready } = client(gw);
    c.start();
    await waitFor(() => c.state === 'connected');
    expect(gw.last.url).toBe('wss://gateway.discord.gg/?v=10&encoding=json');
    const identify = gw.last.ops(2)[0]!;
    expect(identify.d).toMatchObject({ token: 'secret-token', intents: GATEWAY_INTENTS, properties: { browser: 'arclight' } });
    expect(GATEWAY_INTENTS).toBe(513);
    expect(ready[0]).toEqual({ sessionId: 'session-1', user: { id: '900', username: 'arclight-bot' }, applicationId: 'app-1' });
    expect(c.session).toBe('session-1');
  });

  it('heartbeats on the Hello interval carrying the last sequence number', async () => {
    const gw = new FakeGateway();
    const { c } = client(gw);
    c.start();
    await waitFor(() => c.state === 'connected');
    await waitFor(() => gw.last.ops(1).length >= 3);
    const beats = gw.last.ops(1);
    expect(beats[beats.length - 1]!.d).toBe(gw.seq);
  });

  it('answers a server heartbeat request (op 1) at once', async () => {
    const gw = new FakeGateway();
    gw.heartbeatInterval = 10_000;
    const { c } = client(gw, { random: () => 0.99 });
    c.start();
    await waitFor(() => c.state === 'connected');
    const before = gw.last.ops(1).length;
    gw.last.push({ op: 1 });
    expect(gw.last.ops(1).length).toBe(before + 1);
  });

  it('reconnects and resumes on the resume URL when a heartbeat is not acknowledged', async () => {
    const gw = new FakeGateway();
    const { c, events } = client(gw);
    c.start();
    await waitFor(() => c.state === 'connected');
    gw.ackHeartbeats = false;
    await waitFor(() => gw.sockets.length === 2);
    expect(gw.sockets[0]!.closedWith).toBe(4000);
    gw.ackHeartbeats = true;
    await waitFor(() => events.includes('RESUMED'));
    expect(gw.last.url).toBe('wss://resume.test/?v=10&encoding=json');
    expect(gw.last.ops(6)[0]!.d).toMatchObject({ token: 'secret-token', session_id: 'session-1', seq: expect.any(Number) });
    expect(gw.last.ops(2)).toHaveLength(0);
    expect(c.state).toBe('connected');
  });

  it('resumes after op 7 (Reconnect) and after a dropped connection', async () => {
    const gw = new FakeGateway();
    const { c } = client(gw);
    c.start();
    await waitFor(() => c.state === 'connected');
    gw.last.push({ op: 7 });
    await waitFor(() => gw.sockets.length === 2 && gw.last.ops(6).length === 1);
    await waitFor(() => c.state === 'connected');
    gw.last.drop(1006);
    expect(c.state).toBe('reconnecting');
    await waitFor(() => gw.sockets.length === 3 && gw.last.ops(6).length === 1);
  });

  it('identifies afresh after a non-resumable invalid session (op 9 false)', async () => {
    const gw = new FakeGateway();
    const { c, ready } = client(gw);
    c.start();
    await waitFor(() => c.state === 'connected');
    gw.last.push({ op: 9, d: false });
    await waitFor(() => ready.length === 2);
    expect(gw.last.ops(2)).toHaveLength(1);
    expect(gw.last.ops(6)).toHaveLength(0);
  });

  it('backs off exponentially up to the cap and resets after Ready', async () => {
    const gw = new FakeGateway();
    gw.autoReady = false;
    const { c } = client(gw, { baseDelayMs: 5, maxDelayMs: 20 });
    expect(c.backoffDelay()).toBe(5);
    c.attempts = 1;
    expect(c.backoffDelay()).toBe(10);
    c.attempts = 2;
    expect(c.backoffDelay()).toBe(20);
    c.attempts = 9;
    expect(c.backoffDelay()).toBe(20);
    c.attempts = 0;
    c.start();
    await waitFor(() => gw.sockets.length === 1 && gw.last.ops(2).length === 1);
    gw.last.drop(1006);
    await waitFor(() => gw.sockets.length === 2 && gw.last.ops(2).length === 1);
    gw.last.drop(1006);
    await waitFor(() => gw.sockets.length === 3);
    expect(c.attempts).toBe(2);
    gw.dispatch(gw.last, 'READY', { session_id: 's', user: { id: '1', username: 'b' } });
    expect(c.attempts).toBe(0);
    expect(c.state).toBe('connected');
  });

  it('stops for good on a fatal close code (bad token)', async () => {
    const gw = new FakeGateway();
    const { c } = client(gw);
    c.start();
    await waitFor(() => c.state === 'connected');
    gw.last.drop(4004, 'Authentication failed.');
    expect(c.state).toBe('error');
    expect(c.lastError).toContain('4004');
    await new Promise((r) => setTimeout(r, 30));
    expect(gw.sockets).toHaveLength(1);
  });

  it('stop() closes cleanly and never reconnects', async () => {
    const gw = new FakeGateway();
    const { c } = client(gw);
    c.start();
    await waitFor(() => c.state === 'connected');
    c.stop();
    expect(gw.last.closedWith).toBe(1000);
    gw.last.drop(1006);
    await new Promise((r) => setTimeout(r, 30));
    expect(gw.sockets).toHaveLength(1);
    expect(c.state).toBe('stopped');
  });
});

describe('REST client', () => {
  it('sends the bot token and retries a 429 once after retry_after', async () => {
    const rest = fakeRest();
    let limited = false;
    rest.overrides.push((call) => {
      if (call.path === '/users/@me' && !limited) {
        limited = true;
        return Response.json({ retry_after: 0.5 }, { status: 429 });
      }
      return undefined;
    });
    const waits: number[] = [];
    const client = new DiscordRest({ token: 'abc', fetch: rest.fetch, sleep: async (ms) => void waits.push(ms) });
    expect(await client.me()).toEqual({ id: '900', username: 'arclight-bot' });
    expect(waits).toEqual([500]);
    expect(rest.calls).toHaveLength(2);
    expect(rest.calls[0]!.headers['Authorization']).toBe('Bot abc');
  });

  it('turns errors into DiscordRestError with the API message and does not retry a second 429', async () => {
    const rest = fakeRest();
    rest.overrides.push((call) => (call.path.startsWith('/channels/') ? Response.json({ message: 'Missing Access' }, { status: 403 }) : undefined));
    rest.overrides.push((call) => (call.path === '/users/@me' ? Response.json({ retry_after: 0 }, { status: 429 }) : undefined));
    const client = new DiscordRest({ token: 'abc', fetch: rest.fetch, sleep: async () => {} });
    await expect(client.sendMessage('1', { content: 'x' })).rejects.toMatchObject({ status: 403, message: expect.stringContaining('Missing Access') });
    await expect(client.me()).rejects.toMatchObject({ status: 429 });
    expect(rest.find('GET', /users/)).toHaveLength(2);
  });
});
