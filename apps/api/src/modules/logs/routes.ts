import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { LogFile, LogPage, LogQuery, LogsErrorResponse } from '@arclight/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { LogsError, type LogsService } from './service.js';

const NameParams = z.object({ name: z.string().min(1) });

export interface LogsRoutesOptions {
  /** preHandler run on every log route (the module passes requireAdmin). */
  guard?: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function logsRoutes(
  service: LogsService,
  opts: LogsRoutesOptions = {},
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    if (opts.guard) app.addHook('preHandler', opts.guard);

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof LogsError) return reply.code(404).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled logs error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/log', { schema: { querystring: LogQuery, response: { 200: LogPage, 400: LogsErrorResponse } } }, async (req) =>
      service.query(req.query),
    );

    app.delete('/log', { schema: { response: { 204: z.null() } } }, async (_req, reply) => {
      service.clear();
      return reply.code(204).send(null);
    });

    app.get('/log/file', { schema: { response: { 200: z.array(LogFile) } } }, async () => service.files());

    app.get('/log/file/:name', { schema: { params: NameParams } }, async (req, reply) => {
      const file = service.resolveFile(req.params.name);
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('content-length', String(file.sizeBytes))
        .header('content-disposition', `attachment; filename="${req.params.name}"`)
        .send(createReadStream(file.path));
    });

    // Live tail: one LogRecord JSON per message, starting with records logged after connect.
    app.get('/log/stream', { websocket: true }, (socket) => {
      const unsubscribe = service.subscribe((record) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(record));
      });
      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);
    });
  };
}
