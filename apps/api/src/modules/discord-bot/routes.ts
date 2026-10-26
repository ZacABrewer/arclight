import { z } from 'zod';
import { DiscordBotSettings, DiscordBotStatus, DiscordBotTestResult, DiscordLinkCode, ErrorResponse } from '@arclight/shared';
import type { FastifyPluginAsync, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAdmin } from '../auth/index.js';
import { DiscordBotError, type DiscordBotService } from './service.js';

type Plugin = FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse };
const Empty = z.null();

function selfId(req: FastifyRequest): number {
  const id = req.auth?.user?.id;
  if (id === undefined) throw new DiscordBotError('NOT_SIGNED_IN', 'this request is not signed in as a user');
  return id;
}

export function discordBotRoutes(service: DiscordBotService): Plugin {
  return async (app) => {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof DiscordBotError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof Error && 'validation' in err && err.validation) return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
      req.log.error({ err }, 'unhandled discord bot error');
      return reply.code(500).send({ error: 'internal error' });
    });

    app.get('/discordbot/status', { preHandler: requireAdmin, schema: { response: { 200: DiscordBotStatus, ...errors } } }, async () => service.status());
    app.post(
      '/discordbot/test',
      { preHandler: requireAdmin, schema: { body: DiscordBotSettings.nullish(), response: { 200: DiscordBotTestResult, ...errors } } },
      async (req) => service.test(req.body ?? undefined),
    );
    app.get('/settings/discordbot', { preHandler: requireAdmin, schema: { response: { 200: DiscordBotSettings, ...errors } } }, async () => service.settings());
    app.put(
      '/settings/discordbot',
      { preHandler: requireAdmin, schema: { body: DiscordBotSettings, response: { 200: DiscordBotSettings, ...errors } } },
      async (req) => service.updateSettings(req.body),
    );

    app.post(
      '/user/me/discord/link-code',
      { config: { access: { portal: true } }, schema: { response: { 200: DiscordLinkCode, ...errors } } },
      async (req) => service.createLinkCode(selfId(req)),
    );
    app.delete('/user/me/discord/link', { config: { access: { portal: true } }, schema: { response: { 204: Empty, ...errors } } }, async (req, reply) => {
      service.unlink(selfId(req));
      return reply.code(204).send(null);
    });
  };
}
