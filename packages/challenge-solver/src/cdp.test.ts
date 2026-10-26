import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CdpConnection } from './cdp.js';
import { FakeCdpServer } from './testing/fake-cdp-server.js';

let server: FakeCdpServer;

beforeEach(async () => {
  server = new FakeCdpServer();
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('CdpConnection', () => {
  it('sends commands with increasing ids and resolves their results', async () => {
    const cdp = await CdpConnection.connect(server.url);
    const v = await cdp.send('Browser.getVersion');
    expect(v['userAgent']).toContain('HeadlessChrome');
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    expect(targetId).toBe('T1');
    expect(server.methods()).toEqual(['Browser.getVersion', 'Target.createTarget']);
    cdp.close();
  });

  it('routes flattened-session commands and events by sessionId', async () => {
    server.sites.set('https://a.example/', { states: [{ title: 'A', html: '<html>a</html>', status: 200 }] });
    const cdp = await CdpConnection.connect(server.url);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const seen: Array<[unknown, string | undefined]> = [];
    cdp.on('Network.responseReceived', (params, sid) => seen.push([params['type'], sid]));
    await cdp.send('Page.navigate', { url: 'https://a.example/' }, sessionId);
    expect(seen).toEqual([['Document', sessionId]]);
    expect(server.calls.at(-1)).toMatchObject({ method: 'Page.navigate', sessionId });
    cdp.close();
  });

  it('turns CDP error replies into protocol errors', async () => {
    server.failing.set('Page.navigate', 'Cannot navigate to invalid URL');
    const cdp = await CdpConnection.connect(server.url);
    await expect(cdp.send('Page.navigate', { url: 'nope' })).rejects.toMatchObject({
      code: 'protocol',
      message: 'Page.navigate failed: Cannot navigate to invalid URL (-32000)',
    });
    cdp.close();
  });

  it('rejects in-flight commands when the socket closes', async () => {
    server.latencyMs = 200;
    const cdp = await CdpConnection.connect(server.url);
    let closed = false;
    cdp.onClose(() => (closed = true));
    const pending = cdp.send('Browser.getVersion');
    setTimeout(() => server.dropConnections(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
    expect(closed).toBe(true);
    await expect(cdp.send('Browser.getVersion')).rejects.toMatchObject({ code: 'closed' });
  });

  it('times out a command that never answers', async () => {
    server.latencyMs = 300;
    const cdp = await CdpConnection.connect(server.url);
    await expect(cdp.send('Browser.getVersion', {}, undefined, 50)).rejects.toThrow('Browser.getVersion did not answer within 50 ms');
    cdp.close();
  });

  it('fails to connect to a closed port', async () => {
    const url = server.url;
    await server.stop();
    await expect(CdpConnection.connect(url, { timeoutMs: 2000 })).rejects.toMatchObject({ code: 'protocol' });
    server = new FakeCdpServer();
    await server.start();
  });
});
