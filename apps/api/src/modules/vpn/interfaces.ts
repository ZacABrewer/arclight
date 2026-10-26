import { networkInterfaces as osNetworkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { VpnError } from './errors.js';
import { psQuote, type ShellRunner } from './shell.js';

// Finding the IPv4 address of a named network adapter. Node's os.networkInterfaces() is tried
// first (it keys adapters by their friendly name on Windows too, and is cheap enough for the
// kill-switch watcher). On Windows, when Node does not list the adapter, we ask PowerShell
// (Get-NetIPAddress) and then netsh, whose outputs are parsed below.

export interface InterfaceProbeDeps {
  platform: NodeJS.Platform;
  shell: ShellRunner;
  networkInterfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

export const defaultInterfaceDeps = (shell: ShellRunner): InterfaceProbeDeps => ({
  platform: process.platform,
  shell,
  networkInterfaces: osNetworkInterfaces,
});

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function usable(ip: string): boolean {
  return IPV4.test(ip) && !ip.startsWith('169.254.') && !ip.startsWith('127.');
}

export function assertInterfaceName(name: string): void {
  if (name.trim() === '' || name.length > 256 || /[\u0000-\u001f"]/.test(name)) {
    throw new VpnError('config', `Invalid network adapter name "${name}".`);
  }
}

/** IPv4 of `name` from os.networkInterfaces() (exact, then case-insensitive match). */
export function ipv4FromNodeInterfaces(all: NodeJS.Dict<NetworkInterfaceInfo[]>, name: string): string | null {
  const key = name in all ? name : Object.keys(all).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key === undefined) return null;
  const hit = (all[key] ?? []).find((a) => a.family === 'IPv4' && !a.internal && usable(a.address));
  return hit?.address ?? null;
}

/** Output of `Get-NetIPAddress ... | Select-Object -ExpandProperty IPAddress`: one address per line. */
export function parseGetNetIpAddress(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const ip = line.trim();
    if (usable(ip)) return ip;
  }
  return null;
}

/** Output of `netsh interface ipv4 show addresses name=<adapter>`. */
export function parseNetshAddresses(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /IP Address:\s*([\d.]+)/i.exec(line);
    if (m?.[1] && usable(m[1])) return m[1];
  }
  return null;
}

/** The adapter's IPv4, or null when the adapter is missing or has no usable address. */
export async function findInterfaceIPv4(name: string, deps: InterfaceProbeDeps): Promise<string | null> {
  assertInterfaceName(name);
  const fromNode = ipv4FromNodeInterfaces(deps.networkInterfaces(), name);
  if (fromNode) return fromNode;
  if (deps.platform !== 'win32') return null;

  try {
    const ps = await deps.shell('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-NetIPAddress -InterfaceAlias ${psQuote(name)} -AddressFamily IPv4 -ErrorAction Stop | Select-Object -ExpandProperty IPAddress`,
    ]);
    if (ps.code === 0) {
      const ip = parseGetNetIpAddress(ps.stdout);
      if (ip) return ip;
    }
  } catch {
    // PowerShell unavailable: fall through to netsh.
  }
  try {
    const netsh = await deps.shell('netsh', ['interface', 'ipv4', 'show', 'addresses', `name=${name}`]);
    if (netsh.code === 0) return parseNetshAddresses(netsh.stdout);
  } catch {
    // netsh unavailable.
  }
  return null;
}
