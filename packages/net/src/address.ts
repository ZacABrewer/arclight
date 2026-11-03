import { isIP } from 'node:net';

// Address classification for outbound requests a user or a remote party picks the target of
// (personal webhooks, push endpoints, podcast feeds, web seeds, tracker announces). "Blocked"
// means anything that is not a routable public unicast address: loopback, RFC 1918, CGNAT,
// link-local, unspecified, multicast, benchmarking, documentation and reserved ranges, plus
// every IPv6 form that embeds one of those (IPv4-mapped, IPv4-compatible, NAT64, 6to4).

function v4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

function blockedV4(o: readonly number[]): boolean {
  const [a, b, c] = [o[0]!, o[1]!, o[2]!];
  if (a === 0 || a === 10 || a === 127) return true; // this network, 10/8, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

/** Eight 16-bit groups, or null when `ip` is not an IPv6 literal. Accepts a trailing dotted IPv4. */
export function parseIpv6(raw: string): number[] | null {
  let ip = raw.toLowerCase();
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (isIP(ip) !== 6) return null;
  const lastColon = ip.lastIndexOf(':');
  const last = ip.slice(lastColon + 1);
  if (last.includes('.')) {
    // Trailing dotted IPv4 (::ffff:1.2.3.4): rewrite it as two hex groups.
    const o = v4Octets(last);
    if (!o) return null;
    ip = `${ip.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function v4FromGroups(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function blockedV6(g: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(8)) return true; // ::
  if (zeroTo(7) && g7 === 1) return true; // ::1
  if (zeroTo(5) && g5 === 0xffff) return true; // IPv4-mapped: never dial an IPv4 through its IPv6 form
  if (zeroTo(6)) return true; // IPv4-compatible ::a.b.c.d (deprecated)
  if (zeroTo(4) && g4 === 0xffff && g5 === 0) return true; // SIIT ::ffff:0:a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return blockedV4(v4FromGroups(g6, g7)); // NAT64 well-known prefix: judge the embedded IPv4
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // local-use NAT64 64:ff9b:1::/48
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard 100::/64
  if (g0 === 0x2001 && g1 < 0x200) return true; // 2001::/23 (Teredo, ORCHID, benchmarking)
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation
  if (g0 === 0x2002) return blockedV4(v4FromGroups(g1, g2)); // 6to4 embeds an IPv4
  if (g0 >> 4 === 0x3ff && (g0 & 0xf) === 0xf) return true; // 3fff::/20 documentation
  if (g0 === 0x5f00) return true; // SRv6 SIDs
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if (g0 >> 8 === 0xff) return true; // multicast
  return false;
}

/**
 * True when `ip` (an IP literal, IPv6 with or without brackets or a zone id) is not a public
 * unicast address. Anything that does not parse as an IP counts as blocked.
 */
export function isBlockedAddress(raw: string): boolean {
  const ip = raw.trim().replace(/^\[|\]$/g, '');
  const family = isIP(ip.split('%')[0] ?? '');
  if (family === 4) {
    const o = v4Octets(ip);
    return o ? blockedV4(o) : true;
  }
  if (family === 6) {
    const g = parseIpv6(ip);
    return g ? blockedV6(g) : true;
  }
  return true;
}

const LOCAL_SUFFIXES = /\.(local|lan|internal|home\.arpa|intranet|corp|home|localdomain|localhost)$/;

/**
 * Normalise a host name the way the WHATWG URL parser does (so `0x7f.1`, `0177.0.0.1` and
 * `127.1` all become `127.0.0.1`), lower-cased, without brackets or a trailing dot.
 */
export function normalizeHost(rawHost: string): string {
  let host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  try {
    const parsed = new URL(`http://${host.includes(':') ? `[${host}]` : host}/`).hostname;
    host = parsed.replace(/^\[|\]$/g, '');
  } catch {
    // Keep the raw form; the checks below treat it conservatively.
  }
  return host.replace(/\.$/, '');
}

/**
 * Host-name check without DNS, for validating what a user saves: IP literals in a blocked
 * range, `localhost`, LAN-only suffixes and single-label names (container or LAN host names)
 * all count as private. A public-looking name can still resolve to a private address, so
 * requests must also go through the resolving guard (`createSafeFetch` / `guardedLookup`).
 */
export function isPrivateHostname(rawHost: string): boolean {
  const host = normalizeHost(rawHost);
  if (host === '' || host === 'localhost') return true;
  if (isIP(host.split('%')[0] ?? '')) return isBlockedAddress(host);
  if (LOCAL_SUFFIXES.test(host)) return true;
  return !host.includes('.');
}
