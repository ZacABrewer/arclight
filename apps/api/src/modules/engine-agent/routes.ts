import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { handleAgentRequest, MAX_AGENT_BODY_BYTES, type AgentErrorBody } from '@arclight/engine-agent';
import { EngineAgentSettingsResponse, EngineAgentSettingsUpdate } from '@arclight/shared';
import { z } from 'zod';
import { EngineAgentSettingsError, type EngineAgentService } from './service.js';

// /api/v1/engine-agent/* serves the agent protocol (see @arclight/engine-agent protocol.ts) for
// other Arclights; /api/v1/settings/engineagent reads and toggles it. Protocol routes answer in
// the agent's error shape ({ error, code }) so the remote client maps failures the same way it
// does for the standalone agent.

type Plugin = FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

function agentError(reply: FastifyReply, status: number, body: AgentErrorBody) {
  return reply.code(status).send(body);
}

/** Protocol guard: enabled, and the caller authenticated with the API key (machine access). */
function guard(service: EngineAgentService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!service.enabled()) {
      return agentError(reply, 404, { error: 'The engine agent is disabled on this Arclight.', code: 'not-found' });
    }
    if (req.auth?.via !== 'apikey') {
      return agentError(reply, 401, { error: "The engine agent requires this Arclight's API key (X-Api-Key).", code: 'unauthorized' });
    }
    return undefined;
  };
}

export function engineAgentRoutes(service: EngineAgentService): Plugin {
  return async (app) => {
    // Settings: JSON; writes are admin-only through the auth hook.
    await app.register(async (scope) => {
      scope.setErrorHandler((err, req, reply) => {
        if (err instanceof EngineAgentSettingsError) return reply.code(400).send({ error: err.message, code: err.code });
        if (err instanceof Error && 'validation' in err && err.validation) {
          return reply.code(400).send({ error: err.message, code: 'VALIDATION' });
        }
        req.log.error({ err }, 'unhandled engine-agent error');
        return reply.code(500).send({ error: 'internal error', code: 'INTERNAL' });
      });
      scope.get('/settings/engineagent', { schema: { response: { 200: EngineAgentSettingsResponse } } }, async () => service.response());
      scope.put(
        '/settings/engineagent',
        { schema: { body: EngineAgentSettingsUpdate, response: { 200: EngineAgentSettingsResponse } } },
        async (req) => service.updateSettings(req.body),
      );
    });

    // The protocol: raw bodies (JSON or multipart .torrent uploads) go to the shared router.
    await app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_AGENT_BODY_BYTES }, (_req, body, done) => done(null, body));
      const preValidation = guard(service);

      scope.get('/engine-agent/events', { websocket: true, preValidation }, (socket) => {
        socket.send(JSON.stringify({ type: 'hello', status: service.core.status() }));
        const unsubscribe = service.core.subscribe((event) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
        });
        socket.on('close', unsubscribe);
        socket.on('error', unsubscribe);
      });

      scope.route({
        method: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        url: '/engine-agent/*',
        exposeHeadRoute: false,
        bodyLimit: MAX_AGENT_BODY_BYTES,
        schema: { params: z.object({ '*': z.string() }) },
        preValidation,
        handler: async (req, reply) => {
          const q = req.url.indexOf('?');
          const out = await handleAgentRequest(service.core, {
            method: req.method,
            path: `/${(req.params as { '*': string })['*']}`,
            query: new URLSearchParams(q >= 0 ? req.url.slice(q + 1) : ''),
            headers: req.headers,
            ...(Buffer.isBuffer(req.body) ? { body: req.body } : {}),
          });
          reply.code(out.status).headers(out.headers);
          if (out.json !== undefined) return reply.send(out.json);
          if (out.stream) return reply.send(out.stream);
          return reply.send();
        },
      });
    });
  };
}
