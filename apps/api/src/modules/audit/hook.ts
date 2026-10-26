import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RequestAuth } from '../auth/service.js';
import { describeAction, isSkipped, MUTATING_METHODS } from './actions.js';
import type { AuditSink } from './recorder.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** `false` keeps this route out of the audit log (noisy, read-only POSTs). */
    audit?: boolean;
  }
}

const API_PREFIX = '/api/v1';

/** Who did it, for callers that have no user (API key, Basic without a user, local bypass). */
export function actorOf(auth: RequestAuth | null | undefined): { userId: number | null; username: string | null } {
  if (!auth) return { userId: null, username: null };
  if (auth.user) return { userId: auth.user.id, username: auth.user.username };
  return { userId: null, username: `(${auth.via})` };
}

/** The onResponse hook: one audit row per mutating, matched, not-opted-out request. */
export function auditHook(sink: AuditSink) {
  return async function auditOnResponse(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!MUTATING_METHODS.has(req.method)) return;
    const pattern = req.routeOptions?.url;
    if (!pattern) return; // unmatched 404s
    if (req.routeOptions.config?.audit === false) return;
    const route = pattern.startsWith(API_PREFIX) ? pattern.slice(API_PREFIX.length) || '/' : pattern;
    if (isSkipped(req.method, route)) return;
    const { action, target } = describeAction(req.method, route, req.params);
    const details: Record<string, unknown> = { durationMs: Math.round(reply.elapsedTime) };
    const query = req.query as Record<string, unknown> | undefined;
    if (query && Object.keys(query).length > 0) {
      const { apikey: _apikey, ...rest } = query;
      if (Object.keys(rest).length > 0) details['query'] = rest;
    }
    if (req.body !== undefined && req.body !== null && typeof req.body !== 'string' && !Buffer.isBuffer(req.body)) {
      details['body'] = req.body;
    }
    sink.record({
      action,
      target,
      ...actorOf(req.auth),
      ip: req.ip,
      method: req.method,
      route,
      statusCode: reply.statusCode,
      details,
    });
  };
}

/**
 * Adds the audit hook to a scope. app.ts calls it on the /api/v1 scope right after installAuth
 * (so it covers every module's routes and sees `req.auth`).
 */
export function installAuditHook(scope: FastifyInstance, sink: AuditSink): void {
  scope.addHook('onResponse', auditHook(sink));
}
