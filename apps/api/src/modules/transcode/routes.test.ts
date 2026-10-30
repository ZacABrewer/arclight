import { rm } from 'node:fs/promises';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { transcodeRoutes } from './routes.js';
import { setup, type Fixture } from './test-support.js';

let fx: Fixture;

afterEach(async () => {
  if (fx) await rm(fx.tmp, { recursive: true, force: true });
});

async function build() {
  fx = await setup();
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(transcodeRoutes(fx.service), { prefix: '/api/v1' });
  return app;
}

describe('transcode routes', () => {
  it('rule CRUD', async () => {
    const app = await build();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/transcoderule',
      payload: { name: 'To HEVC', action: 'transcode', options: { videoCodec: 'hevc', hwaccel: 'vaapi', crf: 24 }, schedule: { start: '23:00', end: '05:00' } },
    });
    expect(created.statusCode).toBe(201);
    const rule = created.json();
    expect(rule).toMatchObject({ name: 'To HEVC', enabled: true, options: { videoCodec: 'hevc', container: 'mkv', crf: 24 } });

    expect((await app.inject({ method: 'GET', url: '/api/v1/transcoderule' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/v1/transcoderule/${rule.id}` })).json().id).toBe(rule.id);

    const updated = await app.inject({ method: 'PUT', url: `/api/v1/transcoderule/${rule.id}`, payload: { name: 'Remux', action: 'remux', enabled: false } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: 'Remux', action: 'remux', enabled: false, schedule: null });

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/transcoderule/${rule.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v1/transcoderule/${rule.id}` })).statusCode).toBe(404);
  });

  it('rejects invalid rules with 400', async () => {
    const app = await build();
    const bad = [
      { name: 'x', action: 'explode' },
      { name: 'x', action: 'remux', schedule: { start: '25:00', end: '01:00' } },
      { name: 'x', action: 'transcode', options: { videoCodec: 'av1', hwaccel: 'videotoolbox' } },
      { name: 'x', action: 'remux', scope: { kind: 'tags', tagIds: [] } },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/transcoderule', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('run, list (with status filter) and cancel jobs', async () => {
    const app = await build();
    const none = await app.inject({ method: 'POST', url: '/api/v1/transcode/run', payload: { mediaFileId: fx.movieFileId } });
    expect(none.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/transcode/run', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/transcode/run', payload: { mediaFileId: 9999 } })).statusCode).toBe(404);

    const rule = (await app.inject({ method: 'POST', url: '/api/v1/transcoderule', payload: { name: 'r', action: 'remux' } })).json();
    const run = await app.inject({ method: 'POST', url: '/api/v1/transcode/run', payload: { ruleId: rule.id } });
    expect(run.statusCode).toBe(200);
    expect(run.json().queued).toBe(2);

    const queued = await app.inject({ method: 'GET', url: '/api/v1/transcode/jobs?status=queued' });
    expect(queued.json()).toHaveLength(2);
    const id = queued.json()[0].id;
    const cancelled = await app.inject({ method: 'POST', url: `/api/v1/transcode/jobs/${id}/cancel` });
    expect(cancelled.json()).toMatchObject({ id, status: 'cancelled' });
    expect((await app.inject({ method: 'POST', url: `/api/v1/transcode/jobs/${id}/cancel` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/v1/transcode/jobs?status=cancelled' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/v1/transcode/jobs?status=bogus' })).statusCode).toBe(400);
  });

  it('GET /transcode/hwaccel tests each backend, caches the result and re-tests on ?refresh=true', async () => {
    const app = await build();
    fx.runner.respond = (args) =>
      args.includes('h264_qsv') ? { exitCode: 218, stderr: '[AVHWDeviceContext @ 0x7f39] No supported child device type is enabled\nDevice creation failed: -38.' } : undefined;
    const res = await app.inject({ method: 'GET', url: '/api/v1/transcode/hwaccel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ffmpegPath: '/usr/bin/ffmpeg',
      methods: ['vdpau', 'cuda', 'vaapi', 'qsv', 'drm'],
      backends: ['none', 'vaapi', 'nvenc'],
      results: [
        { backend: 'none', available: true, reason: null },
        { backend: 'vaapi', available: true, reason: null },
        { backend: 'qsv', available: false, reason: 'No supported child device type is enabled' },
        { backend: 'nvenc', available: true, reason: null },
        { backend: 'videotoolbox', available: false, reason: 'this ffmpeg build has no VideoToolbox support' },
      ],
      testedAt: fx.clock.now.toISOString(),
    });
    const runs = fx.runner.calls.length;
    expect(runs).toBe(4);
    // Cached: no new test encodes.
    fx.runner.respond = null;
    expect((await app.inject({ method: 'GET', url: '/api/v1/transcode/hwaccel' })).json().backends).toEqual(['none', 'vaapi', 'nvenc']);
    expect(fx.runner.calls.length).toBe(runs);
    // refresh: tested again, QSV works now.
    const again = await app.inject({ method: 'GET', url: '/api/v1/transcode/hwaccel?refresh=true' });
    expect(again.json().backends).toEqual(['none', 'vaapi', 'qsv', 'nvenc']);
    expect(fx.runner.calls.length).toBe(runs * 2);
    expect((await app.inject({ method: 'GET', url: '/api/v1/transcode/hwaccel?refresh=maybe' })).statusCode).toBe(400);

    fx.runner.binary = null;
    expect((await app.inject({ method: 'GET', url: '/api/v1/transcode/hwaccel?refresh=1' })).json()).toEqual({
      ffmpegPath: null,
      methods: [],
      backends: [],
      results: [],
      testedAt: null,
    });
  });

  it('GET/PUT /settings/transcode', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/transcode' })).json()).toEqual({ fallbackToSoftware: true });
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/transcode', payload: { fallbackToSoftware: false } });
    expect(put.json()).toEqual({ fallbackToSoftware: false });
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/transcode' })).json()).toEqual({ fallbackToSoftware: false });
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/transcode', payload: { fallbackToSoftware: 'no' } })).statusCode).toBe(400);
  });
});
