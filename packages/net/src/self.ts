import { subscribe } from 'node:diagnostics_channel';
import type { Socket } from 'node:net';

// Requests this process makes to itself (DATA-01). The "no login for local addresses" rule
// must never apply to them: otherwise any outbound request a user or a remote server can
// steer (a webhook, a redirect, a feed) that lands on Arclight's own port runs as admin.
//
// Two signals, either is enough:
//  - every client socket this process opens is recorded by its local address and port (Node's
//    `net.client.socket` diagnostics channel sees fetch/undici and node:http alike), so a
//    request whose TCP peer is one of our own outbound sockets is ours;
//  - the safe fetch stamps `x-arclight-outbound: 1` on every request, which a reverse proxy in
//    front of Arclight passes through when an outbound request loops back via the proxy.

/** Header stamped on every request made through the safe fetch. */
export const OUTBOUND_HEADER = 'x-arclight-outbound';

const open = new Set<string>();
let tracking = false;

function key(address: string | undefined, port: number | undefined): string | null {
  if (!address || !port) return null;
  const a = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return `${a}|${port}`;
}

/** Start recording this process's outbound sockets (idempotent). */
export function trackOutboundSockets(): void {
  if (tracking) return;
  tracking = true;
  subscribe('net.client.socket', (message) => {
    const socket = (message as { socket?: Socket }).socket;
    if (!socket) return;
    let k: string | null = null;
    socket.once('connect', () => {
      k = key(socket.localAddress, socket.localPort);
      if (k) open.add(k);
    });
    socket.once('close', () => {
      if (k) open.delete(k);
    });
  });
}

/** Whether a TCP peer (remote address + port of an incoming socket) is one of our own outbound sockets. */
export function isOwnOutboundSocket(address: string | undefined, port: number | undefined): boolean {
  const k = key(address, port);
  return k !== null && open.has(k);
}
