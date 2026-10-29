import { z } from 'zod';
import { BULK_ACTIONS, BulkActionRequest, BulkActionResult, type BulkId } from '@arclight/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppModule } from '../../app.js';
import { API_PREFIX } from '../auth/hook.js';
import { BulkItemError, HANDLERS, type HandlerInput, type RouteCall } from './handlers.js';

export { HANDLERS } from './handlers.js';

// POST /bulk (the "Bulk actions" notes in docs/using/*.md): one action over many rows of a settings,
// activity or system list. Each id goes through its single-item route with the caller's
// credentials, so validation, in-use guards, auth and audit are exactly those of a single
// change; the answer lists what worked and why the rest did not. Admin only (no `access`).
// Library and Wanted bulk commands live in ../bulk.

const BulkErrorResponse = z.object({ error: z.string(), code: z.string().optional() });

/** How many ids run at once: tests reach out to remote services, deletes are quick either way. */
const CONCURRENCY = 4;

/** Headers that carry who the caller is; nothing else is forwarded. */
const FORWARDED = ['cookie', 'x-api-key', 'authorization', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'user-agent'] as const;

/**
 * Calls a single-item route as the caller: same credentials and peer address, so the route's
 * own auth applies exactly as if the browser had called it.
 */
export function callerRoutes(app: FastifyInstance, req: FastifyRequest): RouteCall {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
    else if (Array.isArray(value) && value.length) headers[name] = value.join(', ');
  }
  const remoteAddress = (req.socket as FastifyRequest['socket'] | undefined)?.remoteAddress;
  return async (method, url, payload) => {
    const res = await app.inject({
      method,
      url: `${API_PREFIX}${url}`,
      headers,
      ...(remoteAddress ? { remoteAddress } : {}),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    let json: unknown;
    try {
      json = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      json = undefined;
    }
    return { statusCode: res.statusCode, json };
  };
}

type Outcome = { ok: true } | { ok: false; error: string; code?: string };

/** Runs `fn` over `ids` with at most `limit` in flight; results keep the ids' order. */
export async function runBulk(ids: readonly BulkId[], fn: (id: BulkId) => Promise<void>, limit = CONCURRENCY): Promise<BulkActionResult> {
  const outcomes: Outcome[] = new Array<Outcome>(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      try {
        await fn(ids[i]!);
        outcomes[i] = { ok: true };
      } catch (err) {
        const code = err instanceof BulkItemError ? err.code : undefined;
        outcomes[i] = { ok: false, error: err instanceof Error ? err.message : String(err), ...(code ? { code } : {}) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, worker));
  const result: BulkActionResult = { ok: [], failed: [] };
  outcomes.forEach((o, i) => {
    const id = ids[i]!;
    if (o.ok) result.ok.push(id);
    else result.failed.push({ id, error: o.error, ...(o.code ? { code: o.code } : {}) });
  });
  return result;
}

export const bulkActionsModule: AppModule = () => async (app) => {
  app.post(
    '/bulk',
    { schema: { body: BulkActionRequest, response: { 200: BulkActionResult, 400: BulkErrorResponse } } },
    async (req, reply) => {
      const { resource, action } = req.body;
      const handler = HANDLERS[resource][action];
      if (!handler || !BULK_ACTIONS[resource].includes(action)) {
        return reply.code(400).send({ error: `${resource} does not take the bulk action ${action}`, code: 'BULK_UNSUPPORTED' });
      }
      const ids = [...new Set(req.body.ids)];
      const input: HandlerInput = { call: callerRoutes(app as unknown as FastifyInstance, req), tags: req.body.tags ?? [] };
      return runBulk(ids, (id) => handler(id, input));
    },
  );
};
