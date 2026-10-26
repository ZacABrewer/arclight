import { SolverError } from './errors.js';
import type { ChallengeSolver, SolverCookie } from './solver.js';

/**
 * The FlareSolverr `/v1` JSON contract on top of ChallengeSolver, so any FlareSolverr client
 * (including @arclight/indexers' FlareSolverrClient) can target the built-in solver unchanged.
 * Like FlareSolverr, failures answer HTTP 500 with `{status:"error", message}`.
 */

export interface FlareSolverrSolutionBody {
  url: string;
  status: number;
  headers: Record<string, string>;
  /** The page HTML. */
  response: string;
  cookies: SolverCookie[];
  userAgent: string;
}

export interface FlareSolverrResponseBody {
  status: 'ok' | 'error';
  message: string;
  startTimestamp: number;
  endTimestamp: number;
  version: string;
  solution?: FlareSolverrSolutionBody;
  session?: string;
  sessions?: string[];
}

export interface FlareSolverrHttpResult {
  httpStatus: 200 | 500;
  body: FlareSolverrResponseBody;
}

export interface HandleCommandOptions {
  version?: string;
  now?: () => number;
  /** Called for parameters the built-in solver accepts but ignores (e.g. `proxy`). */
  warn?: (message: string) => void;
}

export const SOLVER_API_VERSION = '3.3.21-arclight';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Run one FlareSolverr command. Never throws. */
export async function handleFlareSolverrCommand(solver: ChallengeSolver, raw: unknown, opts: HandleCommandOptions = {}): Promise<FlareSolverrHttpResult> {
  const now = opts.now ?? Date.now;
  const startTimestamp = now();
  const version = opts.version ?? SOLVER_API_VERSION;
  const ok = (message: string, extra: Partial<FlareSolverrResponseBody> = {}): FlareSolverrHttpResult => ({
    httpStatus: 200,
    body: { status: 'ok', message, startTimestamp, endTimestamp: now(), version, ...extra },
  });
  const fail = (message: string): FlareSolverrHttpResult => ({
    httpStatus: 500,
    body: { status: 'error', message: `Error: ${message}`, startTimestamp, endTimestamp: now(), version },
  });

  if (!isObject(raw)) return fail('Request body must be a JSON object');
  const cmd = typeof raw['cmd'] === 'string' ? raw['cmd'] : '';
  const session = typeof raw['session'] === 'string' && raw['session'] !== '' ? raw['session'] : undefined;
  try {
    switch (cmd) {
      case 'sessions.create': {
        const id = solver.createSession(session);
        return ok('Session created successfully.', { session: id });
      }
      case 'sessions.list':
        return ok('', { sessions: solver.listSessions() });
      case 'sessions.destroy': {
        if (!session) return fail('Request parameter "session" is mandatory in sessions.destroy command.');
        if (!(await solver.destroySession(session))) return fail("The session doesn't exist.");
        return ok('The session has been removed.');
      }
      case 'request.get':
      case 'request.post': {
        const url = typeof raw['url'] === 'string' ? raw['url'] : '';
        if (!url) return fail(`Request parameter "url" is mandatory in ${cmd} command.`);
        const isPost = cmd === 'request.post';
        const postData = typeof raw['postData'] === 'string' ? raw['postData'] : undefined;
        if (isPost && postData === undefined) return fail('Request parameter "postData" is mandatory in request.post command.');
        if (raw['proxy'] !== undefined) opts.warn?.('The built-in solver ignores the "proxy" parameter; it egresses through the host network.');
        const maxTimeout = raw['maxTimeout'];
        const result = await solver.solve({
          method: isPost ? 'POST' : 'GET',
          url,
          ...(postData !== undefined ? { postData } : {}),
          ...(typeof maxTimeout === 'number' && maxTimeout > 0 ? { timeoutMs: maxTimeout } : {}),
          ...(session ? { session } : {}),
        });
        return ok(result.challenged ? 'Challenge solved!' : 'Challenge not detected!', {
          solution: {
            url: result.url,
            status: result.status,
            headers: result.headers,
            response: result.html,
            cookies: result.cookies,
            userAgent: result.userAgent,
          },
        });
      }
      default:
        return fail(`Request parameter "cmd" = "${cmd}" is invalid.`);
    }
  } catch (err) {
    if (err instanceof SolverError) return fail(err.message);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
