import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { duplexPair, type Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { completed, payloadMatches, TestEnv, waitFor } from '../test-utils.js';
import { startHttpTracker } from '../tracker/test-trackers.js';
import { connectTcp, PeerConnection } from './connection.js';
import { PeerListener } from './listener.js';
import { buildReserved, encodeHandshake } from './messages.js';
import { dhKeyPair, dhSecret, MSE_KEY_BYTES, MSE_PRIME, mseInitiate, mseReq2, mseRespond } from './mse.js';
import { RC4 } from './rc4.js';

const env = new TestEnv();
afterEach(() => env.cleanup());

/** Records everything written into `side` (what goes on the wire). */
function tap(side: Duplex): Buffer[] {
  const seen: Buffer[] = [];
  const write = side.write.bind(side) as (chunk: Buffer, cb?: (err?: Error | null) => void) => boolean;
  (side as { write: unknown }).write = (chunk: Buffer, ...rest: unknown[]) => {
    seen.push(Buffer.from(chunk));
    return write(chunk, ...(rest as [((err?: Error | null) => void)?]));
  };
  return seen;
}

function readSome(stream: Duplex, n: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const on = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= n) {
        stream.off('data', on);
        resolve(buf);
      }
    };
    stream.on('data', on);
  });
}

describe('RC4', () => {
  it('matches the classic test vectors', () => {
    const vec = (key: string, plain: string) => new RC4(Buffer.from(key)).update(Buffer.from(plain)).toString('hex');
    expect(vec('Key', 'Plaintext')).toBe('bbf316e8d940af0ad3');
    expect(vec('Wiki', 'pedia')).toBe('1021bf0420');
    expect(vec('Secret', 'Attack at dawn')).toBe('45a01f645fc35b383552544b9bf5');
  });

  it('discards the first keystream bytes and decrypts symmetrically', () => {
    const key = randomBytes(20);
    const full = new RC4(key).update(Buffer.alloc(1024 + 64));
    const discarded = new RC4(key, 1024).update(Buffer.alloc(64));
    expect(discarded.equals(full.subarray(1024))).toBe(true);
    const msg = randomBytes(5000);
    const ct = new RC4(key, 1024).update(msg);
    expect(ct.equals(msg)).toBe(false);
    // decrypting in uneven chunks gives the same plaintext
    const dec = new RC4(key, 1024);
    expect(Buffer.concat([dec.update(ct.subarray(0, 7)), dec.update(ct.subarray(7))]).equals(msg)).toBe(true);
  });
});

describe('Diffie-Hellman', () => {
  it('agrees on a 96-byte shared secret with 160-bit private keys', () => {
    const a = dhKeyPair();
    const b = dhKeyPair();
    expect(a.publicKey.length).toBe(MSE_KEY_BYTES);
    expect(a.privateKey < 1n << 160n).toBe(true);
    const s1 = dhSecret(a.privateKey, b.publicKey);
    const s2 = dhSecret(b.privateKey, a.publicKey);
    expect(s1.length).toBe(96);
    expect(s1.equals(s2)).toBe(true);
    expect(MSE_PRIME.toString(16).length).toBe(192);
    // the MSE spec's prime, not the first Oakley group's (which ends ...A63A3620FFFFFFFFFFFFFFFF)
    expect(MSE_PRIME.toString(16).toUpperCase().endsWith('A63A36210000000000090563')).toBe(true);
  });

  it('rejects degenerate public keys', () => {
    const a = dhKeyPair();
    const one = Buffer.alloc(96);
    one[95] = 1;
    expect(() => dhSecret(a.privateKey, one)).toThrow('invalid public key');
    expect(() => dhSecret(a.privateKey, Buffer.alloc(10))).toThrow('length');
  });
});

describe('MSE handshake', () => {
  const infoHash = randomBytes(20);
  const find = (req2: Buffer) => (req2.equals(mseReq2(infoHash)) ? infoHash : null);

  it('runs both roles against each other and encrypts the payload', async () => {
    const [a, b] = duplexPair();
    const wireA = tap(a);
    const initial = Buffer.alloc(0);
    const [ia, rb] = await Promise.all([
      mseInitiate(a, { infoHash, allowPlaintext: false }),
      mseRespond(b, initial, { findInfoHash: find, allowPlaintext: false }),
    ]);
    expect(ia.method).toBe('rc4');
    expect(rb.method).toBe('rc4');
    expect(rb.infoHash.equals(infoHash)).toBe(true);
    const secret = Buffer.from('\x13BitTorrent protocol, hello from the initiator');
    const got = readSome(rb.stream, secret.length);
    ia.stream.write(secret);
    expect((await got).equals(secret)).toBe(true);
    // the plaintext never appears on the wire
    expect(Buffer.concat(wireA).includes(Buffer.from('BitTorrent protocol'))).toBe(false);
    const reply = randomBytes(40_000);
    const back = readSome(ia.stream, reply.length);
    rb.stream.write(reply);
    expect((await back).equals(reply)).toBe(true);
    ia.stream.destroy();
    rb.stream.destroy();
  });

  it('refuses an unknown info-hash and times out against a silent peer', async () => {
    const [a, b] = duplexPair();
    const res = Promise.allSettled([
      mseInitiate(a, { infoHash, allowPlaintext: true, timeoutMs: 500 }),
      mseRespond(b, Buffer.alloc(0), { findInfoHash: () => null, allowPlaintext: true, timeoutMs: 500 }),
    ]);
    const [i, r] = await res;
    expect(r.status).toBe('rejected');
    expect(String((r as PromiseRejectedResult).reason)).toMatch(/unknown info-hash/);
    expect(i.status).toBe('rejected');
    const [c] = duplexPair();
    await expect(mseInitiate(c, { infoHash, allowPlaintext: true, timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });

  it('lets the listener tell plaintext from MSE and enforce the policy', async () => {
    const results: { encrypted: boolean }[] = [];
    let mode: 'disabled' | 'preferred' | 'required' = 'preferred';
    const listener = new PeerListener({ encryption: () => mode, findInfoHash: find, handshakeTimeoutMs: 1000 });
    await listener.listen(0, '127.0.0.1');
    env.defer(() => listener.close());
    listener.on('connection', (sock, hs, address, info) => {
      results.push({ encrypted: info.encrypted });
      const conn = new PeerConnection({ socket: sock, incoming: true, infoHash: hs.infoHash, peerId: randomBytes(20), address, reserved: { extensions: true, fast: true, dht: false }, encrypted: info.encrypted });
      env.defer(() => conn.destroy());
    });
    const hs = encodeHandshake({ reserved: buildReserved({ extensions: true, fast: true, dht: false }), infoHash, peerId: randomBytes(20) });
    const plainClient = async (): Promise<net.Socket> => {
      const s = await connectTcp({ host: '127.0.0.1', port: listener.port });
      env.defer(() => s.destroy());
      s.write(hs);
      return s;
    };
    const encClient = async (): Promise<Duplex> => {
      const s = await connectTcp({ host: '127.0.0.1', port: listener.port });
      env.defer(() => s.destroy());
      const r = await mseInitiate(s, { infoHash, allowPlaintext: true });
      r.stream.write(hs);
      return r.stream;
    };
    // preferred: both are accepted
    await plainClient();
    await encClient();
    await waitFor(() => results.length === 2, 3000);
    expect(results.map((r) => r.encrypted).sort()).toEqual([false, true]);
    // required: plaintext is dropped
    mode = 'required';
    const p = await plainClient();
    await new Promise<void>((resolve) => p.once('close', () => resolve()));
    await encClient();
    await waitFor(() => results.length === 3, 3000);
    expect(results[2]?.encrypted).toBe(true);
    // disabled: MSE is dropped
    mode = 'disabled';
    const s = await connectTcp({ host: '127.0.0.1', port: listener.port });
    env.defer(() => s.destroy());
    await expect(mseInitiate(s, { infoHash, allowPlaintext: true, timeoutMs: 2000 })).rejects.toThrow();
    expect(results.length).toBe(3);
  });
});

describe('Session encryption', () => {
  it('downloads over RC4 when both sides require encryption', async () => {
    const tr = await startHttpTracker({ interval: 1 });
    env.defer(() => tr.close());
    const { p, torrent } = await env.seed({ encryption: 'required' }, {}, { announce: tr.url });
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir, encryption: 'required' });
    const lt = await leecher.addTorrent({ torrent });
    await waitFor(() => lt.getPeers().length > 0);
    expect(lt.getPeers().every((x) => x.encrypted)).toBe(true);
    await completed(lt);
    expect(await payloadMatches(dir, 'pack', p)).toBe(true);
  }, 30_000);

  it('never connects a required peer to a plaintext-only peer', async () => {
    const tr = await startHttpTracker({ interval: 1 });
    env.defer(() => tr.close());
    const { torrent, st } = await env.seed({ encryption: 'disabled' }, {}, { announce: tr.url });
    const leecher = await env.session({ savePath: await env.tmp(), encryption: 'required' });
    const lt = await leecher.addTorrent({ torrent });
    await waitFor(() => tr.announces.length >= 2);
    await new Promise((r) => setTimeout(r, 800));
    expect(lt.getStats().connectedPeers).toBe(0);
    expect(st.getStats().connectedPeers).toBe(0);
  }, 30_000);

  it('falls back to plaintext when the peer has encryption disabled (preferred)', async () => {
    const tr = await startHttpTracker({ interval: 1 });
    env.defer(() => tr.close());
    const { p, torrent } = await env.seed({ encryption: 'disabled' }, {}, { announce: tr.url });
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir, encryption: 'preferred' });
    const lt = await leecher.addTorrent({ torrent });
    await completed(lt);
    expect(await payloadMatches(dir, 'pack', p)).toBe(true);
    expect(lt.getPeers().every((x) => !x.encrypted && x.transport === 'tcp')).toBe(true);
  }, 30_000);
});
