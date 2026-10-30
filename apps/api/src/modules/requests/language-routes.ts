import { z } from 'zod';
import {
  ApproveLanguageRequest,
  BulkRequestAction,
  BulkRequestResult,
  CreateLanguageRequest,
  DeclineRequest,
  ErrorResponse,
  LanguageRequest,
  LanguageRequestCount,
  LanguageRequestLanguages,
  LanguageRequestListQuery,
  LanguageRequestOptions,
  LanguageRequestOptionsQuery,
  LanguageRequestPage,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { LibraryError } from '../library/index.js';
import { AdditionalLanguagesError } from '../additional-languages/service.js';
import { eachId } from './bulk.js';
import { REQUESTS_ERROR_STATUS, RequestsError } from './errors.js';
import type { LanguageRequestsService } from './language-requests.js';
import { actorOf } from './routes.js';

// Subtitle and audio language requests (docs/API.md "Subtitle and language requests"). Same
// conventions as routes.ts: every route is open to signed-in users (portal included) and the
// service checks the permission bits and scopes reads to the caller's own requests.

type Plugin = FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const BulkParams = z.object({ action: z.enum(['approve', 'decline', 'retry', 'delete']) });
const Empty = z.null();
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 503: ErrorResponse };
const user = { access: { portal: true } } as const;
const ADDITIONAL_STATUS: Record<AdditionalLanguagesError['code'], number> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 };

export function languageRequestsRoutes(languages: LanguageRequestsService): Plugin {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof RequestsError) return reply.code(REQUESTS_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof AdditionalLanguagesError) return reply.code(ADDITIONAL_STATUS[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof LibraryError) return reply.code(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: err.message, code: err.code });
      if (err instanceof z.ZodError) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled language requests error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/request/language', { config: user, schema: { querystring: LanguageRequestListQuery, response: { 200: LanguageRequestPage, ...errors } } }, async (req) =>
      languages.list(actorOf(req), req.query),
    );
    app.get('/request/language/count', { config: user, schema: { response: { 200: LanguageRequestCount, ...errors } } }, async (req) => languages.count(actorOf(req)));
    app.get(
      '/request/language/options',
      { config: user, schema: { querystring: LanguageRequestOptionsQuery, response: { 200: LanguageRequestOptions, ...errors } } },
      async (req) => languages.options(actorOf(req), req.query),
    );
    app.get('/request/language/languages', { config: user, schema: { response: { 200: LanguageRequestLanguages, ...errors } } }, async (req) => {
      actorOf(req);
      return languages.languages();
    });
    app.get('/request/language/:id', { config: user, schema: { params: IdParams, response: { 200: LanguageRequest, ...errors } } }, async (req) =>
      languages.get(actorOf(req), req.params.id),
    );
    app.post('/request/language', { config: user, schema: { body: CreateLanguageRequest, response: { 201: LanguageRequest, ...errors } } }, async (req, reply) =>
      reply.code(201).send(await languages.create(actorOf(req), req.body)),
    );
    app.post(
      '/request/language/:id/approve',
      { config: user, schema: { params: IdParams, body: ApproveLanguageRequest.nullish(), response: { 200: LanguageRequest, ...errors } } },
      async (req) => languages.approve(actorOf(req), req.params.id, req.body ?? {}),
    );
    app.post(
      '/request/language/:id/decline',
      { config: user, schema: { params: IdParams, body: DeclineRequest.nullish(), response: { 200: LanguageRequest, ...errors } } },
      async (req) => languages.decline(actorOf(req), req.params.id, req.body?.reason),
    );
    app.post('/request/language/:id/retry', { config: user, schema: { params: IdParams, response: { 200: LanguageRequest, ...errors } } }, async (req) =>
      languages.retry(actorOf(req), req.params.id),
    );
    app.post(
      '/request/language/bulk/:action',
      { config: user, schema: { params: BulkParams, body: BulkRequestAction, response: { 200: BulkRequestResult, ...errors } } },
      async (req) => {
        const actor = actorOf(req);
        // An approval that ends failed is reported as a failure, as for video requests.
        const settled = async (res: Promise<LanguageRequest>) => {
          const r = await res;
          if (r.status === 'failed') throw new Error(r.failureReason ?? 'failed');
        };
        const run = {
          approve: (id: number) => settled(languages.approve(actor, id)),
          decline: (id: number) => languages.decline(actor, id),
          retry: (id: number) => settled(languages.retry(actor, id)),
          delete: (id: number) => languages.remove(actor, id),
        }[req.params.action];
        return eachId(req.body.ids, run);
      },
    );
    app.delete('/request/language/:id', { config: user, schema: { params: IdParams, response: { 204: Empty, ...errors } } }, async (req, reply) => {
      languages.remove(actorOf(req), req.params.id);
      return reply.code(204).send(null);
    });
  };
}
