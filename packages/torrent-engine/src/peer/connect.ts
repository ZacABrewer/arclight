import type { Duplex } from 'node:stream';
import type { PeerAddress } from '../compact.js';
import { TorrentEngineError } from '../errors.js';
import type { UtpManager } from '../utp/manager.js';
import { connectTcp, type PeerTransport } from './connection.js';
import { type EncryptionMode, mseInitiate } from './mse.js';

export interface OpenPeerOptions {
  infoHash: Buffer;
  encryption: EncryptionMode;
  /** Transports to try, in order. */
  transports: PeerTransport[];
  localAddress?: string;
  timeoutMs: number;
  utp: UtpManager | null;
  /** The peer is known to refuse MSE: with `preferred`, go straight to plaintext. */
  plainOnly?: boolean;
}

export interface OpenedPeer {
  stream: Duplex;
  transport: PeerTransport;
  /** RC4 negotiated. */
  encrypted: boolean;
  /** MSE failed and the connection fell back to plaintext. */
  fellBack: boolean;
}

async function rawConnect(transport: PeerTransport, addr: PeerAddress, opts: OpenPeerOptions): Promise<Duplex> {
  if (transport === 'utp') {
    if (!opts.utp?.attached) throw new TorrentEngineError('peer', 'utp is not available');
    return opts.utp.connect(addr, opts.timeoutMs);
  }
  const c: Parameters<typeof connectTcp>[1] = { timeoutMs: opts.timeoutMs };
  if (opts.localAddress) c.localAddress = opts.localAddress;
  return connectTcp(addr, c);
}

/**
 * Opens an outgoing peer stream: tries each transport in order and, depending on the
 * encryption policy, runs the MSE handshake first (`preferred` falls back to a fresh
 * plaintext connection on the same transport when MSE fails; `required` never does).
 */
export async function openPeerStream(addr: PeerAddress, opts: OpenPeerOptions): Promise<OpenedPeer> {
  let lastErr: unknown = new TorrentEngineError('peer', 'no transport enabled');
  const tryMse = opts.encryption === 'required' || (opts.encryption === 'preferred' && !opts.plainOnly);
  for (const transport of opts.transports) {
    let raw: Duplex;
    try {
      raw = await rawConnect(transport, addr, opts);
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (!tryMse) return { stream: raw, transport, encrypted: false, fellBack: false };
    try {
      const res = await mseInitiate(raw, {
        infoHash: opts.infoHash,
        allowPlaintext: opts.encryption === 'preferred',
        timeoutMs: opts.timeoutMs,
      });
      return { stream: res.stream, transport, encrypted: res.method === 'rc4', fellBack: false };
    } catch (err) {
      raw.destroy();
      lastErr = err;
      if (opts.encryption === 'required') continue;
    }
    try {
      return { stream: await rawConnect(transport, addr, opts), transport, encrypted: false, fellBack: true };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
