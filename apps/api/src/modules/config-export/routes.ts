import { z } from 'zod';
import {
  ConfigExportQuery,
  ConfigImportRequest,
  ConfigImportResult,
  ConfigManagedKeys,
  ConfigValidateResult,
  SettingsErrorResponse,
} from '@arclight/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAdmin } from '../auth/hook.js';
import { ConfigParseError, toYaml } from './overlay.js';
import { ConfigService } from './service.js';

/** Header value an admin must send to export secrets in clear. */
export const EXPORT_SECRETS_CONFIRMATION = 'export-secrets';

const ImportBody = z.union([ConfigImportRequest, z.string()]);
const ImportQuery = z.object({
  dryRun: z.preprocess((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1'), z.boolean().optional()),
  prune: z.preprocess((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1'), z.boolean().optional()),
});

type Body = z.infer<typeof ImportBody>;
type Query = z.infer<typeof ImportQuery>;

class BadInput extends Error {
  readonly code = 'VALIDATION';
}

/** The raw document plus flags from a JSON envelope, a bare YAML/JSON body and the query string. */
function readInput(body: Body, query: Query): { raw: unknown; dryRun: boolean; prune: boolean | undefined } {
  if (typeof body === 'string') {
    return { raw: ConfigService.parse({ content: body }), dryRun: query.dryRun ?? false, prune: query.prune };
  }
  let raw: unknown;
  if (body.document !== undefined) raw = body.document;
  else if (body.content !== undefined) raw = ConfigService.parse({ content: body.content });
  else throw new BadInput('give `document` or `content`');
  return { raw, dryRun: query.dryRun ?? body.dryRun, prune: query.prune ?? body.prune };
}

const YAML_TYPES = ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml'];

export function configRoutes(service: ConfigService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    // `curl --data-binary @arclight.yml -H 'content-type: application/yaml'` works too (this scope only).
    app.addContentTypeParser(YAML_TYPES, { parseAs: 'string' }, (_req: FastifyRequest, body: string | Buffer, done) =>
      done(null, typeof body === 'string' ? body : body.toString('utf8')),
    );

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof ConfigParseError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof BadInput) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled config error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get(
      '/config/export',
      { preHandler: requireAdmin, schema: { querystring: ConfigExportQuery } },
      async (req, reply) => {
        const { format, includeSecrets } = req.query;
        if (includeSecrets && req.headers['x-confirm'] !== EXPORT_SECRETS_CONFIRMATION) {
          return reply.code(400).send({
            error: `exporting secrets requires the header X-Confirm: ${EXPORT_SECRETS_CONFIRMATION}`,
            code: 'CONFIRMATION_REQUIRED',
          });
        }
        const doc = service.export({ includeSecrets });
        const ext = format === 'json' ? 'json' : 'yml';
        reply.header('content-disposition', `attachment; filename="arclight-config.${ext}"`);
        reply.header('cache-control', 'no-store');
        if (format === 'json') return reply.type('application/json; charset=utf-8').send(JSON.stringify(doc, null, 2));
        return reply.type('application/yaml; charset=utf-8').send(toYaml(doc));
      },
    );

    app.post(
      '/config/import',
      {
        preHandler: requireAdmin,
        schema: {
          body: ImportBody,
          querystring: ImportQuery,
          response: { 200: ConfigImportResult, 400: SettingsErrorResponse, 422: ConfigImportResult },
        },
      },
      async (req, reply) => {
        const input = readInput(req.body, req.query);
        const outcome = service.import(input.raw, {
          dryRun: input.dryRun,
          ...(input.prune !== undefined ? { prune: input.prune } : {}),
        });
        const { managed: _managed, changedSections: _changed, ...result } = outcome;
        return reply.code(!input.dryRun && outcome.errors.length > 0 ? 422 : 200).send(result);
      },
    );

    app.post(
      '/config/validate',
      {
        preHandler: requireAdmin,
        schema: { body: ImportBody, querystring: ImportQuery, response: { 200: ConfigValidateResult, 400: SettingsErrorResponse } },
      },
      async (req) => service.validate(readInput(req.body, req.query).raw),
    );

    app.get('/config/managed-keys', { schema: { response: { 200: ConfigManagedKeys } } }, async () => service.managedKeys());
  };
}
