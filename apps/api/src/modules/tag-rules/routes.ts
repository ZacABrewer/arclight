import { z } from 'zod';
import {
  Tag,
  TagApplication,
  TagApplicationQuery,
  TagBulkDeleteRequest,
  TagBulkDeleteResult,
  TagMergeRequest,
  TagRule,
  TagRuleDeleteQuery,
  TagRuleErrorResponse,
  TagRuleInput,
  TagRuleOptions,
  TagRuleOrderRequest,
  TagRulePreviewRequest,
  TagRuleRunRequest,
  TagRuleRunResult,
  TagUsage,
} from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { TagRulesError, type TagRulesErrorCode, type TagRulesService } from './service.js';

const IdParams = z.object({ id: z.coerce.number().int().min(1) });
const errors = { 400: TagRuleErrorResponse, 404: TagRuleErrorResponse, 409: TagRuleErrorResponse };
const statusFor: Record<TagRulesErrorCode, number> = { NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409 };

export function tagRulesRoutes(service: TagRulesService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof TagRulesError) return reply.code(statusFor[err.code]).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled tag rules error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    // ---- rules -------------------------------------------------------------------------

    app.get('/tagrule', { schema: { response: { 200: z.array(TagRule) } } }, async () => service.listRules());

    app.get('/tagrule/options', { schema: { response: { 200: TagRuleOptions } } }, async () => service.options());

    // Detail pages mark auto-applied tags; readable with library access like the items themselves.
    app.get(
      '/tagrule/applied',
      { config: { access: { areas: ['library'] } }, schema: { querystring: TagApplicationQuery, response: { 200: z.array(TagApplication), ...errors } } },
      async (req) => service.applied(req.query.entityType, req.query.entityId),
    );

    app.get('/tagrule/:id', { schema: { params: IdParams, response: { 200: TagRule, ...errors } } }, async (req) => service.getRule(req.params.id));

    app.post('/tagrule', { schema: { body: TagRuleInput, response: { 201: TagRule, ...errors } } }, async (req, reply) =>
      reply.code(201).send(service.createRule(req.body)),
    );

    app.put('/tagrule/order', { schema: { body: TagRuleOrderRequest, response: { 200: z.array(TagRule), ...errors } } }, async (req) =>
      service.reorder(req.body.ids),
    );

    app.put('/tagrule/:id', { schema: { params: IdParams, body: TagRuleInput, response: { 200: TagRule, ...errors } } }, async (req) =>
      service.updateRule(req.params.id, req.body),
    );

    app.delete(
      '/tagrule/:id',
      { schema: { params: IdParams, querystring: TagRuleDeleteQuery, response: { 204: z.null(), ...errors } } },
      async (req, reply) => {
        service.deleteRule(req.params.id, { removeTags: req.query.removeTags });
        return reply.code(204).send(null);
      },
    );

    app.post('/tagrule/preview', { schema: { body: TagRulePreviewRequest, response: { 200: TagRuleRunResult, ...errors } } }, async (req) =>
      service.preview(req.body.rule, req.body.id),
    );

    app.post('/tagrule/run', { schema: { body: TagRuleRunRequest.nullish(), response: { 200: TagRuleRunResult, ...errors } } }, async (req) =>
      service.run({ ruleIds: req.body?.ruleIds, dryRun: req.body?.dryRun ?? false }),
    );

    // ---- tag management ----------------------------------------------------------------

    app.get('/tag/usage', { schema: { response: { 200: z.array(TagUsage) } } }, async () => service.usage());

    app.post('/tag/:id/merge', { schema: { params: IdParams, body: TagMergeRequest, response: { 200: Tag, ...errors } } }, async (req) =>
      service.mergeTag(req.params.id, req.body.intoId),
    );

    app.post('/tag/delete', { schema: { body: TagBulkDeleteRequest, response: { 200: TagBulkDeleteResult, ...errors } } }, async (req) =>
      service.deleteTags(req.body.ids, req.body.force),
    );
  };
}
