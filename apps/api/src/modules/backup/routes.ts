import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Backup, BackupErrorResponse, BackupRestoreResponse, BackupSettings } from '@arclight/shared';
import { BackupError, type BackupService } from './service.js';

export interface BackupRoutesOptions {
  /** preHandler run on every backup route; production passes the auth module's requireAdmin. */
  guard?: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Upload size cap for POST /system/backup/restore/upload. Default 4 GiB (the zip format limit). */
  maxUploadBytes?: number;
  /** Where uploads are staged before validation. */
  uploadDir: string;
}

const IdParams = z.object({ id: z.string().min(1).max(255) });
const errors = { 400: BackupErrorResponse, 404: BackupErrorResponse, 409: BackupErrorResponse };

const STATUS: Record<BackupError['code'], number> = {
  NOT_FOUND: 404,
  INVALID_BACKUP: 400,
  VALIDATION: 400,
  BUSY: 409,
};

export function backupRoutes(
  service: BackupService,
  opts: BackupRoutesOptions,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    await app.register(multipart, { limits: { files: 1, fileSize: opts.maxUploadBytes ?? 0xffffffff } });
    if (opts.guard) app.addHook('preHandler', opts.guard);

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof BackupError) return reply.code(STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) {
        return reply.code(status).send({ error: (err as Error).message, code: (err as { code?: string }).code });
      }
      req.log.error({ err }, 'unhandled backup error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/system/backup', { schema: { response: { 200: z.array(Backup) } } }, async () => service.list());

    app.post('/system/backup', { schema: { response: { 201: Backup, ...errors } } }, async (_req, reply) =>
      reply.code(201).send(await service.create('manual')),
    );

    app.delete('/system/backup/:id', { schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      await service.delete(req.params.id);
      return reply.code(204).send(null);
    });

    app.get('/system/backup/:id/download', { schema: { params: IdParams } }, async (req, reply) => {
      const file = await service.resolve(req.params.id);
      return reply
        .header('content-type', 'application/zip')
        .header('content-length', String(file.size))
        .header('content-disposition', `attachment; filename="${file.name}"`)
        .send(createReadStream(file.path));
    });

    app.post(
      '/system/backup/restore/:id',
      { schema: { params: IdParams, response: { 200: BackupRestoreResponse, ...errors } } },
      async (req) => {
        const r = await service.restoreFromId(req.params.id);
        return { restored: true as const, configFiles: r.configFiles, restartRequired: true as const };
      },
    );

    app.post(
      '/system/backup/restore/upload',
      { schema: { response: { 200: BackupRestoreResponse, ...errors, 413: BackupErrorResponse } } },
      async (req, reply) => {
        if (!req.isMultipart()) throw new BackupError('VALIDATION', 'expected a multipart/form-data upload');
        const file = await req.file();
        if (!file) throw new BackupError('VALIDATION', 'no file uploaded');
        const staged = join(opts.uploadDir, `.upload-${randomUUID()}.zip`);
        try {
          await pipeline(file.file, createWriteStream(staged));
          if (file.file.truncated) {
            return reply.code(413).send({ error: 'upload too large', code: 'TOO_LARGE' });
          }
          const r = await service.restoreFromFile(staged);
          return { restored: true as const, configFiles: r.configFiles, restartRequired: true as const };
        } finally {
          await rm(staged, { force: true });
        }
      },
    );

    app.get('/settings/backup', { schema: { response: { 200: BackupSettings } } }, async () => service.getSettings());

    app.put('/settings/backup', { schema: { body: BackupSettings, response: { 200: BackupSettings, ...errors } } }, async (req) =>
      service.updateSettings(req.body),
    );
  };
}
