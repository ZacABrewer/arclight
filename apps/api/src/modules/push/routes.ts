import {
  PushPreferences,
  PushPublicKey,
  PushSubscriptionDelete,
  PushSubscriptionInput,
  PushSubscriptionResource,
  PushTestResult,
} from '@arclight/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PushError, type PushService } from './service.js';
import { WebPushError } from './webpush.js';

// /api/v1/push/*: every route acts on the signed-in user (portal access); API-key callers
// without a user get 400 NO_USER.

const user = { access: { portal: true } } as const;
const ErrorBody = z.object({ error: z.string(), code: z.string() });
const errors = { 400: ErrorBody, 404: ErrorBody, 409: ErrorBody };

function userIdOf(req: FastifyRequest): number {
  const id = req.auth?.user?.id;
  if (id === undefined) throw new PushError('NO_USER', 'browser notifications need a signed-in user');
  return id;
}

export function pushRoutes(service: PushService): FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider> {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof PushError) return reply.code(err.code === 'NOT_FOUND' ? 404 : err.code === 'CONFLICT' ? 409 : 400).send({ error: err.message, code: err.code });
      if (err instanceof WebPushError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled push error');
      return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
    });

    app.get('/push/vapid-public-key', { config: user, schema: { response: { 200: PushPublicKey } } }, async () => ({ publicKey: service.publicKey() }));

    app.get('/push/subscription', { config: user, schema: { response: { 200: z.array(PushSubscriptionResource), ...errors } } }, async (req) =>
      service.list(userIdOf(req)),
    );

    app.post(
      '/push/subscription',
      { config: user, schema: { body: PushSubscriptionInput, response: { 201: PushSubscriptionResource, ...errors } } },
      async (req, reply) => {
        const userAgent = req.body.userAgent ?? (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 512) : undefined);
        const saved = service.subscribe(userIdOf(req), { ...req.body, ...(userAgent ? { userAgent } : {}) }, { isAdmin: req.auth?.isAdmin === true });
        return reply.code(201).send(saved);
      },
    );

    app.delete('/push/subscription', { config: user, schema: { body: PushSubscriptionDelete, response: { 204: z.null(), ...errors } } }, async (req, reply) => {
      if (!service.unsubscribe(userIdOf(req), req.body.endpoint)) throw new PushError('NOT_FOUND', 'no such subscription for this user');
      return reply.code(204).send(null);
    });

    app.get('/push/preferences', { config: user, schema: { response: { 200: PushPreferences, ...errors } } }, async (req) => service.preferences(userIdOf(req)));

    app.put('/push/preferences', { config: user, schema: { body: PushPreferences, response: { 200: PushPreferences, ...errors } } }, async (req) =>
      service.setPreferences(userIdOf(req), req.body),
    );

    // Non-admins learn only how many browsers took the test: failed / removed would tell apart how
    // each endpoint (any URL the caller registered) answered.
    app.post('/push/test', { config: user, schema: { response: { 200: PushTestResult, ...errors } } }, async (req) => {
      const result = await service.sendPush(userIdOf(req), { title: 'Arclight', body: 'Browser notifications are on.', url: '/profile', tag: 'push-test' });
      return req.auth?.isAdmin === true ? result : { sent: result.sent, failed: 0, removed: 0 };
    });
  };
}
