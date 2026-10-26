import { mkdir } from 'node:fs/promises';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { Session } from '@arclight/torrent-engine';
import { TorrentDetail, TorrentSessionStatus, TorrentSettingsResponse } from '@arclight/shared';
import { torrentRoutes } from './routes.js';
import { withTransportDefaults } from './service.js';
import { FAST, harness, seededTorrent, waitFor, type Harness } from './test-support.js';

// Engine transport settings (encryption, tcp/utp/ipv6, web seeds), per-torrent limits and
// super-seeding exposed through the torrent module.

const open: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

async function build(settings: Record<string, unknown> = {}) {
  const h = await harness({ settings });
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(torrentRoutes(h.service), { prefix: '/api/v1' });
  open.push(() => h.cleanup(), () => app.close());
  return { h, app };
}

/** A running engine with one seeding torrent; returns its info-hash. */
async function withSeedingTorrent(h: Harness): Promise<string> {
  await h.service.start();
  const root = h.service.effectiveDownloadsRoot();
  await mkdir(root, { recursive: true });
  const { torrent, infoHash } = await seededTorrent(root);
  const t = await h.service.session!.addTorrent({ torrent });
  await waitFor(() => t.state === 'seeding');
  return infoHash;
}

describe('torrent transport settings', () => {
  it('fills the engine defaults for settings saved before the transport options existed', async () => {
    const { app } = await build();
    const res = TorrentSettingsResponse.parse((await app.inject({ method: 'GET', url: '/api/v1/settings/torrent' })).json());
    expect(res).toMatchObject({ encryption: 'preferred', tcp: true, utp: true, ipv6: true, webSeedConnectionsPerTorrent: 4 });
    expect(withTransportDefaults({ ...res, encryption: 'required' }).encryption).toBe('required');
  });

  it('starts the session with the configured encryption, transports and web seed connections', async () => {
    const { h } = await build({ enabled: true, encryption: 'required', ipv6: false, webSeedConnectionsPerTorrent: 2 });
    await h.service.start();
    expect(h.service.session!.settings).toMatchObject({ encryption: 'required', ipv6: false, webSeedConnectionsPerTorrent: 2, tcp: true, utp: true });
  });

  it('applies encryption and web seed connections live, without a restart', async () => {
    const { h, app } = await build({ enabled: true });
    await h.service.start();
    const session = h.service.session;
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/torrent', payload: { encryption: 'disabled', webSeedConnectionsPerTorrent: 0 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ encryption: 'disabled', webSeedConnectionsPerTorrent: 0 });
    expect(h.service.session).toBe(session);
    expect(session!.settings).toMatchObject({ encryption: 'disabled', webSeedConnectionsPerTorrent: 0 });
  });

  it('re-opens the sockets on the same port when uTP or TCP is toggled', async () => {
    const { h } = await build({ enabled: true });
    await h.service.start();
    const session = h.service.session!;
    expect(session.utpManager.attached).toBe(true);
    await h.service.updateSettings({ utp: false });
    expect(h.service.session).toBe(session);
    expect(session.settings.utp).toBe(false);
    expect(session.utpManager.attached).toBe(false);
    expect(session.listenPort).toBe(h.port);
    await h.service.updateSettings({ utp: true, tcp: false });
    expect(session.settings).toMatchObject({ utp: true, tcp: false });
    expect(session.utpManager.attached).toBe(true);
    expect(h.service.status().state).toBe('running');
  });

  it('a partial PUT keeps every omitted setting (no defaults filled in)', async () => {
    const { h, app } = await build({ enabled: true, maxConnections: 77 });
    await h.service.start();
    const session = h.service.session;
    await app.inject({ method: 'PUT', url: '/api/v1/settings/torrent', payload: { encryption: 'required' } });
    expect(h.service.settings()).toMatchObject({ listenPort: h.port, dht: false, maxConnections: 77, encryption: 'required' });
    expect(h.service.session).toBe(session);
  });

  it('rejects invalid transport values', async () => {
    const { app } = await build();
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/torrent', payload: { encryption: 'sometimes' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/torrent', payload: { webSeedConnectionsPerTorrent: -1 } })).statusCode).toBe(400);
  });
});

describe('torrent status and details', () => {
  it('GET /torrent/status reports uTP connections, IPv6 DHT nodes and the encrypted peer ratio', async () => {
    const { h, app } = await build({ enabled: true });
    await h.service.start();
    const st = TorrentSessionStatus.parse((await app.inject({ method: 'GET', url: '/api/v1/torrent/status' })).json());
    expect(st).toMatchObject({ utpConnections: 0, dht6Nodes: 0, encryptedPeers: 0, encryptedPeerRatio: 0 });
  });

  it('GET /torrent/torrents includes web seeds, super-seeding and limits', async () => {
    const { h, app } = await build({ enabled: true });
    const id = await withSeedingTorrent(h);
    const [detail] = (await app.inject({ method: 'GET', url: `/api/v1/torrent/torrents?id=${id}` })).json().map((d: unknown) => TorrentDetail.parse(d));
    expect(detail).toMatchObject({
      webSeeds: [],
      superSeeding: false,
      limits: { uploadLimit: 0, downloadLimit: 0, peerUploadLimit: 0, peerDownloadLimit: 0 },
    });
  });

  it('reports per-peer encryption and transport for a connected peer', async () => {
    const { h, app } = await build({ enabled: true, encryption: 'required' });
    const id = await withSeedingTorrent(h);
    const local = h.service.session!;
    const torrent = local.getTorrent(id)!;
    // A second engine on loopback joins the swarm as a leecher; both sides require MSE.
    const leecher = new Session({ settings: { ...FAST, listenPort: 0, listenAddress: '127.0.0.1', dht: false, encryption: 'required', savePath: `${h.dir}/leech` } });
    await leecher.start();
    open.push(() => leecher.shutdown());
    const file = (await import('node:fs/promises')).readFile;
    const torrentFile = await file(`${h.configDir}/torrents/${id}.torrent`);
    await leecher.addTorrent({ torrent: torrentFile, peers: [{ host: '127.0.0.1', port: local.listenPort }] });
    await waitFor(() => torrent.getPeers().length > 0);
    const [detail] = (await app.inject({ method: 'GET', url: `/api/v1/torrent/torrents?id=${id}` })).json().map((d: unknown) => TorrentDetail.parse(d));
    expect(detail.peers[0]).toMatchObject({ encrypted: true });
    expect(['tcp', 'utp']).toContain(detail.peers[0]!.transport);
    const st = TorrentSessionStatus.parse((await app.inject({ method: 'GET', url: '/api/v1/torrent/status' })).json());
    expect(st.encryptedPeers).toBeGreaterThan(0);
    expect(st.encryptedPeerRatio).toBe(1);
  });
});

describe('per-torrent limits and super-seeding', () => {
  it('POST /torrent/:id/limits changes only the given limits and persists them', async () => {
    const { h, app } = await build({ enabled: true });
    const id = await withSeedingTorrent(h);
    const t = h.service.session!.getTorrent(id)!;
    const res = await app.inject({ method: 'POST', url: `/api/v1/torrent/${id}/limits`, payload: { uploadLimit: 51_200, peerDownloadLimit: 1024 } });
    expect(res.statusCode).toBe(200);
    expect(t.rateLimits).toEqual({ uploadLimit: 51_200, downloadLimit: 0, peerUploadLimit: 0, peerDownloadLimit: 1024 });
    await app.inject({ method: 'POST', url: `/api/v1/torrent/${id}/limits`, payload: { uploadLimit: 0 } });
    expect(t.rateLimits.uploadLimit).toBe(0);
    expect(t.rateLimits.peerDownloadLimit).toBe(1024);
    expect((await t.resumeData()).peerDownloadLimit).toBe(1024);
  });

  it('POST /torrent/:id/superseed toggles BEP 16 super-seeding', async () => {
    const { h, app } = await build({ enabled: true });
    const id = await withSeedingTorrent(h);
    const t = h.service.session!.getTorrent(id)!;
    expect((await app.inject({ method: 'POST', url: `/api/v1/torrent/${id}/superseed`, payload: { enabled: true } })).statusCode).toBe(200);
    expect(t.superSeeding).toBe(true);
    await app.inject({ method: 'POST', url: `/api/v1/torrent/${id}/superseed`, payload: { enabled: false } });
    expect(t.superSeeding).toBe(false);
  });

  it('validates limit and super-seed requests and maps unknown torrents to 404', async () => {
    const { h, app } = await build({ enabled: true });
    await h.service.start();
    const id = 'c'.repeat(40);
    expect((await app.inject({ method: 'POST', url: `/api/v1/torrent/${id}/limits`, payload: { uploadLimit: -5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v1/torrent/${id}/superseed`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v1/torrent/${id}/limits`, payload: { uploadLimit: 5 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/v1/torrent/${id}/superseed`, payload: { enabled: true } })).statusCode).toBe(404);
  });
});
