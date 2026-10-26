import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WIREGUARD_EXE, SECRET_MASK, type ServerEvent, type VpnSettingsInput, VpnSettings } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import type { ProbeResult, VpnProvider } from './providers.js';
import { vpnRoutes } from './routes.js';
import { VpnService, type ListenPortSync } from './service.js';
import { applyVpnUpdate, maskVpnSettings, saveVpnSettings } from './settings.js';
import { fakeFetch, fixture, iface, json, scriptedShell } from './test-support.js';

const T0 = new Date('2026-10-25T12:00:00.000Z');

async function setup(opts: {
  settings?: VpnSettingsInput;
  probe?: () => Promise<ProbeResult> | ProbeResult;
  ports?: ListenPortSync;
  providerDeps?: ConstructorParameters<typeof VpnService>[0]['providerDeps'];
  env?: NodeJS.ProcessEnv;
} = {}) {
  const db = await createTestDb();
  if (opts.settings) saveVpnSettings(db, VpnSettings.parse(opts.settings));
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  let clock = T0;
  const probe = vi.fn(async () => (opts.probe ? opts.probe() : { connected: true, publicIp: '185.1.2.3' }));
  const fakeProvider: VpnProvider = { probe };
  const service = new VpnService({
    db,
    bus,
    now: () => clock,
    env: opts.env ?? {},
    ...(opts.probe || !opts.providerDeps ? { providers: { gluetun: fakeProvider } } : {}),
    ...(opts.providerDeps ? { providerDeps: opts.providerDeps } : {}),
    downloadClients: opts.ports,
  });
  return {
    db,
    service,
    probe,
    vpnEvents: () => events.filter((e): e is Extract<ServerEvent, { type: 'vpn' }> => e.type === 'vpn'),
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe('VpnService status and events', () => {
  it('is a cheap no-op when disabled and allows grabs', async () => {
    const h = await setup();
    await expect(h.service.refreshIfDue()).resolves.toBe('disabled');
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.vpnEvents()).toHaveLength(0);
    await expect(h.service.isSafeToGrab()).resolves.toBe(true);
    expect(h.service.getTunnelAddress()).toBeNull();
  });

  it('publishes a vpn event on each transition, not on every poll', async () => {
    let result: ProbeResult = { connected: true, publicIp: '185.1.2.3', country: 'Netherlands' };
    const h = await setup({ settings: { enabled: true }, probe: () => result });
    await h.service.refresh();
    await h.service.refresh();
    expect(h.vpnEvents()).toHaveLength(1);
    expect(h.vpnEvents()[0]!.status).toMatchObject({ enabled: true, provider: 'gluetun', connected: true, country: 'Netherlands', killSwitchEngaged: false });

    result = { connected: false, error: 'Gluetun reports the VPN is stopped.' };
    h.advance(60_000);
    const down = await h.service.refresh();
    expect(down).toMatchObject({ connected: false, killSwitchEngaged: true, lastChanged: '2026-10-25T12:01:00.000Z' });
    expect(h.vpnEvents()).toHaveLength(2);
  });

  it('turns probe exceptions into a disconnected status with the error', async () => {
    const h = await setup({ settings: { enabled: true }, probe: () => Promise.reject(new Error('Cannot reach Gluetun')) });
    await expect(h.service.refresh()).resolves.toMatchObject({ connected: false, error: 'Cannot reach Gluetun' });
  });

  it('refreshIfDue honours the poll interval', async () => {
    const h = await setup({ settings: { enabled: true, pollIntervalSeconds: 120 } });
    await h.service.refreshIfDue();
    h.advance(60_000);
    await expect(h.service.refreshIfDue()).resolves.toBe('not due');
    h.advance(60_000);
    await expect(h.service.refreshIfDue()).resolves.toMatch(/^connected/);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });
});

describe('forwarded port sync', () => {
  it('calls setListenPort once per port change', async () => {
    let port = 41000;
    const ports = { setListenPortOnAll: vi.fn(async () => [{ id: 1, name: 'qBittorrent', ok: true }]) };
    const h = await setup({ settings: { enabled: true }, probe: () => ({ connected: true, forwardedPort: port }), ports });
    await h.service.refresh();
    await h.service.refresh();
    expect(ports.setListenPortOnAll).toHaveBeenCalledTimes(1);
    expect(h.service.getStatus().downloadClientPortSynced).toBe(true);
    port = 42000;
    await h.service.refresh();
    expect(ports.setListenPortOnAll.mock.calls).toEqual([[41000], [42000]]);
  });

  it('tolerates client errors, flags the status and retries on the next poll', async () => {
    const ports = {
      setListenPortOnAll: vi
        .fn<ListenPortSync['setListenPortOnAll']>()
        .mockResolvedValueOnce([{ id: 1, name: 'qBittorrent', ok: false, message: 'unreachable' }])
        .mockResolvedValue([{ id: 1, name: 'qBittorrent', ok: true }]),
    };
    const h = await setup({ settings: { enabled: true }, probe: () => ({ connected: true, forwardedPort: 41000 }), ports });
    await expect(h.service.refresh()).resolves.toMatchObject({ downloadClientPortSynced: false });
    await expect(h.service.refresh()).resolves.toMatchObject({ downloadClientPortSynced: true });
    expect(ports.setListenPortOnAll).toHaveBeenCalledTimes(2);
  });

  it('does not sync when the option is off', async () => {
    const ports = { setListenPortOnAll: vi.fn(async () => []) };
    const h = await setup({ settings: { enabled: true, syncForwardedPortToDownloadClient: false }, probe: () => ({ connected: true, forwardedPort: 41000 }), ports });
    await h.service.refresh();
    expect(ports.setListenPortOnAll).not.toHaveBeenCalled();
  });
});

describe('isSafeToGrab', () => {
  it('is true when connected with a non-home public IP', async () => {
    const h = await setup({ settings: { enabled: true, homePublicIp: '73.0.0.1' } });
    await expect(h.service.isSafeToGrab()).resolves.toBe(true);
  });

  it('is false when the public IP equals the home IP (leak)', async () => {
    const h = await setup({ settings: { enabled: true, homePublicIp: '73.0.0.1' }, probe: () => ({ connected: true, publicIp: '73.0.0.1' }) });
    await expect(h.service.isSafeToGrab()).resolves.toBe(false);
    expect(h.service.getStatus()).toMatchObject({ leak: true, killSwitchEngaged: true });
  });

  it('is false when down, unless pauseGrabsWhenDown is off', async () => {
    const down = await setup({ settings: { enabled: true }, probe: () => ({ connected: false }) });
    await expect(down.service.isSafeToGrab()).resolves.toBe(false);
    const lax = await setup({ settings: { enabled: true, pauseGrabsWhenDown: false }, probe: () => ({ connected: false }) });
    await expect(lax.service.isSafeToGrab()).resolves.toBe(true);
  });

  it('re-probes a stale status before answering', async () => {
    const h = await setup({ settings: { enabled: true } });
    await h.service.isSafeToGrab();
    await h.service.isSafeToGrab();
    expect(h.probe).toHaveBeenCalledTimes(1);
    h.advance(5 * 60_000);
    await h.service.isSafeToGrab();
    expect(h.probe).toHaveBeenCalledTimes(2);
  });
});

describe('native providers', () => {
  const ipify = () => fakeFetch({ 'api.ipify.org': () => json({ ip: '185.159.157.9' }) }).fetch;

  it('interface-binding: exposes the adapter address and engages the kill switch when it disappears', async () => {
    let table: NodeJS.Dict<NetworkInterfaceInfo[]> = { ProtonVPN: [iface('10.2.0.2')], Ethernet: [iface('192.168.1.20')] };
    const shell = scriptedShell([]);
    const h = await setup({
      settings: { enabled: true, provider: { type: 'interface-binding', interfaceName: 'ProtonVPN' } },
      providerDeps: { fetch: ipify(), shell: shell.run, interfaces: { platform: 'linux', shell: shell.run, networkInterfaces: () => table } },
    });
    await h.service.refresh();
    expect(h.service.getTunnelAddress()).toBe('10.2.0.2');
    await expect(h.service.watchTick()).resolves.toBe(false);

    table = { Ethernet: [iface('192.168.1.20')] };
    await expect(h.service.watchTick()).resolves.toBe(true);
    expect(h.vpnEvents().at(-1)!.status).toMatchObject({ connected: false, killSwitchEngaged: true });
    expect(h.service.getTunnelAddress()).toBeNull();
    await expect(h.service.isSafeToGrab()).resolves.toBe(false);
  });

  it('wireguard-windows: auto-starts a missing tunnel, then reports handshake, endpoint and address', async () => {
    let installed = false;
    const shell = scriptedShell([
      {
        match: (f) => f === DEFAULT_WIREGUARD_EXE,
        reply: () => {
          installed = true;
          return {};
        },
      },
      {
        match: (f) => f.endsWith('wg.exe'),
        reply: () => (installed ? { stdout: fixture('wg-show-dump.txt') } : { code: 1, stderr: fixture('wg-show-missing.txt') }),
      },
    ]);
    const h = await setup({
      settings: { enabled: true, provider: { type: 'wireguard-windows', configPath: 'C:\\vpn\\proton-nl.conf' } },
      providerDeps: {
        fetch: ipify(),
        shell: shell.run,
        fileExists: async () => true,
        interfaces: { platform: 'win32', shell: shell.run, networkInterfaces: () => ({ 'proton-nl': [iface('10.2.0.2')] }) },
        // 60 s after the recorded handshake (1761400000).
        now: () => new Date(1761400060 * 1000),
      },
    });
    const st = await h.service.refresh();
    expect(shell.calls.map((c) => c.args[0])).toEqual(['show', '/installtunnelservice', 'show']);
    expect(st).toMatchObject({
      connected: true,
      provider: 'wireguard-windows',
      interfaceName: 'proton-nl',
      tunnelAddress: '10.2.0.2',
      endpoint: '185.159.157.1:51820',
      publicIp: '185.159.157.9',
      rxBytes: 123456789,
    });
    expect(h.service.getTunnelAddress()).toBe('10.2.0.2');
  });

  it('wireguard-windows: a stale handshake counts as disconnected', async () => {
    const shell = scriptedShell([{ match: (f) => f.endsWith('wg.exe'), reply: { stdout: fixture('wg-show-dump.txt') } }]);
    const h = await setup({
      settings: { enabled: true, pauseGrabsWhenDown: false, provider: { type: 'wireguard-windows', configPath: 'C:\\vpn\\proton-nl.conf', killSwitch: true } },
      providerDeps: {
        fetch: ipify(),
        shell: shell.run,
        fileExists: async () => true,
        interfaces: { platform: 'win32', shell: shell.run, networkInterfaces: () => ({ 'proton-nl': [iface('10.2.0.2')] }) },
        now: () => new Date((1761400000 + 600) * 1000),
      },
    });
    await expect(h.service.refresh()).resolves.toMatchObject({ connected: false, error: 'The last WireGuard handshake is stale.' });
    // pauseGrabsWhenDown is off, but the WireGuard kill switch still blocks grabs.
    await expect(h.service.isSafeToGrab()).resolves.toBe(false);
  });
});

describe('vpn settings', () => {
  it('masks secrets and fills the control URL from ARCLIGHT_VPN_CONTROL_URL', () => {
    const stored = VpnSettings.parse({ provider: { type: 'gluetun', apiKey: 'k', username: 'u', password: 'p' } });
    expect(maskVpnSettings(stored, { ARCLIGHT_VPN_CONTROL_URL: 'http://gluetun:8000' }).provider).toEqual({
      type: 'gluetun',
      controlUrl: 'http://gluetun:8000',
      apiKey: SECRET_MASK,
      username: 'u',
      password: SECRET_MASK,
    });
  });

  it('keeps secrets on mask, clears on empty and drops them when the provider changes', () => {
    const stored = VpnSettings.parse({ provider: { type: 'gluetun', apiKey: 'k', password: 'p', username: 'u' } });
    const kept = applyVpnUpdate(stored, { provider: { type: 'gluetun', apiKey: SECRET_MASK, password: '', username: 'u' } });
    expect(kept.provider).toEqual({ type: 'gluetun', apiKey: 'k', username: 'u' });
    const switched = applyVpnUpdate(stored, { provider: { type: 'interface-binding', interfaceName: ' ProtonVPN ' } });
    expect(switched.provider).toEqual({ type: 'interface-binding', interfaceName: 'ProtonVPN' });
    expect(applyVpnUpdate(VpnSettings.parse({ homePublicIp: '1.1.1.1' }), { homePublicIp: null }).homePublicIp).toBeUndefined();
  });
});

describe('vpn routes', () => {
  async function app() {
    const h = await setup({ settings: { enabled: true, provider: { type: 'gluetun', apiKey: 'secret-key' } } });
    const fastify = Fastify().withTypeProvider<ZodTypeProvider>();
    fastify.setValidatorCompiler(validatorCompiler);
    fastify.setSerializerCompiler(serializerCompiler);
    await fastify.register(vpnRoutes(h.service), { prefix: '/api/v1' });
    return { ...h, fastify };
  }

  it('GET/PUT /settings/vpn never return secrets and keep them on mask', async () => {
    const { fastify, service } = await app();
    const got = await fastify.inject({ method: 'GET', url: '/api/v1/settings/vpn' });
    expect(got.statusCode).toBe(200);
    expect(got.json().provider).toMatchObject({ type: 'gluetun', apiKey: SECRET_MASK, controlUrl: 'http://localhost:8000' });
    const put = await fastify.inject({
      method: 'PUT',
      url: '/api/v1/settings/vpn',
      payload: { ...(got.json() as Record<string, unknown>), homePublicIp: '73.0.0.1' },
    });
    expect(put.statusCode).toBe(200);
    expect(JSON.stringify(put.json())).not.toContain('secret-key');
    expect(service.settings().provider).toMatchObject({ apiKey: 'secret-key' });
    expect(service.settings().homePublicIp).toBe('73.0.0.1');
    // The echoed default control URL is not pinned into storage.
    expect(service.settings().provider).not.toHaveProperty('controlUrl');
  });

  it('serves status and refresh, and rejects connect for gluetun', async () => {
    const { fastify } = await app();
    expect((await fastify.inject({ method: 'GET', url: '/api/v1/vpn/status' })).json()).toMatchObject({ connected: false, lastChecked: null });
    expect((await fastify.inject({ method: 'POST', url: '/api/v1/vpn/refresh' })).json()).toMatchObject({ connected: true, publicIp: '185.1.2.3' });
    const connect = await fastify.inject({ method: 'POST', url: '/api/v1/vpn/connect' });
    expect(connect.statusCode).toBe(400);
    expect(connect.json().code).toBe('unsupported');
  });

  it('POST /vpn/test probes a draft without publishing', async () => {
    const { fastify, vpnEvents } = await app();
    const res = await fastify.inject({ method: 'POST', url: '/api/v1/vpn/test', payload: { provider: { type: 'gluetun', controlUrl: 'http://g:8000' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: true });
    expect(vpnEvents()).toHaveLength(0);
  });
});
