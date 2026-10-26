import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { connectTcp, PeerConnection } from './peer/connection.js';
import { BLOCK_SIZE } from './peer/messages.js';
import { completed, payloadMatches, TestEnv, waitFor } from './test-utils.js';
import { startHttpTracker } from './tracker/test-trackers.js';

const env = new TestEnv();
afterEach(() => env.cleanup());

describe('super-seeding (BEP 16)', () => {
  it('reveals one piece at a time and the next only after the previous one was taken', async () => {
    const { seeder, meta, st } = await env.seed({ encryption: 'disabled' }, {}, {}, { superSeeding: true });
    expect(st.superSeeding).toBe(true);
    const sock = await connectTcp({ host: '127.0.0.1', port: seeder.listenPort });
    const client = new PeerConnection({
      socket: sock,
      incoming: false,
      infoHash: meta.infoHash,
      peerId: randomBytes(20),
      address: { host: '127.0.0.1', port: seeder.listenPort },
      reserved: { extensions: true, fast: true, dht: false },
    });
    env.defer(() => client.destroy());
    const haves: number[] = [];
    let sawFullAvailability = false;
    let sawHaveNone = false;
    client.on('have', (i) => haves.push(i));
    client.on('bitfield', () => (sawFullAvailability = true));
    client.on('haveAll', () => (sawFullAvailability = true));
    client.on('haveNone', () => (sawHaveNone = true));
    await waitFor(() => haves.length === 1, 3000);
    expect(sawHaveNone).toBe(true);
    expect(sawFullAvailability).toBe(false);
    const first = haves[0] as number;
    // download the offered piece
    client.interested();
    await waitFor(() => !client.peerChoking, 3000);
    // the offered piece may be the shorter last one
    const size = first === meta.pieceCount - 1 ? meta.totalLength - first * meta.pieceLength : meta.pieceLength;
    const blocks = Math.ceil(size / BLOCK_SIZE);
    let received = 0;
    client.on('piece', () => received++);
    for (let b = 0; b < blocks; b++) client.request(first, b * BLOCK_SIZE, Math.min(BLOCK_SIZE, size - b * BLOCK_SIZE));
    await waitFor(() => received === blocks, 3000);
    await new Promise((r) => setTimeout(r, 200));
    expect(haves).toHaveLength(1); // nothing new until we announce the piece
    client.have(first);
    await waitFor(() => haves.length === 2, 3000);
    expect(haves[1]).not.toBe(first);
    expect(sawFullAvailability).toBe(false);
  });

  it('completes a download from a super-seeding seed', async () => {
    const tr = await startHttpTracker({ interval: 1 });
    env.defer(() => tr.close());
    const { p, torrent, st } = await env.seed({}, {}, { announce: tr.url }, { superSeeding: true });
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir });
    const lt = await leecher.addTorrent({ torrent });
    await completed(lt);
    expect(await payloadMatches(dir, 'pack', p)).toBe(true);
    // switching it off at runtime is allowed
    st.setSuperSeeding(false);
    expect(st.superSeeding).toBe(false);
  }, 30_000);
});

describe('per-torrent rate limits', () => {
  it('limits one torrent download rate without a global limit', async () => {
    const tr = await startHttpTracker({ interval: 1 });
    env.defer(() => tr.close());
    const { p, torrent } = await env.seed({}, {}, { announce: tr.url });
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir });
    const start = Date.now();
    const lt = await leecher.addTorrent({ torrent, downloadLimit: 150_000, peerDownloadLimit: 0 });
    expect(lt.rateLimits.downloadLimit).toBe(150_000);
    await completed(lt);
    // ~410 KB at 150 KB/s with a one-second burst needs well over a second
    expect(Date.now() - start).toBeGreaterThan(1200);
    expect(await payloadMatches(dir, 'pack', p)).toBe(true);
    const saved = await lt.resumeData();
    expect(saved.downloadLimit).toBe(150_000);
  }, 30_000);

  it('limits upload per torrent and changes limits at runtime', async () => {
    const tr = await startHttpTracker({ interval: 1 });
    env.defer(() => tr.close());
    const { torrent, st } = await env.seed({}, {}, { announce: tr.url }, { uploadLimit: 1 });
    st.setRateLimits({ uploadLimit: 150_000, peerUploadLimit: 0 });
    expect(st.rateLimits).toMatchObject({ uploadLimit: 150_000, peerUploadLimit: 0 });
    const leecher = await env.session({ savePath: await env.tmp() });
    const start = Date.now();
    const lt = await leecher.addTorrent({ torrent });
    await completed(lt);
    expect(Date.now() - start).toBeGreaterThan(1200);
  }, 30_000);
});
