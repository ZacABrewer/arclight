import { access } from 'node:fs/promises';
import { win32 } from 'node:path';
import { DEFAULT_WIREGUARD_EXE } from '@media-tron/shared';
import { VpnError, errorMessage } from './errors.js';
import { findInterfaceIPv4, type InterfaceProbeDeps } from './interfaces.js';
import type { ShellRunner } from './shell.js';

// Native Windows tunnel management through the official WireGuard for Windows client.
//
// - `wireguard.exe /installtunnelservice <conf>` installs and starts a service named
//   `WireGuardTunnel$<name>`, where <name> is the .conf file name without extension; the
//   adapter it creates carries the same name.
// - `wireguard.exe /uninstalltunnelservice <name>` stops and removes it.
// - `wg.exe show <name> dump` reports peers, endpoint, last handshake and transfer counters in
//   a tab-separated, machine-readable form. Its first line contains the PRIVATE KEY: the raw
//   output is never logged or returned, only the parsed peer fields.
// All three need an elevated process (Administrator or LocalSystem service).

export interface WgPeerStatus {
  publicKey: string;
  endpoint?: string;
  allowedIps: string[];
  /** Undefined when no handshake has happened yet. */
  latestHandshake?: Date;
  rxBytes: number;
  txBytes: number;
}

export interface WgInterfaceStatus {
  listenPort?: number;
  peers: WgPeerStatus[];
}

export interface WireguardWindowsDeps {
  shell: ShellRunner;
  fileExists?: (path: string) => Promise<boolean>;
  interfaces: InterfaceProbeDeps;
}

const TUNNEL_NAME = /^[a-zA-Z0-9_=+.-]{1,32}$/;

/** WireGuard for Windows names the tunnel (and adapter) after the .conf file. */
export function tunnelNameFromConfig(configPath: string): string {
  const file = win32.basename(configPath);
  const name = file.replace(/\.conf$/i, '');
  if (!/\.conf$/i.test(file) || !TUNNEL_NAME.test(name)) {
    throw new VpnError(
      'config',
      `"${file}" is not a usable WireGuard config name: use a .conf file whose name is 1-32 letters, digits or _=+.- (e.g. proton-nl.conf).`,
    );
  }
  return name;
}

/** Parse `wg show <name> dump`. The interface line (with the private key) is reduced to the port. */
export function parseWgDump(stdout: string): WgInterfaceStatus {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  const [iface, ...peerLines] = lines;
  if (iface === undefined) throw new VpnError('bad-response', 'wg show returned no output.');
  const ifaceCols = iface.split('\t');
  if (ifaceCols.length < 4) throw new VpnError('bad-response', 'wg show returned an unexpected interface line.');
  const port = Number(ifaceCols[2]);
  const peers: WgPeerStatus[] = [];
  for (const line of peerLines) {
    const c = line.split('\t');
    if (c.length < 8) throw new VpnError('bad-response', 'wg show returned an unexpected peer line.');
    const [publicKey, , endpoint, allowed, handshake, rx, tx] = c as [string, string, string, string, string, string, string];
    const hs = Number(handshake);
    peers.push({
      publicKey,
      ...(endpoint && endpoint !== '(none)' ? { endpoint } : {}),
      allowedIps: allowed && allowed !== '(none)' ? allowed.split(',') : [],
      ...(Number.isFinite(hs) && hs > 0 ? { latestHandshake: new Date(hs * 1000) } : {}),
      rxBytes: Number(rx) || 0,
      txBytes: Number(tx) || 0,
    });
  }
  return { ...(Number.isInteger(port) && port > 0 ? { listenPort: port } : {}), peers };
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class WireguardWindows {
  private readonly fileExists: (path: string) => Promise<boolean>;

  constructor(
    private readonly opts: { wireguardExe?: string | undefined },
    private readonly deps: WireguardWindowsDeps,
  ) {
    this.fileExists = deps.fileExists ?? defaultFileExists;
  }

  /** wireguard.exe (override or the default install path) and wg.exe next to it. */
  async locate(): Promise<{ wireguard: string; wg: string }> {
    const wireguard = this.opts.wireguardExe?.trim() || DEFAULT_WIREGUARD_EXE;
    if (!(await this.fileExists(wireguard))) {
      throw new VpnError('not-installed', `WireGuard for Windows was not found at ${wireguard}. Install it from wireguard.com or set its path.`);
    }
    const wg = win32.join(win32.dirname(wireguard), 'wg.exe');
    if (!(await this.fileExists(wg))) throw new VpnError('not-installed', `wg.exe was not found next to ${wireguard}.`);
    return { wireguard, wg };
  }

  async install(configPath: string): Promise<string> {
    const name = tunnelNameFromConfig(configPath);
    if (!(await this.fileExists(configPath))) throw new VpnError('config', `WireGuard config ${configPath} does not exist.`);
    const { wireguard } = await this.locate();
    const res = await this.run(wireguard, ['/installtunnelservice', configPath]);
    if (res.code !== 0) throw this.commandError('install the tunnel service', res);
    return name;
  }

  async uninstall(name: string): Promise<void> {
    if (!TUNNEL_NAME.test(name)) throw new VpnError('config', `Invalid tunnel name "${name}".`);
    const { wireguard } = await this.locate();
    const res = await this.run(wireguard, ['/uninstalltunnelservice', name]);
    if (res.code !== 0) throw this.commandError('remove the tunnel service', res);
  }

  /** Peer status; throws `tunnel-not-found` when the tunnel is not running. */
  async show(name: string): Promise<WgInterfaceStatus> {
    if (!TUNNEL_NAME.test(name)) throw new VpnError('config', `Invalid tunnel name "${name}".`);
    const { wg } = await this.locate();
    const res = await this.run(wg, ['show', name, 'dump']);
    if (res.code !== 0) {
      const text = `${res.stderr}\n${res.stdout}`;
      if (/unable to access interface|no such|cannot find|not found/i.test(text)) {
        throw new VpnError('tunnel-not-found', `WireGuard tunnel "${name}" is not running.`);
      }
      if (/access is denied|permission/i.test(text)) {
        throw new VpnError('unauthorized', 'wg.exe needs administrator rights: run Media-Tron elevated or as a service.');
      }
      throw this.commandError('read the tunnel status', res);
    }
    return parseWgDump(res.stdout);
  }

  /** IPv4 of the tunnel adapter (named like the tunnel), or null when it is gone. */
  tunnelAddress(name: string): Promise<string | null> {
    return findInterfaceIPv4(name, this.deps.interfaces);
  }

  private async run(file: string, args: string[]) {
    try {
      return await this.deps.shell(file, args, { timeoutMs: 30_000 });
    } catch (err) {
      throw new VpnError('not-installed', `Could not start ${file}: ${errorMessage(err)}`, { cause: err });
    }
  }

  private commandError(what: string, res: { code: number; stderr: string }): VpnError {
    // stderr never carries key material for these commands; trim it for the message.
    const detail = res.stderr.trim().split(/\r?\n/)[0] ?? '';
    return new VpnError('command-failed', `Could not ${what} (exit ${res.code})${detail ? `: ${detail}` : ''}.`);
  }
}
