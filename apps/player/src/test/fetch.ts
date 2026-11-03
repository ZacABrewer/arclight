import { vi } from 'vitest';

export interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Reply = Response | { status?: number; json?: unknown } | Error;
type Handler = Reply | ((call: Call) => Reply | Promise<Reply>);

/** A fetch stand-in: routes "METHOD /path" (path after /api/v1, without the query) to handlers. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? null);
    const call = { url, method, headers, body };
    calls.push(call);
    const path = decodeURIComponent(new URL(url).pathname.replace(/^.*?\/api\/v1/, ''));
    const handler = routes[`${method} ${path}`];
    if (!handler) return json(404, { error: `no route ${method} ${path}`, code: 'NOT_FOUND' });
    const out = typeof handler === 'function' ? await handler(call) : handler;
    if (out instanceof Error) throw out;
    if (out instanceof Response) return out;
    return json(out.status ?? 200, out.json ?? null);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

export function json(status: number, data: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
