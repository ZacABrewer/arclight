import type { z } from 'zod';
import { DownloadClientError, type ClientRuntime } from '../types.js';

export interface SessionSettings {
  baseUrl: string;
  username: string;
  password: string;
}

export type RequestBody = Record<string, string> | FormData;

export interface RequestOptions {
  query?: Record<string, string>;
  /** Sent as a POST. A plain record is form-urlencoded; FormData is multipart. */
  body?: RequestBody;
}

/** Builds the WebUI root, e.g. `https://nas.local:8080/qbt`. */
export function buildBaseUrl(host: string, port: number, useSsl: boolean, urlBase?: string): string {
  const trimmedHost = host.trim();
  const needsBrackets = trimmedHost.includes(':') && !trimmedHost.startsWith('[');
  const hostPart = needsBrackets ? `[${trimmedHost}]` : trimmedHost;
  let base = (urlBase ?? '').trim().replace(/^\/+|\/+$/g, '');
  base = base === '' ? '' : `/${base}`;
  return `${useSsl ? 'https' : 'http'}://${hostPart}:${port}${base}`;
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'request timed out';
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return String(error);
}

/** Extracts `name=value` pairs from Set-Cookie headers into a Cookie header value. */
function cookieHeaderFrom(response: Response): string | undefined {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=)/);
  const pairs = raw
    .map((line) => line.split(';', 1)[0]?.trim() ?? '')
    .filter((pair) => pair.includes('='));
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/**
 * Cookie-authenticated transport for the qBittorrent WebUI API v2.
 *
 * Logs in lazily, keeps the SID cookie, and on a 403 (session expired or never valid)
 * logs in again once and retries the request. When username and password are both empty
 * the session assumes qBittorrent's "bypass authentication for localhost/whitelist" is on.
 */
export class QBittorrentSession {
  private cookie: string | undefined;
  private authenticated = false;
  /** Incremented on every successful login, to detect a re-login by a concurrent request. */
  private generation = 0;
  private pendingLogin: Promise<void> | undefined;

  constructor(
    private readonly settings: SessionSettings,
    private readonly runtime: ClientRuntime,
  ) {}

  private get hasCredentials(): boolean {
    return this.settings.username !== '' || this.settings.password !== '';
  }

  /** Forgets the current session so the next request logs in again. */
  reset(): void {
    this.cookie = undefined;
    this.authenticated = false;
  }

  async login(): Promise<void> {
    // Concurrent callers share one login round trip.
    this.pendingLogin ??= this.performLogin().finally(() => {
      this.pendingLogin = undefined;
    });
    return this.pendingLogin;
  }

  private async performLogin(): Promise<void> {
    this.reset();
    const response = await this.send('/api/v2/auth/login', {
      body: { username: this.settings.username, password: this.settings.password },
    }, false);

    if (response.status === 403) {
      throw new DownloadClientError(
        'auth',
        'qBittorrent refused the login: this IP is banned after too many failed attempts.',
        { httpStatus: 403 },
      );
    }
    if (response.status === 401) {
      throw new DownloadClientError('auth', 'qBittorrent rejected the credentials.', { httpStatus: 401 });
    }
    if (response.status === 404) {
      throw new DownloadClientError(
        'not-found',
        'qBittorrent WebUI API v2 not found. qBittorrent 4.1 or newer is required; check host and URL base.',
        { httpStatus: 404 },
      );
    }
    if (!response.ok) {
      throw new DownloadClientError('bad-response', `qBittorrent login failed with HTTP ${response.status}.`, {
        httpStatus: response.status,
      });
    }
    const text = (await response.text()).trim();
    // "Ok." on success, "Fails." on bad credentials. Some versions send an empty body.
    if (text !== '' && text !== 'Ok.') {
      throw new DownloadClientError('auth', 'qBittorrent rejected the username or password.');
    }
    const cookie = cookieHeaderFrom(response);
    if (cookie === undefined && text === '') {
      throw new DownloadClientError('auth', 'qBittorrent did not issue a session cookie.');
    }
    this.cookie = cookie;
    this.authenticated = true;
    this.generation++;
  }

  /** Performs an authenticated request and returns the raw response body. */
  async requestText(path: string, options: RequestOptions = {}): Promise<string> {
    return (await this.requestOk(path, options)).text();
  }

  /** Performs an authenticated request and returns the body as bytes (e.g. an exported .torrent). */
  async requestBytes(path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    return new Uint8Array(await (await this.requestOk(path, options)).arrayBuffer());
  }

  /** An authenticated request whose response is 2xx; anything else is mapped to a DownloadClientError. */
  private async requestOk(path: string, options: RequestOptions): Promise<Response> {
    if (!this.authenticated && this.hasCredentials) await this.login();

    const generationUsed = this.generation;
    let response = await this.send(path, options, true);
    if (response.status === 403) {
      if (!this.hasCredentials) {
        throw new DownloadClientError(
          'auth',
          'qBittorrent requires authentication. Set a username and password, or enable localhost bypass.',
          { httpStatus: 403 },
        );
      }
      // Another request may already have refreshed the session while this one was in flight.
      if (this.generation === generationUsed) await this.login();
      response = await this.send(path, options, true);
      if (response.status === 403) {
        throw new DownloadClientError('auth', 'qBittorrent rejected the session after logging in again.', {
          httpStatus: 403,
        });
      }
    }

    if (response.ok) return response;
    const text = await response.text();

    const detail = text.trim() === '' ? '' : `: ${text.trim().slice(0, 200)}`;
    switch (response.status) {
      case 401:
        throw new DownloadClientError('auth', `qBittorrent returned 401 for ${path}`, { httpStatus: 401 });
      case 404:
        throw new DownloadClientError('not-found', `qBittorrent returned 404 for ${path}${detail}`, {
          httpStatus: 404,
        });
      case 409:
      case 415:
        throw new DownloadClientError('rejected', `qBittorrent rejected ${path}${detail}`, {
          httpStatus: response.status,
        });
      default:
        throw new DownloadClientError('bad-response', `qBittorrent returned HTTP ${response.status} for ${path}${detail}`, {
          httpStatus: response.status,
        });
    }
  }

  /** Performs an authenticated request and validates the JSON body against `schema`. */
  async requestJson<T extends z.ZodType>(path: string, schema: T, options: RequestOptions = {}): Promise<z.infer<T>> {
    const text = await this.requestText(path, options);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new DownloadClientError('bad-response', `qBittorrent returned invalid JSON for ${path}.`, { cause: error });
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue ? ` (${issue.path.join('.') || 'body'}: ${issue.message})` : '';
      throw new DownloadClientError('bad-response', `qBittorrent returned an unexpected shape for ${path}${where}.`, {
        cause: result.error,
      });
    }
    return result.data;
  }

  private async send(path: string, options: RequestOptions, withCookie: boolean): Promise<Response> {
    const url = new URL(this.settings.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);

    const headers: Record<string, string> = {};
    // qBittorrent's CSRF protection compares Referer/Origin with the Host when present.
    headers['Referer'] = this.settings.baseUrl;
    if (withCookie && this.cookie !== undefined) headers['Cookie'] = this.cookie;

    const init: RequestInit = {
      method: options.body === undefined ? 'GET' : 'POST',
      headers,
      signal: AbortSignal.timeout(this.runtime.requestTimeoutMs),
    };
    if (options.body instanceof FormData) {
      init.body = options.body;
    } else if (options.body !== undefined) {
      init.body = new URLSearchParams(options.body);
    }

    try {
      return await this.runtime.fetch(url, init);
    } catch (error) {
      throw new DownloadClientError(
        'unreachable',
        `Unable to reach qBittorrent at ${this.settings.baseUrl}: ${describeNetworkError(error)}`,
        { cause: error },
      );
    }
  }
}
