import { createHash, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AgentError, type EngineAgentCore } from './core.js';
import { multipartBoundary, parseMultipart } from './multipart.js';
import {
  AGENT_ERROR_STATUS,
  AGENT_TOKEN_HEADER,
  AgentCategoryBody,
  AgentListenPortBody,
  AgentSavePathBody,
  type AgentErrorBody,
} from './protocol.js';

/** A transport-neutral request: the path is relative to the agent's base URL. */
export interface AgentRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body?: Buffer;
}

/** A transport-neutral response: JSON (`json`), raw bytes (`stream`) or nothing (204). */
export interface AgentResponse {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  stream?: Readable;
}

/** Largest request body the agent accepts (a .torrent with a few options). */
export const MAX_AGENT_BODY_BYTES = 16 * 1024 * 1024;

function header(req: AgentRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Constant-time comparison of the presented token (x-agent-token or Bearer) with `expected`. */
export function tokenMatches(headers: AgentRequest['headers'], expected: string): boolean {
  if (!expected) return false;
  const raw = headers[AGENT_TOKEN_HEADER];
  let presented = Array.isArray(raw) ? raw[0] : raw;
  if (!presented) {
    const auth = headers['authorization'];
    const value = Array.isArray(auth) ? auth[0] : auth;
    if (value?.toLowerCase().startsWith('bearer ')) presented = value.slice(7).trim();
  }
  if (!presented) return false;
  // Hash both so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function errorResponse(error: AgentError): AgentResponse {
  const body: AgentErrorBody = { error: error.message, code: error.code };
  return { status: AGENT_ERROR_STATUS[error.code], headers: {}, json: body };
}

function json(status: number, value: unknown): AgentResponse {
  return { status, headers: {}, json: value };
}

const NO_CONTENT: AgentResponse = { status: 204, headers: {} };

function parseJsonBody(req: AgentRequest): unknown {
  if (!req.body || req.body.length === 0) return {};
  try {
    return JSON.parse(req.body.toString('utf8'));
  } catch (error) {
    throw new AgentError('bad-request', 'The request body is not valid JSON.', { cause: error });
  }
}

function bodyOf<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, req: AgentRequest): T {
  const parsed = schema.safeParse(parseJsonBody(req));
  if (!parsed.success) throw new AgentError('bad-request', `Invalid request body: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * Routes one protocol request to the core. Authentication is the transport's job; this only
 * answers already-authenticated requests. Never throws: failures become error responses.
 */
export async function handleAgentRequest(core: EngineAgentCore, req: AgentRequest): Promise<AgentResponse> {
  try {
    return await route(core, req);
  } catch (error) {
    if (error instanceof AgentError) return errorResponse(error);
    return errorResponse(new AgentError('internal', error instanceof Error ? error.message : String(error)));
  }
}

async function route(core: EngineAgentCore, req: AgentRequest): Promise<AgentResponse> {
  const method = req.method.toUpperCase();
  const parts = req.path.split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
  const notFound = () => new AgentError('not-found', `No route ${method} /${parts.join('/')}.`);

  if (parts.length === 1 && parts[0] === 'status' && method === 'GET') return json(200, core.status());
  if (parts.length === 1 && parts[0] === 'listen-port' && method === 'PUT') {
    return json(200, await core.setListenPort(bodyOf(AgentListenPortBody, req).port));
  }
  if (parts[0] !== 'torrents') throw notFound();

  if (parts.length === 1) {
    if (method === 'GET') return json(200, core.list(req.query.get('category') ?? undefined));
    if (method === 'POST') {
      const boundary = multipartBoundary(header(req, 'content-type'));
      if (boundary) {
        let form;
        try {
          form = parseMultipart(req.body ?? Buffer.alloc(0), boundary);
        } catch (error) {
          throw new AgentError('bad-request', `Invalid multipart body: ${error instanceof Error ? error.message : String(error)}`);
        }
        const file = form.find((p) => p.name === 'torrent');
        const optionsPart = form.find((p) => p.name === 'options');
        let options: unknown = {};
        if (optionsPart) {
          try {
            options = JSON.parse(optionsPart.data.toString('utf8'));
          } catch (error) {
            throw new AgentError('bad-request', 'The options part is not valid JSON.', { cause: error });
          }
        }
        const result = await core.add(options, file ? new Uint8Array(file.data) : undefined);
        return json(result.duplicate ? 200 : 201, result);
      }
      const result = await core.add(parseJsonBody(req));
      return json(result.duplicate ? 200 : 201, result);
    }
    throw notFound();
  }

  const id = parts[1]!;
  if (parts.length === 2) {
    if (method === 'GET') return json(200, core.get(id));
    if (method === 'DELETE') {
      await core.remove(id, req.query.get('deleteData') === 'true');
      return NO_CONTENT;
    }
    throw notFound();
  }

  const action = parts[2];
  if (parts.length === 3) {
    if (action === 'pause' && method === 'POST') {
      await core.pause(id);
      return NO_CONTENT;
    }
    if (action === 'resume' && method === 'POST') {
      await core.resume(id);
      return NO_CONTENT;
    }
    if (action === 'category' && method === 'PUT') {
      await core.setCategory(id, bodyOf(AgentCategoryBody, req).category);
      return NO_CONTENT;
    }
    if (action === 'save-path' && method === 'PUT') {
      await core.setSavePath(id, bodyOf(AgentSavePathBody, req).savePath);
      return NO_CONTENT;
    }
    if (action === 'files' && method === 'GET') return json(200, core.files(id));
    throw notFound();
  }

  if (action === 'files' && parts.length === 5) {
    const index = Number(parts[3]);
    if (!Number.isInteger(index) || index < 0) throw new AgentError('bad-request', `Invalid file index ${parts[3]}.`);
    if (parts[4] === 'sha256' && method === 'GET') return json(200, await core.checksum(id, index));
    if (parts[4] === 'content' && (method === 'GET' || method === 'HEAD')) {
      const range = await core.fileRange(id, index, header(req, 'range'));
      const length = Math.max(0, range.end - range.start + 1);
      const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        'content-length': String(length),
        'accept-ranges': 'bytes',
      };
      if (range.partial) headers['content-range'] = `bytes ${length === 0 ? '*' : `${range.start}-${range.end}`}/${range.size}`;
      const res: AgentResponse = { status: range.partial ? 206 : 200, headers };
      if (method === 'GET' && length > 0) res.stream = core.openRange(range);
      return res;
    }
  }
  throw notFound();
}
