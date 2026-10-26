/**
 * Test support: an in-memory stand-in for the qBittorrent WebUI served through a fake
 * `fetch`. Not exported from the package entry point.
 */

export interface RecordedFile {
  field: string;
  filename: string;
  bytes: Uint8Array;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  form: Record<string, string>;
  files: RecordedFile[];
}

export type FakeReply =
  | Response
  | { status?: number; body?: unknown; headers?: Record<string, string> };

export type FakeHandler = (request: RecordedRequest) => FakeReply | Promise<FakeReply>;

function toResponse(reply: FakeReply): Response {
  if (reply instanceof Response) return reply;
  const body = reply.body === undefined || typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
  return new Response(body ?? '', { status: reply.status ?? 200, headers: reply.headers ?? {} });
}

export class FakeQBittorrent {
  readonly requests: RecordedRequest[] = [];
  /** The SID the fake currently accepts. Change it to simulate an expired session. */
  validSid = 'sid-1';
  /** SID handed out by the next successful login. */
  nextSid = 'sid-1';
  username = 'admin';
  password = 'secret';
  /** When false, every request is accepted without a cookie (localhost bypass). */
  requireAuth = true;
  /** When set, fetch rejects with this error (network failure simulation). */
  networkError: Error | undefined;

  private readonly routes = new Map<string, FakeHandler>();
  private readonly onceRoutes = new Map<string, FakeHandler[]>();

  constructor() {
    this.on('POST', '/api/v2/auth/login', (req) => {
      if (req.form['username'] === this.username && req.form['password'] === this.password) {
        this.validSid = this.nextSid;
        return { body: 'Ok.', headers: { 'set-cookie': `SID=${this.nextSid}; HttpOnly; SameSite=Strict; path=/` } };
      }
      return { body: 'Fails.' };
    });
    this.on('GET', '/api/v2/app/webapiVersion', () => ({ body: '2.11.2' }));
    this.on('GET', '/api/v2/app/version', () => ({ body: 'v5.0.2' }));
  }

  on(method: string, path: string, handler: FakeHandler | FakeReply): this {
    this.routes.set(`${method} ${path}`, typeof handler === 'function' ? handler : () => handler);
    return this;
  }

  /** One-shot handler consumed before the persistent route. */
  once(method: string, path: string, handler: FakeHandler | FakeReply): this {
    const key = `${method} ${path}`;
    const list = this.onceRoutes.get(key) ?? [];
    list.push(typeof handler === 'function' ? handler : () => handler);
    this.onceRoutes.set(key, list);
    return this;
  }

  /** Requests to `path`, excluding logins unless asked for. */
  calls(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.networkError) throw this.networkError;
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    const form: Record<string, string> = {};
    const files: RecordedFile[] = [];
    const body = init?.body;
    if (body instanceof URLSearchParams) {
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
    }
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/qbt/, ''),
      query: url.searchParams,
      headers,
      form,
      files,
    };
    this.requests.push(request);

    const isLogin = request.path === '/api/v2/auth/login';
    if (this.requireAuth && !isLogin) {
      const cookie = headers.get('cookie') ?? '';
      if (!cookie.split(/;\s*/).includes(`SID=${this.validSid}`)) return new Response('Forbidden', { status: 403 });
    }

    const key = `${request.method} ${request.path}`;
    const queued = this.onceRoutes.get(key);
    const handler = queued?.shift() ?? this.routes.get(key);
    if (!handler) return new Response('Not Found', { status: 404 });
    return toResponse(await handler(request));
  };
}
