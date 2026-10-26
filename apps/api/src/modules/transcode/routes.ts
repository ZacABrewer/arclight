import { z } from 'zod';
import {
  TranscodeErrorResponse,
  TranscodeHwaccelResponse,
  TranscodeJob,
  TranscodeJobsQuery,
  TranscodeRule,
  TranscodeRuleInput,
  TranscodeRunRequest,
  TranscodeRunResult,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { TranscodeError, type TranscodeErrorCode, type TranscodeService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const errors = { 400: TranscodeErrorResponse, 404: TranscodeErrorResponse, 409: TranscodeErrorResponse };
const statusFor: Record<TranscodeErrorCode, number> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 };

export function transcodeRoutes(service: TranscodeService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof TranscodeError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled transcode error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    // ---- rules -------------------------------------------------------------------------

    app.get('/transcoderule', { schema: { response: { 200: z.array(TranscodeRule) } } }, async () => service.listRules());

    app.get('/transcoderule/:id', { schema: { params: IdParams, response: { 200: TranscodeRule, ...errors } } }, async (req) =>
      service.getRule(req.params.id),
    );

    app.post('/transcoderule', { schema: { body: TranscodeRuleInput, response: { 201: TranscodeRule, ...errors } } }, async (req, reply) =>
      reply.code(201).send(service.createRule(req.body)),
    );

    app.put(
      '/transcoderule/:id',
      { schema: { params: IdParams, body: TranscodeRuleInput, response: { 200: TranscodeRule, ...errors } } },
      async (req) => service.updateRule(req.params.id, req.body),
    );

    app.delete('/transcoderule/:id', { schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      service.deleteRule(req.params.id);
      return reply.code(204).send(null);
    });

    // ---- jobs --------------------------------------------------------------------------

    app.get('/transcode/jobs', { schema: { querystring: TranscodeJobsQuery, response: { 200: z.array(TranscodeJob), ...errors } } }, async (req) =>
      service.listJobs(req.query.status),
    );

    app.post('/transcode/run', { schema: { body: TranscodeRunRequest, response: { 200: TranscodeRunResult, ...errors } } }, async (req) =>
      req.body.mediaFileId !== undefined ? service.runForFile(req.body.mediaFileId) : service.runForRule(req.body.ruleId!),
    );

    app.post('/transcode/jobs/:id/cancel', { schema: { params: IdParams, response: { 200: TranscodeJob, ...errors } } }, async (req) =>
      service.cancel(req.params.id),
    );

    app.get('/transcode/hwaccel', { schema: { response: { 200: TranscodeHwaccelResponse } } }, async () => service.hwaccels());
  };
}
