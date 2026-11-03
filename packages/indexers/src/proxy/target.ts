import net from 'node:net';
import { BlockedAddressError, isPrivateHostname, normalizeHost, resolveAllowed, type TargetPolicy } from '@arclight/net';
import { ProxyError } from './errors.js';

/**
 * Which address a proxy tunnel is asked to open, for one request URL.
 *
 * A proxy normally resolves the target name itself, so a public name that resolves (or later
 * rebinds) to a loopback / LAN address would slip past a check made on the name. For targets
 * that must be public, the name is resolved here instead, every answer is vetted, and the proxy
 * is handed the vetted IP (HTTP CONNECT `ip:port`, SOCKS5 IPv4/IPv6 address type). The Host
 * header, TLS SNI and the certificate check still use the original name.
 *
 * `undefined` (or a policy with `allowPrivate` and no `allowAddress` seam) keeps the old
 * behaviour: the name goes to the proxy unresolved. That is for admin-configured targets
 * (the indexer's own site, which may sit on the LAN or only resolve through the proxy).
 */
export type ProxyTargetPolicy = (url: URL) => TargetPolicy | undefined;

function blocked(host: string, cause?: unknown): ProxyError {
  return new ProxyError('blocked', `Refusing to reach ${host} through the proxy: it is a local or reserved network address`, cause === undefined ? undefined : { cause });
}

/**
 * The host to pass to the proxy for `hostname`. With a public-only policy:
 * - an IP literal must be public;
 * - `.onion` names go to the proxy as names (only a Tor proxy can reach them);
 * - a name that resolves locally must resolve only to allowed addresses, and the first one
 *   (IPv4 preferred, since many proxies have no IPv6 route) is used;
 * - a name local DNS cannot resolve (a proxy-only DNS view) goes to the proxy as a name,
 *   unless it looks private (`localhost`, `.lan`, `.local`, a single label, ...). The proxy's
 *   own resolver then decides where it lands: that fallback cannot be vetted here.
 * Throws `ProxyError('blocked')` before any tunnel is opened when the target is refused.
 */
export async function proxyDialHost(hostname: string, policy: TargetPolicy | undefined): Promise<string> {
  const raw = hostname.replace(/^\[|\]$/g, '');
  if (!policy || (policy.allowPrivate === true && !policy.allowAddress)) return raw;
  const host = normalizeHost(raw);
  if (net.isIP(host)) {
    try {
      await resolveAllowed(host, policy);
    } catch (err) {
      throw blocked(host, err);
    }
    return host;
  }
  if (host.endsWith('.onion')) return host;
  let answers;
  try {
    answers = await resolveAllowed(host, policy);
  } catch (err) {
    if (err instanceof BlockedAddressError) throw blocked(host, err);
    // Local DNS has no answer: let the proxy resolve it, but never a LAN-looking name.
    if (isPrivateHostname(host)) throw blocked(host, err);
    return host;
  }
  const pick = answers.find((a) => a.family === 4) ?? answers[0];
  if (!pick) throw blocked(host);
  return pick.address;
}
