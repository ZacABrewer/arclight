import type { z } from 'zod';
import { basicAuth, buildBaseUrl, httpStatusError, parseJson, sendHttp, validate } from '../http.js';
import { DownloadClientError, type ClientRuntime } from '../types.js';
import { TrRpcEnvelope } from './schemas.js';

export const SESSION_ID_HEADER = 'X-Transmission-Session-Id';

/** `<scheme>://<host>:<port><urlBase>rpc`, e.g. `http://nas:9091/transmission/rpc`. */
export function buildRpcUrl(host: string, port: number, useSsl: boolean, urlBase: string): string {
  return `${buildBaseUrl(host, port, useSsl, urlBase)}/rpc`;
}

export interface RpcSettings {
  url: string;
  username: string;
  password: string;
}

/**
 * Transport for the Transmission JSON RPC.
 *
 * CSRF protection: the daemon answers 409 with an `X-Transmission-Session-Id` header until
 * that id is echoed back. We store it and retry the call once; the id may change at any time
 * (daemon restart), so any later 409 refreshes it the same way. HTTP Basic auth is sent on
 * every request when credentials are configured.
 */
export class TransmissionRpc {
  private sessionId: string | undefined;

  constructor(
    private readonly settings: RpcSettings,
    private readonly runtime: ClientRuntime,
    private readonly clientName = 'Transmission',
  ) {}

  reset(): void {
    this.sessionId = undefined;
  }

  async call<T extends z.ZodType>(method: string, args: Record<string, unknown>, schema: T): Promise<z.infer<T>> {
    const body = JSON.stringify({ method, arguments: args });
    let response = await this.send(body);
    if (response.status === 409) {
      this.captureSessionId(response, method);
      response = await this.send(body);
      if (response.status === 409) {
        throw new DownloadClientError('bad-response', `${this.clientName} kept rejecting the RPC session id for ${method}.`, {
          httpStatus: 409,
        });
      }
    }

    const text = await this.readBody(response, method);
    if (!response.ok) {
      if (response.status === 404) {
        throw new DownloadClientError(
          'not-found',
          `${this.clientName} RPC endpoint not found at ${this.settings.url}; check the URL base.`,
          { httpStatus: 404 },
        );
      }
      throw httpStatusError(this.clientName, response.status, method, response.status === 401 ? '' : text);
    }

    const envelope = parseJson(this.clientName, method, text, TrRpcEnvelope);
    if (envelope.result !== 'success') {
      throw new DownloadClientError('rejected', `${this.clientName} refused ${method}: ${envelope.result}`);
    }
    return validate(this.clientName, method, envelope.arguments ?? {}, schema);
  }

  private send(body: string): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.settings.username !== '' || this.settings.password !== '') {
      headers['Authorization'] = basicAuth(this.settings.username, this.settings.password);
    }
    if (this.sessionId !== undefined) headers[SESSION_ID_HEADER] = this.sessionId;
    return sendHttp(this.runtime, this.clientName, this.settings.url, { method: 'POST', headers, body });
  }

  private captureSessionId(response: Response, method: string): void {
    const id = response.headers.get(SESSION_ID_HEADER);
    if (id === null || id.trim() === '') {
      throw new DownloadClientError(
        'bad-response',
        `${this.clientName} answered 409 to ${method} without an ${SESSION_ID_HEADER} header.`,
        { httpStatus: 409 },
      );
    }
    this.sessionId = id.trim();
  }

  private async readBody(response: Response, method: string): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw new DownloadClientError('unreachable', `Connection to ${this.clientName} failed while reading ${method}.`, {
        cause: error,
      });
    }
  }
}
