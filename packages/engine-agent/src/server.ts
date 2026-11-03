import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { AgentError, type EngineAgentCore } from './core.js';
import { errorResponse, handleAgentRequest, MAX_AGENT_BODY_BYTES, tokenMatches, type AgentResponse } from './router.js';
import { AuthThrottle } from './throttle.js';
import { acceptWebSocket, type ServerSocket } from './ws.js';

export interface AgentServerOptions {
  core: EngineAgentCore;
  /** Shared secret every request must present. An empty token refuses everything. */
  token: string;
  /** Keep-alive ping interval on event sockets. Default 30 s. */
  pingIntervalMs?: number;
  /** Request log hook (method, path, status). */
  onRequest?: (info: { method: string; path: string; status: number }) => void;
  /** Serve HTTPS with this certificate and key (PEM). */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** Back-off after failed authentication, per client address (default: 5 free, then 1 s doubling up to 15 min). */
  throttle?: AuthThrottle;
}

export interface AgentServer {
  readonly server: Server;
  listen(port: number, host?: string): Promise<AddressInfo>;
  /** Stops accepting, closes event sockets and open connections. */
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_AGENT_BODY_BYTES) {
        reject(new AgentError('bad-request', `Request body larger than ${MAX_AGENT_BODY_BYTES} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function send(res: ServerResponse, out: AgentResponse): Promise<void> {
  const headers: Record<string, string> = { ...out.headers };
  if (out.json !== undefined) {
    const body = Buffer.from(JSON.stringify(out.json));
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = String(body.length);
    res.writeHead(out.status, headers);
    res.end(body);
    return;
  }
  res.writeHead(out.status, headers);
  if (out.stream) {
    try {
      await pipeline(out.stream, res);
    } catch {
      // The client went away mid-transfer; it resumes with a Range request.
    }
    return;
  }
  res.end();
}

/** The standalone agent's HTTP + WebSocket server on node:http (no framework). */
export function createAgentServer(opts: AgentServerOptions): AgentServer {
  const sockets = new Set<ServerSocket>();
  const throttle = opts.throttle ?? new AuthThrottle();

  /** null when the request may go on; otherwise the refusal (throttled or bad token). */
  const authenticate = (req: IncomingMessage): { out: AgentResponse; retryAfter?: number } | null => {
    const address = req.socket.remoteAddress;
    const wait = throttle.retryAfterMs(address);
    if (wait > 0) {
      const retryAfter = Math.ceil(wait / 1000);
      const out = errorResponse(new AgentError('rate-limited', `Too many failed sign-ins from this address; try again in ${retryAfter} s.`));
      out.headers['retry-after'] = String(retryAfter);
      return { out, retryAfter };
    }
    if (!tokenMatches(req.headers, opts.token)) {
      throttle.fail(address);
      return { out: errorResponse(new AgentError('unauthorized', 'A valid agent token is required.')) };
    }
    throttle.succeed(address);
    return null;
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://agent');
      const method = req.method ?? 'GET';
      let out: AgentResponse;
      const refused = authenticate(req);
      if (refused) {
        out = refused.out;
        // Do not read (possibly large) bodies of unauthenticated requests.
        res.setHeader('connection', 'close');
      } else {
        try {
          const body = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : await readBody(req);
          out = await handleAgentRequest(opts.core, {
            method,
            path: url.pathname,
            query: url.searchParams,
            headers: req.headers,
            ...(body ? { body } : {}),
          });
        } catch (error) {
          out = errorResponse(error instanceof AgentError ? error : new AgentError('internal', String(error)));
        }
      }
      opts.onRequest?.({ method, path: url.pathname, status: out.status });
      await send(res, out);
    })();
  };
  const server: Server = opts.tls ? createTlsServer({ cert: opts.tls.cert, key: opts.tls.key }, handler) : createServer(handler);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://agent');
    if (url.pathname !== '/events') {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
      return;
    }
    const refused = authenticate(req);
    if (refused) {
      const status = refused.retryAfter !== undefined ? `429 Too Many Requests\r\nretry-after: ${refused.retryAfter}` : '401 Unauthorized';
      socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
      return;
    }
    const ws = acceptWebSocket(req, socket, head, opts.pingIntervalMs);
    if (!ws) return;
    sockets.add(ws);
    ws.send(JSON.stringify({ type: 'hello', status: opts.core.status() }));
    const unsubscribe = opts.core.subscribe((event) => ws.send(JSON.stringify(event)));
    ws.onClose(() => {
      unsubscribe();
      sockets.delete(ws);
    });
  });

  return {
    server,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      });
    },
    close() {
      for (const ws of [...sockets]) ws.close(1001);
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
