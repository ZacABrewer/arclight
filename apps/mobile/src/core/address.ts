import { DEFAULT_PORT } from '../config.js';

// Turning what someone types ("192.168.1.20:7878", "arclight.example.com", "http://nas/arclight")
// into the ordered list of base URLs worth probing.
//
// Rules (kept deliberately small):
//  - A scheme typed by the user is respected, except that a typed http:// to a public host is
//    tried over https:// first (core/transport.ts: prefer https). Without a port we also try
//    :7878 (Arclight's default).
//  - Without a scheme, https:// is tried first. http:// is added only for private/LAN hosts and
//    bare IPs (a plain-http server on the public internet must be typed as http:// explicitly).
//  - Without a port we try the scheme's default port first, then :7878.
//  - A path (reverse-proxy sub-path) is kept; trailing slashes, query and fragment are dropped.
// The caller probes every candidate and keeps the first one, in this order, that is Arclight.

export interface ParsedAddress {
  host: string;
  /** Host without IPv6 brackets. */
  hostname: string;
  port: number | null;
  path: string;
  scheme: 'http' | 'https' | null;
  isIp: boolean;
  isPrivate: boolean;
}

export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressError';
  }
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIPv4(host: string): boolean {
  const m = IPV4.exec(host);
  return !!m && m.slice(1).every((p) => Number(p) <= 255);
}

export function isIPv6(host: string): boolean {
  return host.includes(':') && /^[0-9a-f:.]+(%.+)?$/i.test(host);
}

/** Hostname suffixes that only resolve on a home network or a private overlay (Tailscale). */
const PRIVATE_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.home.arpa', '.localdomain', '.ts.net'];

/**
 * Private, loopback, link-local, CGNAT (Tailscale's 100.64/10) addresses and LAN-only names.
 * Used for two things: allowing an http:// fallback and suppressing the "unencrypted" warning.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIPv4(h)) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIPv6(h)) {
    return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  }
  if (!h.includes('.')) return true; // single-label name ("nas", "arclight")
  return PRIVATE_SUFFIXES.some((s) => h.endsWith(s));
}

export function parseAddress(input: string): ParsedAddress {
  let rest = input.trim();
  if (!rest) throw new AddressError('Enter the address of your Arclight server.');
  if (/\s/.test(rest)) throw new AddressError('The address cannot contain spaces.');

  let scheme: ParsedAddress['scheme'] = null;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (schemeMatch) {
    const s = schemeMatch[1]!.toLowerCase();
    if (s !== 'http' && s !== 'https') throw new AddressError('Only http:// and https:// addresses are supported.');
    scheme = s;
    rest = rest.slice(schemeMatch[0].length);
  }

  // Drop query/fragment, split host from path.
  rest = rest.replace(/[?#].*$/, '');
  const slash = rest.indexOf('/');
  let authority = slash === -1 ? rest : rest.slice(0, slash);
  let path = slash === -1 ? '' : rest.slice(slash);
  if (authority.includes('@')) throw new AddressError('Leave out the user name and password; sign in on the server page.');

  let hostname: string;
  let port: number | null = null;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end === -1) throw new AddressError('That IPv6 address is missing a closing "]".');
    hostname = authority.slice(1, end);
    const after = authority.slice(end + 1);
    if (after) {
      if (!/^:\d+$/.test(after)) throw new AddressError('That address has an invalid port.');
      port = Number(after.slice(1));
    }
  } else if ((authority.match(/:/g) ?? []).length > 1) {
    hostname = authority; // bare IPv6 without brackets: no port possible
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon !== -1) {
      const p = authority.slice(colon + 1);
      if (!/^\d+$/.test(p)) throw new AddressError('That address has an invalid port.');
      port = Number(p);
      authority = authority.slice(0, colon);
    }
    hostname = authority;
  }

  hostname = hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) throw new AddressError('Enter the address of your Arclight server.');
  if (port !== null && (port < 1 || port > 65535)) throw new AddressError('The port must be between 1 and 65535.');
  const v6 = isIPv6(hostname);
  if (!v6 && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(hostname)) {
    throw new AddressError('That does not look like a server address.');
  }

  path = path.replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  return {
    host: v6 ? `[${hostname}]` : hostname,
    hostname,
    port,
    path,
    scheme,
    isIp: v6 || isIPv4(hostname),
    isPrivate: isPrivateHost(hostname),
  };
}

function build(scheme: 'http' | 'https', a: ParsedAddress, port: number | null): string {
  const defaultPort = scheme === 'https' ? 443 : 80;
  const portPart = port === null || port === defaultPort ? '' : `:${port}`;
  return `${scheme}://${a.host}${portPart}${a.path}`;
}

/** Ordered, de-duplicated base URLs to probe for what the user typed. */
export function candidateUrls(input: string | ParsedAddress): string[] {
  const a = typeof input === 'string' ? parseAddress(input) : input;
  const schemes: Array<'http' | 'https'> =
    a.scheme === 'http' && !a.isPrivate ? ['https', 'http'] : a.scheme ? [a.scheme] : a.isPrivate || a.isIp ? ['https', 'http'] : ['https'];
  const ports: Array<number | null> = a.port !== null ? [a.port] : [null, DEFAULT_PORT];
  const out: string[] = [];
  // Port is the outer loop: "host" on its default port beats "host:7878" for either scheme.
  for (const port of ports) for (const scheme of schemes) out.push(build(scheme, a, port));
  return [...new Set(out)];
}

/** Canonical form of a base URL (lower-case scheme/host, no default port, no trailing slash). */
export function normalizeBaseUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

/** Plain HTTP to a host that is not on the LAN: show a warning before saving. */
export function isInsecurePublic(url: string): boolean {
  const u = new URL(url);
  return u.protocol === 'http:' && !isPrivateHost(u.hostname);
}
