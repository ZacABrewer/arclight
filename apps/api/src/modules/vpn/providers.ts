import type {
  GluetunProviderSettings,
  InterfaceBindingProviderSettings,
  VpnProviderType,
  VpnSettings,
  WireguardWindowsProviderSettings,
} from '@arclight/shared';
import { VpnError, errorMessage } from './errors.js';
import { GluetunClient } from './gluetun-client.js';
import { findInterfaceIPv4, ipv4FromNodeInterfaces, type InterfaceProbeDeps } from './interfaces.js';
import { fetchPublicIp } from './public-ip.js';
import { effectiveControlUrl } from './settings.js';
import type { ShellRunner } from './shell.js';
import { tunnelNameFromConfig, WireguardWindows } from './wireguard-windows.js';

// One adapter per provider type, all answering the same question: is the VPN up, and what
// does it look like from here? The service turns probe results into status, events and the
// grab guard; providers hold only small per-provider state (auto-start back-off).

export interface ProbeResult {
  connected: boolean;
  publicIp?: string;
  country?: string;
  region?: string;
  city?: string;
  forwardedPort?: number;
  tunnelAddress?: string;
  interfaceName?: string;
  endpoint?: string;
  lastHandshake?: string;
  rxBytes?: number;
  txBytes?: number;
  error?: string;
}

export interface ProbeOptions {
  /** False after a manual disconnect: do not reinstall the tunnel on our own. */
  allowAutoStart: boolean;
}

export interface VpnProvider {
  probe(settings: VpnSettings, opts: ProbeOptions): Promise<ProbeResult>;
  /** Cheap presence check for the kill-switch watcher (no network, no process spawn). */
  quickCheck?(settings: VpnSettings): boolean;
  connect?(settings: VpnSettings): Promise<void>;
  disconnect?(settings: VpnSettings): Promise<void>;
}

export interface ProviderDeps {
  fetch: typeof globalThis.fetch;
  shell: ShellRunner;
  interfaces: InterfaceProbeDeps;
  fileExists?: (path: string) => Promise<boolean>;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

/** WireGuard rejects session keys older than this without a new handshake. */
export const STALE_HANDSHAKE_MS = 180_000;
/** Minimum time between automatic tunnel installs. */
export const AUTO_START_BACKOFF_MS = 5 * 60_000;

// ---------------------------------------------------------------------------------------

export function gluetunProvider(deps: ProviderDeps): VpnProvider {
  return {
    async probe(settings) {
      const p = settings.provider as GluetunProviderSettings;
      const client = new GluetunClient({
        controlUrl: effectiveControlUrl(p, deps.env),
        apiKey: p.apiKey,
        username: p.username,
        password: p.password,
        fetch: deps.fetch,
      });
      if (!(await client.isRunning())) return { connected: false, error: 'Gluetun reports the VPN is stopped.' };
      const ip = await client.publicIp();
      let forwardedPort: number | undefined;
      try {
        forwardedPort = await client.forwardedPort();
      } catch {
        // Port forwarding off or not supported by the provider: not an outage.
      }
      return { connected: true, ...ip, ...(forwardedPort === undefined ? {} : { forwardedPort }) };
    },
  };
}

// ---------------------------------------------------------------------------------------

async function publicIpOrError(deps: ProviderDeps, settings: VpnSettings): Promise<{ publicIp?: string; error?: string }> {
  try {
    return { publicIp: await fetchPublicIp(deps.fetch, settings.publicIpCheckUrl) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export function wireguardWindowsProvider(deps: ProviderDeps): VpnProvider {
  let lastInstallAttempt = Number.NEGATIVE_INFINITY;
  const wgFor = (p: WireguardWindowsProviderSettings) =>
    new WireguardWindows({ wireguardExe: p.wireguardExe }, {
      shell: deps.shell,
      interfaces: deps.interfaces,
      ...(deps.fileExists ? { fileExists: deps.fileExists } : {}),
    });
  const nameOf = (p: WireguardWindowsProviderSettings) => {
    if (p.configPath.trim() === '') throw new VpnError('config', 'Set the path of your WireGuard .conf file.');
    return tunnelNameFromConfig(p.configPath);
  };

  return {
    async probe(settings, opts) {
      if (deps.interfaces.platform !== 'win32') {
        throw new VpnError('unsupported', 'The WireGuard for Windows provider only runs on Windows.');
      }
      const p = settings.provider as WireguardWindowsProviderSettings;
      const name = nameOf(p);
      const wg = wgFor(p);
      // Public IP first: it sends traffic through the tunnel, which refreshes the handshake.
      const ip = await publicIpOrError(deps, settings);
      let show;
      try {
        show = await wg.show(name);
      } catch (err) {
        if (!(err instanceof VpnError && err.code === 'tunnel-not-found')) throw err;
        const now = deps.now().getTime();
        if (!p.autoStart || !opts.allowAutoStart || now - lastInstallAttempt < AUTO_START_BACKOFF_MS) {
          return { connected: false, interfaceName: name, error: err.message, ...(ip.publicIp ? { publicIp: ip.publicIp } : {}) };
        }
        lastInstallAttempt = now;
        await wg.install(p.configPath);
        show = await wg.show(name);
      }
      const address = await wg.tunnelAddress(name);
      const peer = show.peers[0];
      const handshake = peer?.latestHandshake;
      const fresh = handshake !== undefined && deps.now().getTime() - handshake.getTime() <= STALE_HANDSHAKE_MS;
      let error = ip.error;
      if (!address) error = `The ${name} adapter has no IPv4 address.`;
      else if (!fresh) error = handshake ? 'The last WireGuard handshake is stale.' : 'WireGuard has not completed a handshake yet.';
      return {
        connected: Boolean(address) && fresh,
        interfaceName: name,
        ...(address ? { tunnelAddress: address } : {}),
        ...(peer?.endpoint ? { endpoint: peer.endpoint } : {}),
        ...(handshake ? { lastHandshake: handshake.toISOString() } : {}),
        ...(peer ? { rxBytes: peer.rxBytes, txBytes: peer.txBytes } : {}),
        ...(ip.publicIp ? { publicIp: ip.publicIp } : {}),
        ...(error ? { error } : {}),
      };
    },
    quickCheck(settings) {
      const p = settings.provider as WireguardWindowsProviderSettings;
      try {
        return ipv4FromNodeInterfaces(deps.interfaces.networkInterfaces(), nameOf(p)) !== null;
      } catch {
        return false;
      }
    },
    async connect(settings) {
      const p = settings.provider as WireguardWindowsProviderSettings;
      nameOf(p);
      await wgFor(p).install(p.configPath);
    },
    async disconnect(settings) {
      const p = settings.provider as WireguardWindowsProviderSettings;
      await wgFor(p).uninstall(nameOf(p));
    },
  };
}

// ---------------------------------------------------------------------------------------

export function interfaceBindingProvider(deps: ProviderDeps): VpnProvider {
  const nameOf = (p: InterfaceBindingProviderSettings) => {
    if (p.interfaceName.trim() === '') throw new VpnError('config', 'Set the name of the VPN network adapter.');
    return p.interfaceName.trim();
  };
  return {
    async probe(settings) {
      const name = nameOf(settings.provider as InterfaceBindingProviderSettings);
      const address = await findInterfaceIPv4(name, deps.interfaces);
      const ip = await publicIpOrError(deps, settings);
      return {
        connected: address !== null,
        interfaceName: name,
        ...(address ? { tunnelAddress: address } : {}),
        ...(ip.publicIp ? { publicIp: ip.publicIp } : {}),
        ...(address ? (ip.error ? { error: ip.error } : {}) : { error: `Network adapter "${name}" is missing or has no IPv4 address.` }),
      };
    },
    quickCheck(settings) {
      try {
        const name = nameOf(settings.provider as InterfaceBindingProviderSettings);
        return ipv4FromNodeInterfaces(deps.interfaces.networkInterfaces(), name) !== null;
      } catch {
        return false;
      }
    },
  };
}

export function createProviders(deps: ProviderDeps): Record<VpnProviderType, VpnProvider> {
  return {
    gluetun: gluetunProvider(deps),
    'wireguard-windows': wireguardWindowsProvider(deps),
    'interface-binding': interfaceBindingProvider(deps),
  };
}
