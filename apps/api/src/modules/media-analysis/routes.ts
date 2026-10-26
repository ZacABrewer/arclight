import { AnalyzeCommand, AnalyzeResult, ErrorResponse, MediaAnalysisQueueSummary } from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { MediaAnalysisError, type MediaAnalysisQueue } from './service.js';

const statusFor = { NOT_FOUND: 404, VALIDATION: 400 } as const;

export function mediaAnalysisRoutes(queue: MediaAnalysisQueue): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof MediaAnalysisError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled media-analysis error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.post(
      '/command/analyze',
      { schema: { body: AnalyzeCommand, response: { 200: AnalyzeResult, 400: ErrorResponse } } },
      async (req) => {
        const queued = queue.enqueueFor(req.body);
        return { queued, ffprobeAvailable: (await queue.prober.locate()) !== null };
      },
    );

    app.get('/mediaanalysis/queue', { schema: { response: { 200: MediaAnalysisQueueSummary } } }, async () => queue.summary());
  };
}
