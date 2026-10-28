import { ProxyAutoDetectResult, SolverSettings, SolverSettingsUpdate, SolverStatus } from '@arclight/shared';
import type { FastifyPluginAsync, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SettingsError } from '../settings/service.js';
import type { SolverService } from './service.js';

// /api/v1/solver/* and /api/v1/settings/solver. Thin: validate -> service -> reply.
// POST /solver/v1 speaks the FlareSolverr JSON contract (answers 200 or 500 like FlareSolverr)
// and sits behind the normal /api/v1 auth hook, so callers send X-Api-Key.

export interface SolverRoutesOptions {
  service: SolverService;
  /** Id of the "Built-in solver" proxy, if registered. */
  builtinProxyId: () => number | null;
  /** FlareSolverr proxies other than the built-in one. */
  externalSolvers?: () => Array<{ id: number; name: string }>;
  /** Arclight runs in a container. */
  docker?: boolean;
  /** Run ProxyAutoDetect now. */
  autodetect: () => Promise<ProxyAutoDetectResult>;
}

const ErrorBody = z.object({ error: z.string(), code: z.string() });

export function solverRoutes(opts: SolverRoutesOptions): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  const { service } = opts;
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof z.ZodError) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled solver error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.post('/solver/v1', { schema: { body: z.unknown() } }, async (req, reply) => {
      const result = await service.handle(req.body);
      return reply.code(result.httpStatus).send(result.body);
    });

    app.get('/solver/status', { schema: { response: { 200: SolverStatus } } }, async () => ({
      ...service.status(opts.builtinProxyId()),
      externalSolvers: opts.externalSolvers?.() ?? [],
      docker: opts.docker ?? false,
    }));

    app.post('/solver/autodetect', { schema: { response: { 200: ProxyAutoDetectResult } } }, async () => opts.autodetect());

    app.get('/settings/solver', { schema: { response: { 200: SolverSettings } } }, async () => service.settings());

    app.put('/settings/solver', { schema: { body: SolverSettingsUpdate, response: { 200: SolverSettings, 400: ErrorBody } } }, async (req) => {
      const saved = service.updateSettings(req.body);
      await opts.autodetect();
      return saved;
    });
  };
}
