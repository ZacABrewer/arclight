import {
  ErrorResponse,
  HygieneDeleteResult,
  HygieneListQuery,
  HygieneListResponse,
  HygieneMapRequest,
  HygieneMapResult,
  Job,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HygieneError, type HygieneErrorCode, type LibraryHygieneService } from './service.js';

const statusFor: Record<HygieneErrorCode, number> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 };
const errors = { 400: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.coerce.number().int().positive() });

export interface HygieneRoutesOptions {
  /** Starts an OrphanScan job and answers its initial row. */
  startScan(): Job;
}

export function libraryHygieneRoutes(
  service: LibraryHygieneService,
  opts: HygieneRoutesOptions,
): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof HygieneError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled library-hygiene error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get(
      '/library/hygiene',
      { schema: { querystring: HygieneListQuery, response: { 200: HygieneListResponse, ...errors } } },
      async (req) => service.list(req.query),
    );

    app.post('/library/hygiene/scan', { schema: { response: { 202: Job } } }, async (_req, reply) => reply.code(202).send(opts.startScan()));

    app.post(
      '/library/hygiene/:id/map',
      { schema: { params: IdParams, body: HygieneMapRequest, response: { 200: HygieneMapResult, ...errors } } },
      async (req) => service.map(req.params.id, req.body),
    );

    app.delete(
      '/library/hygiene/:id',
      { schema: { params: IdParams, response: { 200: HygieneDeleteResult, ...errors } } },
      async (req) => service.delete(req.params.id),
    );
  };
}
