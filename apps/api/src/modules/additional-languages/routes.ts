import { z } from 'zod';
import {
  AdditionalLanguageErrorResponse,
  AdditionalLanguageRequest,
  AdditionalLanguageResult,
  ItemLanguages,
  ItemLanguagesQuery,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { LibraryError } from '../library/index.js';
import { AdditionalLanguagesError, type AdditionalLanguagesService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const errors = { 400: AdditionalLanguageErrorResponse, 404: AdditionalLanguageErrorResponse, 409: AdditionalLanguageErrorResponse };
const statusFor: Record<AdditionalLanguagesError['code'], number> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 };

export function additionalLanguagesRoutes(service: AdditionalLanguagesService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof AdditionalLanguagesError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof LibraryError) return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled additional-language error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.get(
      '/additional-language',
      { schema: { querystring: ItemLanguagesQuery, response: { 200: ItemLanguages, ...errors } } },
      async (req) => service.itemLanguages(req.query),
    );

    app.post(
      '/additional-language/preview',
      { schema: { body: AdditionalLanguageRequest, response: { 200: AdditionalLanguageResult, ...errors } } },
      async (req) => service.preview(req.body),
    );

    app.post(
      '/additional-language',
      { schema: { body: AdditionalLanguageRequest, response: { 200: AdditionalLanguageResult, ...errors } } },
      async (req) => service.apply(req.body),
    );

    app.delete('/additional-language/:id', { schema: { params: IdParams, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      service.remove(req.params.id);
      return reply.code(204).send(null);
    });
  };
}
