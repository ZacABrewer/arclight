/**
 * Small wrapper around `fetch` shared by the HTTP agents: injects a fake in tests, applies a
 * timeout, and maps transport failures and non-2xx responses to `NotificationError`.
 */

import { readLimited } from '@arclight/net';
import { NotificationError, type NotificationAgentKind, type NotificationErrorCode } from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 30_000;
/** Largest response body a notification service may send back (they answer with a few KB). */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** How much of an error body is read for the message. */
const ERROR_SNIPPET_BYTES = 4096;

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
      headers: { 'User-Agent': 'Arclight', ...options.headers },
      signal: controller.signal,
    };
    if (options.body !== undefined) init.body = options.body;
    response = await fetchImpl(url, init);
    // The body is read here, under the same timer and with a size cap, so a remote that
    // streams slowly or endlessly cannot hold the request (or memory) open.
    if (response.ok || options.acceptStatuses?.includes(response.status)) {
      const body = await readLimited(response, MAX_RESPONSE_BYTES);
      const noBody = response.status === 204 || response.status === 205 || response.status === 304;
      return new Response(noBody ? null : new Uint8Array(body), { status: response.status, statusText: response.statusText, headers: response.headers });
    }
  } catch (error) {
    if (error instanceof NotificationError) throw error;
    if (controller.signal.aborted) {
      throw new NotificationError(agent, 'timeout', `Request to ${label} timed out`, { cause: error });
    }
    throw new NotificationError(agent, 'network', `Could not reach ${label}: ${messageOf(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

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

/** The start of an error body, for the message. Never reads more than a few KB. */
async function safeText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const timer = setTimeout(() => void reader.cancel().catch(() => undefined), 5_000);
  try {
    while (total < ERROR_SNIPPET_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // Keep what arrived.
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  const text = Buffer.concat(chunks).subarray(0, ERROR_SNIPPET_BYTES).toString('utf8');
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
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
