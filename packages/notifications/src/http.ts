/**
 * Small wrapper around `fetch` shared by the HTTP agents: injects a fake in tests, applies a
 * timeout, and maps transport failures and non-2xx responses to `NotificationError`.
 */

import { NotificationError, type NotificationAgentKind, type NotificationErrorCode } from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Treat these non-2xx statuses as success (e.g. Discord 204). All 2xx always pass. */
  acceptStatuses?: number[];
  /** How to name the target in error messages when the URL path itself carries a secret. */
  label?: string;
}

export function codeForStatus(status: number): NotificationErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimited';
  return 'remoteError';
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function hostUrl(settings: { host: string; port: number; useSsl: boolean; urlBase?: string | undefined }): string {
  const scheme = settings.useSsl ? 'https' : 'http';
  const base = settings.urlBase ? `/${settings.urlBase.replace(/^\/+|\/+$/g, '')}` : '';
  return `${scheme}://${settings.host}:${settings.port}${base}`;
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export async function httpRequest(
  fetchImpl: FetchLike,
  agent: NotificationAgentKind,
  url: string,
  options: HttpRequestOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const label = options.label ?? describeUrl(url);
  let response: Response;
  try {
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers: { 'User-Agent': 'Media-Tron', ...options.headers },
      signal: controller.signal,
    };
    if (options.body !== undefined) init.body = options.body;
    response = await fetchImpl(url, init);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new NotificationError(agent, 'timeout', `Request to ${label} timed out`, { cause: error });
    }
    throw new NotificationError(agent, 'network', `Could not reach ${label}: ${messageOf(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.ok || options.acceptStatuses?.includes(response.status)) return response;

  const snippet = await safeText(response);
  throw new NotificationError(
    agent,
    codeForStatus(response.status),
    `${label} responded ${response.status}${snippet ? `: ${snippet}` : ''}`,
    { status: response.status },
  );
}

export async function readJson<T>(response: Response, agent: NotificationAgentKind): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new NotificationError(agent, 'remoteError', 'Response was not valid JSON', { cause: error });
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

/** Host + path only: never echo query strings, which may carry tokens. */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
  return String(error);
}
