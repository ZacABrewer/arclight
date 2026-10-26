import { describe, expect, it } from 'vitest';
import { DEFAULT_WIREGUARD_EXE } from '@arclight/shared';
import { VpnError } from './errors.js';
import { findInterfaceIPv4, parseGetNetIpAddress, parseNetshAddresses, type InterfaceProbeDeps } from './interfaces.js';
import { fixture, iface, scriptedShell } from './test-support.js';
import { parseWgDump, tunnelNameFromConfig, WireguardWindows } from './wireguard-windows.js';

const WG = 'C:\\Program Files\\WireGuard\\wg.exe';
const exists = async (p: string) => p === DEFAULT_WIREGUARD_EXE || p === WG || p.endsWith('.conf');

function interfaces(shell: InterfaceProbeDeps['shell'], table: InterfaceProbeDeps['networkInterfaces'] = () => ({})): InterfaceProbeDeps {
  return { platform: 'win32', shell, networkInterfaces: table };
}

async function caught(p: Promise<unknown>): Promise<VpnError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VpnError);
  return err as VpnError;
}

describe('WireGuard output parsing (recorded)', () => {
  it('parses wg show dump without exposing the private key', () => {
    const status = parseWgDump(fixture('wg-show-dump.txt'));
    expect(status).toEqual({
      listenPort: 51820,
      peers: [
        {
          publicKey: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
          endpoint: '185.159.157.1:51820',
          allowedIps: ['0.0.0.0/0', '::/0'],
          latestHandshake: new Date(1761400000 * 1000),
          rxBytes: 123456789,
          txBytes: 7890123,
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('yAnz5TF');
  });

  it('handles a peer that never completed a handshake', () => {
    const [peer] = parseWgDump(fixture('wg-show-dump-no-handshake.txt')).peers;
    expect(peer).toEqual({ publicKey: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=', allowedIps: [], rxBytes: 0, txBytes: 0 });
    expect(() => parseWgDump('')).toThrow(VpnError);
  });

  it('parses Get-NetIPAddress and netsh output', () => {
    expect(parseGetNetIpAddress(fixture('get-netipaddress.txt'))).toBe('10.2.0.2');
    expect(parseGetNetIpAddress('169.254.10.1\r\n')).toBeNull();
    expect(parseNetshAddresses(fixture('netsh-show-addresses.txt'))).toBe('10.2.0.2');
    expect(parseNetshAddresses('The filename, directory name, or volume label syntax is incorrect.')).toBeNull();
  });
});

describe('tunnel names', () => {
  it('derives the tunnel name from the .conf file name', () => {
    expect(tunnelNameFromConfig('C:\\Users\\me\\Downloads\\proton-nl.conf')).toBe('proton-nl');
    expect(tunnelNameFromConfig('/data/wg0.CONF')).toBe('wg0');
    expect(() => tunnelNameFromConfig('C:\\vpn\\my tunnel.conf')).toThrow(/not a usable/);
    expect(() => tunnelNameFromConfig('C:\\vpn\\proton.txt')).toThrow(VpnError);
  });
});

describe('findInterfaceIPv4', () => {
  it('prefers os.networkInterfaces, matching names case-insensitively', async () => {
    const shell = scriptedShell([]);
    const ip = await findInterfaceIPv4('protonvpn', interfaces(shell.run, () => ({ ProtonVPN: [iface('fe80::1', 'IPv6'), iface('10.2.0.2')] })));
    expect(ip).toBe('10.2.0.2');
    expect(shell.calls).toHaveLength(0);
  });

  it('falls back to PowerShell Get-NetIPAddress, then netsh, on Windows', async () => {
    const ps = scriptedShell([{ match: (f) => f === 'powershell.exe', reply: { stdout: fixture('get-netipaddress.txt') } }]);
    await expect(findInterfaceIPv4("o'brien", interfaces(ps.run))).resolves.toBe('10.2.0.2');
    expect(ps.calls[0]!.args.at(-1)).toContain("-InterfaceAlias 'o''brien' -AddressFamily IPv4");

    const netsh = scriptedShell([
      { match: (f) => f === 'powershell.exe', reply: { code: 1, stderr: fixture('get-netipaddress-missing.txt') } },
      { match: (f) => f === 'netsh', reply: { stdout: fixture('netsh-show-addresses.txt') } },
    ]);
    await expect(findInterfaceIPv4('proton-nl', interfaces(netsh.run))).resolves.toBe('10.2.0.2');
    expect(netsh.calls[1]!.args).toEqual(['interface', 'ipv4', 'show', 'addresses', 'name=proton-nl']);
  });

  it('returns null off Windows when Node does not list the adapter and rejects unsafe names', async () => {
    const shell = scriptedShell([]);
    await expect(findInterfaceIPv4('wg0', { platform: 'linux', shell: shell.run, networkInterfaces: () => ({}) })).resolves.toBeNull();
    expect(shell.calls).toHaveLength(0);
    await expect(findInterfaceIPv4('bad"name', interfaces(shell.run))).rejects.toThrow(VpnError);
  });
});

describe('WireguardWindows', () => {
  it('installs and uninstalls the tunnel service through wireguard.exe', async () => {
    const shell = scriptedShell([{ match: (f) => f === DEFAULT_WIREGUARD_EXE, reply: {} }]);
    const wg = new WireguardWindows({}, { shell: shell.run, fileExists: exists, interfaces: interfaces(shell.run) });
    await expect(wg.install('C:\\vpn\\proton-nl.conf')).resolves.toBe('proton-nl');
    await wg.uninstall('proton-nl');
    expect(shell.calls).toEqual([
      { file: DEFAULT_WIREGUARD_EXE, args: ['/installtunnelservice', 'C:\\vpn\\proton-nl.conf'] },
      { file: DEFAULT_WIREGUARD_EXE, args: ['/uninstalltunnelservice', 'proton-nl'] },
    ]);
  });

  it('runs wg show <name> dump and maps failures', async () => {
    const ok = scriptedShell([{ match: (f) => f === WG, reply: { stdout: fixture('wg-show-dump.txt') } }]);
    const wg = new WireguardWindows({}, { shell: ok.run, fileExists: exists, interfaces: interfaces(ok.run) });
    expect((await wg.show('proton-nl')).peers[0]!.endpoint).toBe('185.159.157.1:51820');
    expect(ok.calls[0]).toEqual({ file: WG, args: ['show', 'proton-nl', 'dump'] });

    const missing = scriptedShell([{ match: () => true, reply: { code: 1, stderr: fixture('wg-show-missing.txt') } }]);
    const wg2 = new WireguardWindows({}, { shell: missing.run, fileExists: exists, interfaces: interfaces(missing.run) });
    expect((await caught(wg2.show('proton-nl'))).code).toBe('tunnel-not-found');

    const denied = scriptedShell([{ match: () => true, reply: { code: 1, stderr: 'Unable to open pipe: Access is denied.' } }]);
    const wg3 = new WireguardWindows({}, { shell: denied.run, fileExists: exists, interfaces: interfaces(denied.run) });
    // "Unable to access interface" is not in the message, so this is a permissions problem.
    expect((await caught(wg3.show('proton-nl'))).code).toBe('unauthorized');
  });

  it('reports not-installed when wireguard.exe is missing and honours the override path', async () => {
    const shell = scriptedShell([]);
    const missing = new WireguardWindows({}, { shell: shell.run, fileExists: async () => false, interfaces: interfaces(shell.run) });
    expect((await caught(missing.show('proton-nl'))).code).toBe('not-installed');
    const custom = new WireguardWindows(
      { wireguardExe: 'D:\\Tools\\WireGuard\\wireguard.exe' },
      { shell: shell.run, fileExists: async (p) => p.startsWith('D:\\Tools\\WireGuard\\'), interfaces: interfaces(shell.run) },
    );
    await expect(custom.locate()).resolves.toEqual({ wireguard: 'D:\\Tools\\WireGuard\\wireguard.exe', wg: 'D:\\Tools\\WireGuard\\wg.exe' });
  });
});
