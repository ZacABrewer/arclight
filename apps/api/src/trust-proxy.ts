import { isIP } from 'node:net';

// Which peers may set X-Forwarded-For / -Proto / -Host (Fastify's `trustProxy`). Trusting every
// peer let anyone who reaches the port directly spoof the client address (audit log, sign-in
// throttles) and the host used to build links. ARCLIGHT_TRUST_PROXY overrides the default:
//   unset / empty          DEFAULT_TRUST_PROXY: loopback, private and link-local ranges plus
//                          CGNAT/Tailscale, i.e. a reverse proxy on the same host, in Docker or
//                          on the LAN/tailnet
//   true | false           trust every peer / none (headers ignored)
//   <n>                    trust the n closest hops, whatever their address
//   a,b,c                  IPs, CIDRs (10.0.0.0/8, fd00::/8, 10.0.0.0/255.0.0.0) and the names
//                          loopback, linklocal, uniquelocal (proxy-addr's built-in ranges)

/** What Fastify's `trustProxy` option accepts (a hop count is passed as a function). */
export type TrustProxy = boolean | string | ((address: string, hop: number) => boolean);

const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** Loopback, link-local, RFC 1918 / fc00::/7, and 100.64.0.0/10 (CGNAT, used by Tailscale). */
export const DEFAULT_TRUST_PROXY = 'loopback,linklocal,uniquelocal,100.64.0.0/10';

function validEntry(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) return true;
  const slash = entry.indexOf('/');
  if (slash < 0) return isIP(entry) !== 0;
  const ip = entry.slice(0, slash);
  const mask = entry.slice(slash + 1);
  const family = isIP(ip);
  if (family === 0) return false;
  if (/^\d{1,3}$/.test(mask)) return Number(mask) <= (family === 4 ? 32 : 128);
  return family === 4 && isIP(mask) === 4;
}

/** Parses ARCLIGHT_TRUST_PROXY; throws on an entry Fastify would reject or misread. */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = raw?.trim() ?? '';
  if (value === '') return DEFAULT_TRUST_PROXY;
  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(value)) {
    // Fastify also takes a number at runtime but not in its types; this is the same check.
    const hops = Number(value);
    return (_address, hop) => hop < hops;
  }
  const entries = value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const bad = entries.filter((e) => !validEntry(e.toLowerCase()));
  if (entries.length === 0 || bad.length > 0) {
    throw new Error(
      `ARCLIGHT_TRUST_PROXY: not an IP, CIDR or range name: ${bad.join(', ') || value}. ` +
        'Use true, false, a hop count, or a comma list such as "loopback,uniquelocal,203.0.113.7".',
    );
  }
  return entries.map((e) => (NAMED_RANGES.has(e.toLowerCase()) ? e.toLowerCase() : e)).join(',');
}
