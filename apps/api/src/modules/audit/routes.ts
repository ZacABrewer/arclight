import { z } from 'zod';
import { AuditPage, AuditQuery, AuditSettings, SettingsErrorResponse } from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAdmin } from '../auth/hook.js';
import type { EventBus } from '../../events.js';
import { getSection, setSection } from '../settings/service.js';
import { AuditError, type AuditService } from './service.js';

const ExportQuery = AuditQuery.omit({ page: true, pageSize: true });

export function auditRoutes(service: AuditService, bus?: EventBus): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.addHook('preHandler', requireAdmin);

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof AuditError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) {
        return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      }
      req.log.error({ err }, 'unhandled audit error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/audit', { schema: { querystring: AuditQuery, response: { 200: AuditPage, 400: SettingsErrorResponse } } }, async (req) =>
      service.list(req.query),
    );

    app.get('/settings/audit', { schema: { response: { 200: AuditSettings } } }, async () => getSection(service.db, 'audit'));

    app.put('/settings/audit', { schema: { body: AuditSettings, response: { 200: AuditSettings, 400: SettingsErrorResponse } } }, async (req) => {
      const saved = setSection(service.db, 'audit', req.body);
      bus?.publish({ type: 'settings', section: 'audit' });
      return saved;
    });

    app.get('/audit/actions', { schema: { response: { 200: z.array(z.string()) } } }, async () => service.actions());

    app.get('/audit/export', { schema: { querystring: ExportQuery } }, async (req, reply) => {
      const csv = service.csv(req.query);
      reply.header('content-disposition', `attachment; filename="arclight-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
      reply.header('cache-control', 'no-store');
      return reply.type('text/csv; charset=utf-8').send(csv);
    });
  };
}
