import { BlockList, isIP } from 'node:net';

// Trusted-proxy matching for forward-auth. Only the TCP peer of the connection is checked: the
// X-Forwarded-For chain is written by whoever connects, so it never makes a peer trusted.

/** Strips an IPv6 zone and unwraps IPv4-mapped IPv6 (::ffff:10.0.0.1 → 10.0.0.1). */
export function normalizeAddress(raw: string): string {
  let ip = raw.trim();
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped?.[1] ?? ip;
}

/** Parses "10.0.0.0/8", "172.18.0.2" or "fd00::/8"; null when it is neither an IP nor a CIDR. */
export function parseCidr(entry: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [rawAddr, rawPrefix, extra] = entry.trim().split('/');
  if (extra !== undefined || !rawAddr) return null;
  const address = normalizeAddress(rawAddr);
  const version = isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  if (rawPrefix !== undefined && !/^\d{1,3}$/.test(rawPrefix)) return null;
  const prefix = rawPrefix === undefined ? max : Number(rawPrefix);
  if (prefix < 0 || prefix > max) return null;
  return { address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' };
}

/** Entries that are not IPs or CIDRs (shown as a validation error in settings). */
export function invalidProxyEntries(entries: readonly string[]): string[] {
  return entries.filter((e) => parseCidr(e) === null);
}

export class TrustedProxies {
  private readonly list = new BlockList();
  readonly size: number;

  constructor(entries: readonly string[]) {
    let n = 0;
    for (const entry of entries) {
      const parsed = parseCidr(entry);
      if (!parsed) continue;
      this.list.addSubnet(parsed.address, parsed.prefix, parsed.family);
      n++;
    }
    this.size = n;
  }

  /** True when the socket peer is one of the trusted proxies. */
  trusts(peer: string | undefined): boolean {
    if (!peer || this.size === 0) return false;
    const address = normalizeAddress(peer);
    const version = isIP(address);
    if (version === 0) return false;
    return this.list.check(address, version === 4 ? 'ipv4' : 'ipv6');
  }
}
