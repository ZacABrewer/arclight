import { mkdir } from 'node:fs/promises';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { TorrentDetail, TorrentSessionStatus, TorrentSettingsResponse } from '@arclight/shared';
import { torrentRoutes } from './routes.js';
import { harness, seededTorrent, waitFor, type Harness } from './test-support.js';

const open: Array<{ h: Harness; close: () => Promise<unknown> }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.close();
    await o.h.cleanup();
  }
});

async function build(settings: Record<string, unknown> = {}) {
  const h = await harness({ settings });
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(torrentRoutes(h.service), { prefix: '/api/v1' });
  open.push({ h, close: () => app.close() });
  return { h, app };
}

describe('torrent routes', () => {
  it('GET/PUT /settings/torrent reads, validates and applies settings', async () => {
    const { h, app } = await build();
    const got = await app.inject({ method: 'GET', url: '/api/v1/settings/torrent' });
    expect(got.statusCode).toBe(200);
    expect(TorrentSettingsResponse.parse(got.json()).listenPort).toBe(h.port);
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/torrent', payload: { enabled: true, uploadLimitKbps: 10 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ enabled: true, uploadLimitKbps: 10 });
    expect(h.service.session?.settings.uploadLimit).toBe(10_240);
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/settings/torrent', payload: { maxConnections: 0 } });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /torrent/status reports the session', async () => {
    const { h, app } = await build({ enabled: true });
    await h.service.start();
    const res = await app.inject({ method: 'GET', url: '/api/v1/torrent/status' });
    expect(res.statusCode).toBe(200);
    const st = TorrentSessionStatus.parse(res.json());
    expect(st).toMatchObject({ state: 'running', listenPort: h.port, boundAddress: '127.0.0.1', dhtNodes: 0, peers: 0 });
    expect(st.torrents.total).toBe(0);
  });

  it('GET /torrent/torrents and POST actions work on a real torrent', async () => {
    const { h, app } = await build({ enabled: true });
    await h.service.start();
    const root = h.service.effectiveDownloadsRoot();
    await mkdir(root, { recursive: true });
    const { torrent, infoHash } = await seededTorrent(root);
    const t = await h.service.session!.addTorrent({ torrent });
    await waitFor(() => t.state === 'seeding');

    const list = await app.inject({ method: 'GET', url: `/api/v1/torrent/torrents?id=${infoHash}` });
    expect(list.statusCode).toBe(200);
    const details = list.json().map((d: unknown) => TorrentDetail.parse(d));
    expect(details).toHaveLength(1);
    expect(details[0].files).toHaveLength(2);

    expect((await app.inject({ method: 'POST', url: `/api/v1/torrent/${infoHash}/pause` })).json()).toEqual({ ok: true });
    expect(t.isPaused).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/v1/torrent/${infoHash}/resume` })).statusCode).toBe(200);
    expect(t.isPaused).toBe(false);
    const prio = await app.inject({ method: 'POST', url: `/api/v1/torrent/${infoHash}/priority`, payload: { files: [{ index: 0, priority: 7 }] } });
    expect(prio.statusCode).toBe(200);
    expect(t.getFiles()[0]!.priority).toBe(7);
    expect((await app.inject({ method: 'POST', url: `/api/v1/torrent/${infoHash}/recheck` })).statusCode).toBe(200);
    const move = await app.inject({ method: 'POST', url: `/api/v1/torrent/${infoHash}/move`, payload: { savePath: '' } });
    expect(move.statusCode).toBe(400);
  });

  it('serves speed settings, slow mode and seeding rules', async () => {
    const { app } = await build();
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/torrent/speed' })).json()).toMatchObject({ altDownloadLimitKbps: 1024, scheduleEnabled: false });
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/torrent/speed', payload: { altUploadLimitKbps: 64 } });
    expect(put.json()).toMatchObject({ altUploadLimitKbps: 64, altDownloadLimitKbps: 1024 });
    const slow = await app.inject({ method: 'POST', url: '/api/v1/torrent/slowmode', payload: { enabled: true } });
    expect(slow.statusCode).toBe(200);
    expect(slow.json()).toMatchObject({ mode: 'alternative', reason: 'manual', uploadLimit: 64 * 1024 });
    expect((await app.inject({ method: 'GET', url: '/api/v1/torrent/speed' })).json()).toMatchObject({ mode: 'alternative' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/torrent/slowmode', payload: { enabled: true, until: 'soon' } })).statusCode).toBe(400);

    const rules = { rules: [{ id: 'tv', name: 'TV', categories: ['tv'], seedTimeMinutes: 7 * 24 * 60, action: 'remove', deleteFiles: true }] };
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/settings/torrent/seedingrules', payload: rules });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().rules[0]).toMatchObject({ id: 'tv', enabled: true, ratio: null, action: 'remove' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/torrent/seedingrules' })).json().rules).toHaveLength(1);
    const noLimit = await app.inject({ method: 'PUT', url: '/api/v1/settings/torrent/seedingrules', payload: { rules: [{ id: 'x', name: 'X' }] } });
    expect(noLimit.statusCode).toBe(400);
    const apply = await app.inject({ method: 'POST', url: '/api/v1/torrent/seedingrules/apply' });
    expect(apply.statusCode).toBe(200);
    expect(apply.json()).toBeNull();
  });

  it('maps errors: 400 bad id, 404 unknown torrent, 409 engine stopped', async () => {
    const { h, app } = await build();
    const id = 'b'.repeat(40);
    expect((await app.inject({ method: 'POST', url: '/api/v1/torrent/nothex/pause' })).statusCode).toBe(400);
    const stopped = await app.inject({ method: 'POST', url: `/api/v1/torrent/${id}/pause` });
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json().code).toBe('NOT_RUNNING');
    expect((await app.inject({ method: 'GET', url: '/api/v1/torrent/torrents' })).json()).toEqual([]);
    await h.service.updateSettings({ enabled: true });
    expect((await app.inject({ method: 'POST', url: `/api/v1/torrent/${id}/resume` })).statusCode).toBe(404);
  });
});
