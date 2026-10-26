/**
 * Test support: a generic in-memory HTTP server behind a fake `fetch`. Per-client fakes
 * (transmission, deluge, rtorrent, sabnzbd, nzbget) build on it. Not exported from the
 * package entry point.
 */

export interface FakeFile {
  field: string;
  filename: string;
  bytes: Uint8Array;
}

export interface FakeRequest {
  method: string;
  /** URL path with the configured `stripPrefix` removed. */
  path: string;
  query: URLSearchParams;
  headers: Headers;
  /** Raw body text for string / URLSearchParams / binary bodies; '' for multipart. */
  bodyText: string;
  /** Form fields from urlencoded or multipart bodies. */
  form: Record<string, string>;
  files: FakeFile[];
}

export type FakeHttpReply =
  | Response
  | { status?: number; body?: unknown; headers?: Record<string, string> };

export type FakeHttpHandler = (request: FakeRequest) => FakeHttpReply | Promise<FakeHttpReply>;

export function toResponse(reply: FakeHttpReply): Response {
  if (reply instanceof Response) return reply;
  const body = reply.body === undefined || typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
  return new Response(body ?? '', { status: reply.status ?? 200, headers: reply.headers ?? {} });
}

export class FakeHttpServer {
  readonly requests: FakeRequest[] = [];
  /** When set, fetch rejects with this error (network failure simulation). */
  networkError: Error | undefined;
  /** URL path prefix removed before routing (simulates urlBase). */
  stripPrefix = '';
  /** Every fetched absolute URL, in order. */
  readonly urls: string[] = [];

  private readonly routes = new Map<string, FakeHttpHandler>();
  private readonly onceRoutes = new Map<string, FakeHttpHandler[]>();
  /** Runs before routing; return a reply to short-circuit (auth checks, handshakes). */
  protected guard: ((request: FakeRequest) => FakeHttpReply | undefined | Promise<FakeHttpReply | undefined>) | undefined;

  on(method: string, path: string, handler: FakeHttpHandler | FakeHttpReply): this {
    this.routes.set(`${method} ${path}`, typeof handler === 'function' ? handler : () => handler);
    return this;
  }

  once(method: string, path: string, handler: FakeHttpHandler | FakeHttpReply): this {
    const key = `${method} ${path}`;
    const list = this.onceRoutes.get(key) ?? [];
    list.push(typeof handler === 'function' ? handler : () => handler);
    this.onceRoutes.set(key, list);
    return this;
  }

  calls(path: string): FakeRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.networkError) throw this.networkError;
    const href = input instanceof Request ? input.url : input.toString();
    this.urls.push(href);
    const url = new URL(href);
    const headers = new Headers(init?.headers);
    const form: Record<string, string> = {};
    const files: FakeFile[] = [];
    let bodyText = '';
    const body = init?.body;
    if (typeof body === 'string') {
      bodyText = body;
    } else if (body instanceof URLSearchParams) {
      bodyText = body.toString();
      body.forEach((v, k) => {
        form[k] = v;
      });
    } else if (body instanceof FormData) {
      const entries: Array<[string, FormDataEntryValue]> = [];
      body.forEach((v, k) => entries.push([k, v]));
      for (const [k, v] of entries) {
        if (typeof v === 'string') form[k] = v;
        else files.push({ field: k, filename: v.name, bytes: new Uint8Array(await v.arrayBuffer()) });
      }
    } else if (body instanceof Uint8Array) {
      bodyText = new TextDecoder().decode(body);
    } else if (body instanceof Blob) {
      bodyText = await body.text();
    }
    const path = this.stripPrefix !== '' && url.pathname.startsWith(this.stripPrefix)
      ? url.pathname.slice(this.stripPrefix.length) || '/'
      : url.pathname;
    const request: FakeRequest = {
      method: init?.method ?? 'GET',
      path,
      query: url.searchParams,
      headers,
      bodyText,
      form,
      files,
    };
    this.requests.push(request);

    if (this.guard) {
      const blocked = await this.guard(request);
      if (blocked !== undefined) return toResponse(blocked);
    }

    const key = `${request.method} ${request.path}`;
    const handler = this.onceRoutes.get(key)?.shift() ?? this.routes.get(key);
    if (!handler) return new Response('Not Found', { status: 404 });
    return toResponse(await handler(request));
  };
}
