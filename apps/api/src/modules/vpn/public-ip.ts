import { VpnError } from './errors.js';

// Public IP lookup for the native providers. Node's fetch cannot bind a request to a local
// address, so this request follows the OS routing table: with a full-tunnel WireGuard config
// (AllowedIPs = 0.0.0.0/0) it leaves through the VPN; with a split tunnel or a VPN app that
// does not route everything it may not. Comparing the answer with `homePublicIp` is how leaks
// are detected (see README, "Native Windows VPN").

const IPV4_OR_6 = /^[0-9a-fA-F:.]{3,45}$/;

export async function fetchPublicIp(fetchImpl: typeof globalThis.fetch, url: string, timeoutMs = 5_000): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json, text/plain' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new VpnError('timeout', `Public IP check timed out (${url}).`, { cause: err });
    throw new VpnError('unreachable', `Public IP check failed: ${(err as Error).message ?? err}`, { cause: err });
  }
  if (!res.ok) throw new VpnError('bad-response', `Public IP check answered ${res.status}.`, { httpStatus: res.status });
  const text = (await res.text()).trim();
  let ip = text;
  if (text.startsWith('{')) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const value = body['ip'] ?? body['public_ip'] ?? body['query'];
      ip = typeof value === 'string' ? value : '';
    } catch {
      ip = '';
    }
  }
  if (!IPV4_OR_6.test(ip)) throw new VpnError('bad-response', 'Public IP check returned something that is not an IP address.');
  return ip;
}
