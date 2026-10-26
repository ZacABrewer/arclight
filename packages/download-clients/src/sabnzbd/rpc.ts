/**
 * Transport for the SABnzbd HTTP API: `<base>/api?mode=...&output=json&apikey=...`.
 *
 * SABnzbd is stateless (no session): every call carries the API key, or the legacy
 * `ma_username` / `ma_password` pair. Failures usually arrive as HTTP 200 with
 * `{"status": false, "error": "..."}`; some modes answer with plain text `error: ...`.
 */
import type { z } from 'zod';
import { httpStatusError, sendHttp, validate } from '../http.js';
import { DownloadClientError, type ClientRuntime } from '../types.js';

export const SABNZBD = 'SABnzbd';

export interface SabApiSettings {
  /** e.g. `http://nas:8080/sabnzbd` (no trailing slash). */
  baseUrl: string;
  apiKey: string;
  username: string;
  password: string;
}

export interface SabUpload {
  field: string;
  filename: string;
  bytes: Uint8Array;
  contentType: string;
}

const AUTH_ERROR = /api ?key|not logged in|login|authenticat|credential|access denied/i;

/** Maps a SABnzbd error string to a typed error. */
export function sabError(mode: string, message: string): DownloadClientError {
  const text = message.trim() || 'unknown error';
  if (AUTH_ERROR.test(text)) {
    return new DownloadClientError(
      'auth',
      `${SABNZBD} rejected the credentials for mode=${mode}: ${text}. Use the full API key from Config > General (the NZB key is not enough).`,
    );
  }
  return new DownloadClientError('rejected', `${SABNZBD} refused mode=${mode}: ${text}`);
}

export class SabnzbdApi {
  constructor(
    private readonly settings: SabApiSettings,
    private readonly runtime: ClientRuntime,
  ) {}

  /** Calls one API mode and returns the parsed JSON after SAB-level error checks. */
  async call(mode: string, params: Record<string, string> = {}, upload?: SabUpload): Promise<unknown> {
    const url = new URL(`${this.settings.baseUrl}/api`);
    url.searchParams.set('mode', mode);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('output', 'json');
    if (this.settings.apiKey !== '') url.searchParams.set('apikey', this.settings.apiKey);
    if (this.settings.username !== '') {
      url.searchParams.set('ma_username', this.settings.username);
      url.searchParams.set('ma_password', this.settings.password);
    }

    const init: RequestInit = { method: 'GET' };
    if (upload !== undefined) {
      const form = new FormData();
      // Copy into a plain ArrayBuffer so Blob accepts it regardless of the source buffer kind.
      form.append(upload.field, new Blob([upload.bytes.slice()], { type: upload.contentType }), upload.filename);
      init.method = 'POST';
      init.body = form;
    }

    const response = await sendHttp(this.runtime, SABNZBD, url, init);
    const text = await response.text();
    if (!response.ok) throw httpStatusError(SABNZBD, response.status, `mode=${mode}`, text);

    const trimmed = text.trim();
    const plainError = /^error:\s*(.*)$/is.exec(trimmed);
    if (plainError) throw sabError(mode, plainError[1] ?? '');

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (error) {
      throw new DownloadClientError('bad-response', `${SABNZBD} returned invalid JSON for mode=${mode}.`, { cause: error });
    }
    if (typeof raw === 'object' && raw !== null && (raw as { status?: unknown }).status === false) {
      const message = (raw as { error?: unknown }).error;
      throw sabError(mode, typeof message === 'string' ? message : 'unknown error');
    }
    return raw;
  }

  async callJson<T extends z.ZodType>(
    mode: string,
    schema: T,
    params: Record<string, string> = {},
    upload?: SabUpload,
  ): Promise<z.infer<T>> {
    const raw = await this.call(mode, params, upload);
    return validate(SABNZBD, `mode=${mode}`, raw, schema);
  }
}
