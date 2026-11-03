import { invalidProxyEntries, TrustedProxies } from './modules/auth/trusted-proxies.js';

// Which TCP peers may set X-Forwarded-For / -Proto / -Host (ARCLIGHT_TRUSTED_PROXIES). Fastify
// walks the forwarded chain from the right and stops at the first address that is not trusted, so
// req.ip is the first untrusted hop: a client cannot pick its own address by sending the header,
// because the proxy in front of it appends the real one after it.
//
//   unset        loopback and private ranges (a proxy on the same machine, the LAN or a Docker
//                network); clients on the internet always reach Arclight through such a proxy or
//                directly with their public address, which is never trusted
//   10.0.0.2,…   only these addresses / CIDRs (the strict setting: the proxy's own address)
//   2            trust this many hops from the right, whoever they are
//   all / true   every peer (the pre-0.24 behaviour; X-Forwarded-For is client-controlled)
//   none / false no peer: req.ip is always the socket address

/** Loopback, RFC 1918, link-local and IPv6 unique-local: the same ranges as the local-address rule. */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fc00::/7',
  'fe80::/10',
];

export type TrustProxySetting = boolean | ((address: string, hop: number) => boolean);

export interface ParsedTrustProxy {
  setting: TrustProxySetting;
  /** Human-readable form for the startup log. */
  describe: string;
  /** Entries of a CIDR list that are neither an IP nor a CIDR (ignored; logged as a warning). */
  invalid: string[];
}

export function parseTrustedProxies(raw: string | undefined): ParsedTrustProxy {
  const value = raw?.trim() ?? '';
  if (value === '') return listSetting(DEFAULT_TRUSTED_PROXIES, 'loopback and private networks (default)');
  const lower = value.toLowerCase();
  if (lower === 'all' || lower === 'true' || lower === '*') return { setting: true, describe: 'every peer', invalid: [] };
  if (lower === 'none' || lower === 'false' || lower === '0') return { setting: false, describe: 'none', invalid: [] };
  if (/^\d{1,2}$/.test(value)) {
    // The first `n` hops from the socket inwards (the same rule as proxy-addr's hop count).
    const hops = Number(value);
    return { setting: hops === 0 ? false : (_address, hop) => hop < hops, describe: `${value} hop(s)`, invalid: [] };
  }
  const entries = value.split(/[\s,]+/).filter(Boolean);
  const named = entries.flatMap((e) => (e.toLowerCase() === 'private' ? DEFAULT_TRUSTED_PROXIES : [e]));
  const parsed = listSetting(named, named.join(', '));
  return { ...parsed, invalid: invalidProxyEntries(named) };
}

function listSetting(entries: readonly string[], describe: string): ParsedTrustProxy {
  const list = new TrustedProxies(entries);
  if (list.size === 0) return { setting: false, describe: 'none', invalid: [] };
  return { setting: (address) => list.trusts(address), describe, invalid: [] };
}
