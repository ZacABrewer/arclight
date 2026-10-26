import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemStatus } from '@media-tron/shared';
import type { AppContext } from '../../app.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import type { RequestAuth } from '../auth/service.js';
import { requireAdmin } from '../auth/hook.js';
import { settingsService } from '../settings/index.js';
import { requestRestart, systemModuleWith } from '../system/index.js';
import { backupRoutes } from './routes.js';
import { harness, silentLog, type Harness } from './test-support.js';

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

async function build(opts: { admin?: boolean; exit?: () => void } = {}) {
  h = harness();
  const ctx: AppContext = {
    config: h.config,
    db: h.db,
    bus: new EventBus(),
    scheduler: new Scheduler(h.db, new EventBus(), silentLog),
    log: silentLog,
    startedAt: new Date(),
  };
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = { user: null, via: 'apiKey', isAdmin: opts.admin ?? true } as unknown as RequestAuth;
  });
  await app.register(
    async (api) => {
      await api.register(backupRoutes(h!.service, { guard: requireAdmin, uploadDir: h!.config.configDir }));
      await api.register(systemModuleWith({ exit: opts.exit ?? (() => undefined), restartDelayMs: 0 })(ctx));
    },
    { prefix: '/api/v1' },
  );
  return { app, ctx, h };
}

function multipart(file: Buffer, filename = 'backup.zip') {
  const boundary = '----mt-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('backup routes', () => {
  it('creates, lists, downloads and deletes backups', async () => {
    const { app } = await build();
    expect((await app.inject({ method: 'GET', url: '/api/v1/system/backup' })).json()).toEqual([]);
    const created = await app.inject({ method: 'POST', url: '/api/v1/system/backup' });
    expect(created.statusCode).toBe(201);
    const b = created.json();
    expect(b).toMatchObject({ type: 'manual', id: expect.stringMatching(/^media-tron_manual_.*\.zip$/) });
    const list = (await app.inject({ method: 'GET', url: '/api/v1/system/backup' })).json();
    expect(list).toEqual([b]);

    const dl = await app.inject({ method: 'GET', url: `/api/v1/system/backup/${b.id}/download` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(dl.headers['content-disposition']).toContain(b.id);
    expect(dl.rawPayload.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);
    expect(dl.rawPayload.length).toBe(b.size);

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/system/backup/${b.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/system/backup/${b.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/system/backup/..%2Fmedia-tron.db/download' })).statusCode).toBe(404);
  });

  it('restores by id and raises restartRequired in /system/status', async () => {
    const { app, ctx, h } = await build();
    const status = async () => SystemStatus.parse((await app.inject({ method: 'GET', url: '/api/v1/system/status' })).json());
    expect((await status()).restartRequired).toBe(false);
    settingsService.setSection(h.db, 'metadata', { tmdbApiKey: 'before', language: 'en-US', region: 'US' });
    const b = (await app.inject({ method: 'POST', url: '/api/v1/system/backup' })).json();
    settingsService.setSection(h.db, 'metadata', { tmdbApiKey: 'after', language: 'en-US', region: 'US' });

    const r = await app.inject({ method: 'POST', url: `/api/v1/system/backup/restore/${b.id}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ restored: true, configFiles: 2, restartRequired: true });
    expect(settingsService.getSection(h.db, 'metadata').tmdbApiKey).toBe('before');
    // The harness service reports through its own callback; the module wires requestRestart.
    requestRestart(ctx, 'test');
    expect((await status()).restartRequired).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/v1/system/backup/restore/media-tron_manual_2000.01.01_00.00.00.zip' })).statusCode).toBe(404);
  });

  it('restores from an uploaded archive and rejects invalid uploads', async () => {
    const { app, h } = await build();
    settingsService.setSection(h.db, 'metadata', { tmdbApiKey: 'uploaded', language: 'en-US', region: 'US' });
    const b = (await app.inject({ method: 'POST', url: '/api/v1/system/backup' })).json();
    const bytes = readFileSync(join(h.config.configDir, 'backups', b.id));
    settingsService.setSection(h.db, 'metadata', { tmdbApiKey: 'later', language: 'en-US', region: 'US' });

    const ok = await app.inject({ method: 'POST', url: '/api/v1/system/backup/restore/upload', ...multipart(bytes) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ restored: true, restartRequired: true });
    expect(settingsService.getSection(h.db, 'metadata').tmdbApiKey).toBe('uploaded');

    const bad = await app.inject({ method: 'POST', url: '/api/v1/system/backup/restore/upload', ...multipart(Buffer.from('not a zip file, honestly')) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'INVALID_BACKUP' });
    const notMultipart = await app.inject({ method: 'POST', url: '/api/v1/system/backup/restore/upload', payload: { x: 1 } });
    expect(notMultipart.statusCode).toBe(400);
    expect(h.restored).toHaveLength(1);
  });

  it('reads and validates backup settings', async () => {
    const { app, h } = await build();
    const get = await app.inject({ method: 'GET', url: '/api/v1/settings/backup' });
    const current = get.json() as Record<string, unknown>;
    expect(current).toEqual({ folder: '', intervalDays: 1, hour: 4, retentionCount: 7, retentionDays: 28 });
    const folder = join(h.dir, 'bk');
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/backup', payload: { ...current, folder, hour: 3 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ folder, hour: 3 });
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/backup', payload: { ...current, folder: 'rel' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/backup', payload: { ...current, hour: 25 } })).statusCode).toBe(400);
  });

  it('is admin only', async () => {
    const { app } = await build({ admin: false });
    expect((await app.inject({ method: 'GET', url: '/api/v1/system/backup' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/system/restart' })).statusCode).toBe(403);
  });

  it('POST /system/restart answers, then exits', async () => {
    const exit = vi.fn();
    const { app } = await build({ exit });
    const r = await app.inject({ method: 'POST', url: '/api/v1/system/restart' });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ restarting: true });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  });
});
