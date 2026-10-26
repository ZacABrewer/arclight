/**
 * Transport helpers shared by every client: base URLs, timeouts, network-error mapping,
 * HTTP status mapping, JSON validation, base64 and the shared settings fields.
 */
import { z } from 'zod';
import { DownloadClientError, type ClientRuntime } from './types.js';

export { buildBaseUrl } from './qbittorrent/session.js';

export function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'request timed out';
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return String(error);
}

/**
 * Sends one request with the runtime's timeout. Network failures become
 * `DownloadClientError('unreachable')`; HTTP statuses are left to the caller.
 */
export async function sendHttp(
  runtime: ClientRuntime,
  clientName: string,
  url: string | URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await runtime.fetch(url, { ...init, signal: AbortSignal.timeout(runtime.requestTimeoutMs) });
  } catch (error) {
    const origin = typeof url === 'string' ? url : url.toString();
    throw new DownloadClientError('unreachable', `Unable to reach ${clientName} at ${origin}: ${describeNetworkError(error)}`, {
      cause: error,
    });
  }
}

/** Maps a non-2xx response to a typed error. `what` names the call, e.g. "torrent-get". */
export function httpStatusError(clientName: string, status: number, what: string, body = ''): DownloadClientError {
  const detail = body.trim() === '' ? '' : `: ${body.trim().slice(0, 200)}`;
  switch (status) {
    case 401:
    case 403:
      return new DownloadClientError('auth', `${clientName} rejected the credentials (HTTP ${status}) for ${what}.`, {
        httpStatus: status,
      });
    case 404:
      return new DownloadClientError('not-found', `${clientName} returned 404 for ${what}${detail}`, { httpStatus: status });
    default:
      return new DownloadClientError('bad-response', `${clientName} returned HTTP ${status} for ${what}${detail}`, {
        httpStatus: status,
      });
  }
}

/** Parses JSON text and validates it, mapping both failures to `bad-response`. */
export function parseJson<T extends z.ZodType>(clientName: string, what: string, text: string, schema: T): z.infer<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DownloadClientError('bad-response', `${clientName} returned invalid JSON for ${what}.`, { cause: error });
  }
  return validate(clientName, what, raw, schema);
}

export function validate<T extends z.ZodType>(clientName: string, what: string, value: unknown, schema: T): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DownloadClientError('bad-response', `${clientName} returned an unexpected shape for ${what}.`, {
      cause: result.error,
    });
  }
  return result.data;
}

export function notSupported(clientName: string, what: string): DownloadClientError {
  return new DownloadClientError('not-supported', `${clientName} does not support ${what}.`);
}

/** HTTP Basic credentials header value. Handles non-ASCII via UTF-8. */
export function basicAuth(username: string, password: string): string {
  return `Basic ${toBase64(new TextEncoder().encode(`${username}:${password}`))}`;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A filesystem-safe file name for an uploaded release. */
export function releaseFileName(title: string, extension: string): string {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'release';
  return `${safe}.${extension}`;
}

/** Seconds to `etaSeconds`: negative or absurd (over a year) means unknown. */
export function normalizeEta(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0 || seconds > 365 * 24 * 3600) return undefined;
  return Math.floor(seconds);
}

// ---------------------------------------------------------------------------------------
// Settings fields shared by the per-client Zod schemas. Each schema spreads the ones it uses
// so `.describe()` texts stay consistent across the UI.
// ---------------------------------------------------------------------------------------

export const hostField = z.string().trim().min(1).describe('Hostname or IP address of the download client.');
export const portField = (defaultPort: number) =>
  z.number().int().min(1).max(65535).default(defaultPort).describe('Port the client\'s web interface or API listens on.');
export const useSslField = z.boolean().default(false).describe('Connect over HTTPS.');
export const urlBaseField = (example: string) =>
  z.string().trim().optional().describe(`Path prefix when the client sits behind a reverse proxy or uses a non-default RPC path, e.g. "${example}".`);
export const usernameField = z.string().default('').describe('Username, if the client requires authentication.');
export const passwordField = z.string().default('').describe('Password. Write-only: never returned by the API.');
export const categoryField = (defaultCategory: string, noun: string) =>
  z
    .string()
    .trim()
    .default(defaultCategory)
    .describe(`${noun} Media-Tron assigns to its downloads, keeping them apart from everything else. Leave empty to not use one.`);
export const postImportCategoryField = (noun: string) =>
  z.string().trim().optional().describe(`${noun} to move a download to after Media-Tron has imported it. Leave empty to keep it unchanged.`);
export const addPausedField = z.boolean().default(false).describe('Add downloads in a paused state.');
