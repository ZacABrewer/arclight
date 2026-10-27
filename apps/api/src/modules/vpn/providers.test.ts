import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_IP_CHECK_URL, type VpnSettings } from '@arclight/shared';
import { gluetunProvider, type ProviderDeps } from './providers.js';

function timeout(): Error {
  return Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
}

function deps(fetch: typeof globalThis.fetch): ProviderDeps {
  return { fetch, env: {}, now: () => new Date(), shell: null as never, interfaces: null as never };
}

const settings = (controlUrl: string, extra: Partial<VpnSettings> = {}): VpnSettings =>
  ({ enabled: true, provider: { type: 'gluetun', controlUrl }, publicIpCheckUrl: DEFAULT_PUBLIC_IP_CHECK_URL, ...extra }) as VpnSettings;

describe('gluetun provider', () => {
  // gluetun's control server stalls while a port-forward up command retries; the tunnel is fine
  const stalled = (ip: string): typeof globalThis.fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(DEFAULT_PUBLIC_IP_CHECK_URL.split('?')[0] as string)) return new Response(JSON.stringify({ ip }), { headers: { 'content-type': 'application/json' } });
      throw timeout();
    }) as typeof globalThis.fetch;

  it('confirms the tunnel with a public IP check when a same-namespace control server stalls', async () => {
    const res = await gluetunProvider(deps(stalled('185.1.2.3'))).probe(settings('http://localhost:8000'), { allowAutoStart: false });
    expect(res).toMatchObject({ connected: true, publicIp: '185.1.2.3', keepForwardedPort: true });
    expect(res.unreachable).toBeUndefined();
    expect(res.warning).toContain('VPN_PORT_FORWARDING_UP_COMMAND');
  });

  it('stays unreachable for a remote control server or when the check shows the home IP', async () => {
    const remote = await gluetunProvider(deps(stalled('185.1.2.3'))).probe(settings('http://gluetun:8000'), { allowAutoStart: false });
    expect(remote).toMatchObject({ connected: false, unreachable: true });
    const home = await gluetunProvider(deps(stalled('203.0.113.9'))).probe(settings('http://127.0.0.1:8000', { homePublicIp: '203.0.113.9' }), { allowAutoStart: false });
    expect(home).toMatchObject({ connected: false, unreachable: true });
  });
});
