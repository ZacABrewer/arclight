import { z } from 'zod';
import {
  RetentionCandidate,
  RetentionCandidateQuery,
  RetentionErrorResponse,
  RetentionRule,
  RetentionRuleInput,
  RetentionSweepRequest,
  RetentionSweepResult,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { RetentionError, type RetentionErrorCode, type RetentionService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const errors = { 400: RetentionErrorResponse, 404: RetentionErrorResponse, 409: RetentionErrorResponse };

const statusFor: Record<RetentionErrorCode, number> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 };

export function retentionRoutes(service: RetentionService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof RetentionError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled retention error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    // ---- rules -------------------------------------------------------------------------

    app.get('/retentionrule', { schema: { response: { 200: z.array(RetentionRule) } } }, async () => service.listRules());

    app.get('/retentionrule/:id', { schema: { params: IdParams, response: { 200: RetentionRule, ...errors } } }, async (req) =>
      service.getRule(req.params.id),
    );

    app.post('/retentionrule', { schema: { body: RetentionRuleInput, response: { 201: RetentionRule, ...errors } } }, async (req, reply) =>
      reply.code(201).send(service.createRule(req.body)),
    );

    app.put(
      '/retentionrule/:id',
      { schema: { params: IdParams, body: RetentionRuleInput, response: { 200: RetentionRule, ...errors } } },
      async (req) => service.updateRule(req.params.id, req.body),
    );

    app.delete('/retentionrule/:id', { schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      service.deleteRule(req.params.id);
      return reply.code(204).send(null);
    });

    // ---- candidates and sweeps ---------------------------------------------------------

    app.get(
      '/retention/candidates',
      { schema: { querystring: RetentionCandidateQuery, response: { 200: z.array(RetentionCandidate), ...errors } } },
      async (req) => service.listCandidates(req.query),
    );

    app.post(
      '/retention/sweep',
      { schema: { body: RetentionSweepRequest.nullish(), response: { 200: RetentionSweepResult, ...errors } } },
      async (req) => service.sweep({ dryRun: req.body?.dryRun ?? false }),
    );

    app.post('/retention/candidate/:id/apply', { schema: { params: IdParams, response: { 200: RetentionCandidate, ...errors } } }, async (req) =>
      service.applyCandidate(req.params.id),
    );

    app.post('/retention/candidate/:id/keep', { schema: { params: IdParams, response: { 200: RetentionCandidate, ...errors } } }, async (req) =>
      service.keep(req.params.id),
    );

    app.delete(
      '/retention/candidate/:id',
      { schema: { params: IdParams, response: { 204: z.null(), ...errors } } },
      async (req, reply) => {
        service.deleteCandidate(req.params.id);
        return reply.code(204).send(null);
      },
    );
  };
}
