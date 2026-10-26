import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { isMetadataError } from '@arclight/metadata';
import { DownloadClientsError } from '../download-clients/index.js';
import { HistoryError } from '../history/index.js';
import { ImportsError } from '../imports/index.js';
import { IndexersError } from '../indexers/index.js';
import { LibraryError } from '../library/index.js';
import { ProfileError } from '../profiles/index.js';
import { ReleasesError } from '../releases/index.js';
import { CompatError, validationFailure } from './common.js';

// One place maps every typed service error onto upstream-shaped responses:
// 404 -> { message }, 400 -> [ValidationFailure], 5xx -> { message, description }.

function statusOf(err: unknown): { status: number; property?: string } | null {
  if (err instanceof CompatError) return { status: err.status };
  if (err instanceof LibraryError) return { status: err.code === 'NOT_FOUND' ? 404 : 400 };
  if (err instanceof ReleasesError) {
    const map = { NOT_FOUND: 404, VALIDATION: 400, UNAVAILABLE: 404, DOWNLOAD_FAILED: 502, CLIENT_UNAVAILABLE: 503 } as const;
    return { status: map[err.code] };
  }
  if (err instanceof IndexersError) return { status: err.code === 'NOT_FOUND' ? 404 : 400 };
  if (err instanceof ImportsError) return { status: err.code === 'NOT_FOUND' ? 404 : 400 };
  if (err instanceof ProfileError) return { status: err.code === 'NOT_FOUND' ? 404 : 400 };
  if (err instanceof HistoryError) return { status: err.code === 'NOT_FOUND' ? 404 : 400 };
  if (err instanceof DownloadClientsError) return { status: err.code === 'NOT_FOUND' ? 404 : err.code === 'CLIENT_ERROR' ? 502 : 400 };
  if (isMetadataError(err)) return { status: err.code === 'not-found' ? 404 : 503 };
  return null;
}

export function compatErrorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if ('validation' in err && err.validation) {
    return reply.code(400).send([validationFailure('request', err.message)]);
  }
  const mapped = statusOf(err);
  if (!mapped) {
    req.log.error({ err }, 'unhandled compat api error');
    return reply.code(500).send({ message: 'Internal error', description: err.message });
  }
  if (mapped.status === 404) return reply.code(404).send({ message: err instanceof CompatError ? err.message : 'NotFound', description: err.message });
  if (mapped.status === 400) {
    const failures = err instanceof CompatError && err.failures ? err.failures : [validationFailure('', err.message)];
    return reply.code(400).send(failures);
  }
  return reply.code(mapped.status).send({ message: err.message });
}
