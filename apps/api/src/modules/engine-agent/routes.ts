import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AGENT_DEPRECATION_HEADER, handleAgentRequest, MAX_AGENT_BODY_BYTES, type AgentErrorBody } from '@arclight/engine-agent';
import { EngineAgentSettingsResponse, EngineAgentSettingsUpdate } from '@arclight/shared';
import { z } from 'zod';
import { EngineAgentSettingsError, type EngineAgentService } from './service.js';

// /api/v1/engine-agent/* serves the agent protocol (see @arclight/engine-agent protocol.ts) for
// other Arclights; /api/v1/settings/engineagent reads and toggles it (and shows the agent token),
// POST /api/v1/settings/engineagent/token replaces the token. Protocol routes answer in the
// agent's error shape ({ error, code }) so the remote client maps failures the same way it does
// for the standalone agent. The auth hook lets them through without credentials (PUBLIC_PREFIXES):
// the guard below checks the agent token itself, so the token never opens any other route.

type Plugin = FastifyPluginAsync<Record<never, never>, RawServerDefault, ZodTypeProvider>;

function agentError(reply: FastifyReply, status: number, body: AgentErrorBody) {
  return reply.code(status).send(body);
}

/** Protocol guard: enabled, and the caller presented the agent token (or, deprecated, the API key). */
function guard(service: EngineAgentService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!service.enabled()) {
      return agentError(reply, 404, { error: 'The engine agent is disabled on this Arclight.', code: 'not-found' });
    }
    // Only the instance's own (global) API key counts as the deprecated way in, never a per-user key.
    const globalApiKey = req.auth?.via === 'apikey' && req.auth.user === null && req.auth.isAdmin;
    const result = service.authenticate(req.headers, req.ip, globalApiKey);
    if (!result.ok) {
      if (result.status === 429) {
        reply.header('retry-after', String(result.retryAfterSeconds ?? 1));
        return agentError(reply, 429, { error: `Too many failed sign-ins from this address; try again in ${result.retryAfterSeconds ?? 1} s.`, code: 'rate-limited' });
      }
      return agentError(reply, 401, {
        error: "The engine agent requires this Arclight's agent token (Settings > Download Clients > Act as remote engine) in x-agent-token.",
        code: 'unauthorized',
      });
    }
    if (result.via === 'api-key') {
      reply.header(AGENT_DEPRECATION_HEADER, 'api-key');
      if (service.shouldLogDeprecation()) {
        req.log.warn(
          { ip: req.ip },
          'a remote engine client signed in with the API key; switch it to the agent token (Settings > Download Clients > Act as remote engine), then turn off "Also accept the API key"',
        );
      }
    }
    return undefined;
  };
}

/** The protocol path from the raw URL (still percent-encoded: the agent router decodes it once). */
function protocolPath(rawUrl: string): string {
  const path = rawUrl.split('?')[0] ?? '';
  const at = path.indexOf('/engine-agent/');
  return at >= 0 ? path.slice(at + '/engine-agent'.length) : '/';
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
      scope.post('/settings/engineagent/token', { schema: { response: { 200: EngineAgentSettingsResponse } } }, async () => service.regenerateToken());
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
            path: protocolPath(req.url),
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
