import { isIP } from 'node:net';

// Address classification for the "skip auth for local addresses" rule. Local means
// loopback, RFC 1918 private IPv4, IPv4 link-local, IPv6 unique-local (fc00::/7) and IPv6
// link-local (fe80::/10). IPv4-mapped IPv6 addresses are unwrapped first.

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

export function isLocalAddress(raw: string | undefined | null): boolean {
  if (!raw) return false;
  let ip = raw.trim();
  // Strip an IPv6 zone id (fe80::1%eth0) and IPv4-mapped prefix (::ffff:10.0.0.1).
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) ip = mapped[1];

  const family = isIP(ip);
  if (family === 4) {
    const o = ipv4Octets(ip);
    if (!o) return false;
    const [a, b] = [o[0]!, o[1]!];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
    return false;
  }
  return false;
}

/**
 * Every hop must be local. With trustProxy the forwarded chain is client-controlled, so the
 * socket peer and each forwarded address all have to qualify; a spoofed X-Forwarded-For
 * from a public peer therefore never passes.
 */
export function allLocal(addresses: readonly (string | undefined)[]): boolean {
  const present = addresses.filter((a): a is string => typeof a === 'string' && a.length > 0);
  return present.length > 0 && present.every(isLocalAddress);
}
