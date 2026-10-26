import type { z } from 'zod';
import { basicAuth, buildBaseUrl, httpStatusError, parseJson, sendHttp, validate } from '../http.js';
import { DownloadClientError, type ClientRuntime } from '../types.js';
import { NzbgetRpcEnvelope } from './schemas.js';

const NAME = 'NZBGet';

export interface NzbgetRpcSettings {
  host: string;
  port: number;
  useSsl: boolean;
  urlBase?: string | undefined;
  username: string;
  password: string;
}

/**
 * NZBGet JSON-RPC transport: `POST <base>/jsonrpc` with HTTP Basic auth
 * (ControlUsername / ControlPassword). Stateless, so there is nothing to re-authenticate;
 * a 401 is always a credential problem.
 */
export class NzbgetRpc {
  readonly endpoint: string;
  private nextId = 1;

  constructor(
    private readonly settings: NzbgetRpcSettings,
    private readonly runtime: ClientRuntime,
  ) {
    this.endpoint = `${buildBaseUrl(settings.host, settings.port, settings.useSsl, settings.urlBase)}/jsonrpc`;
  }

  async call<T extends z.ZodType>(method: string, params: unknown[], schema: T): Promise<z.infer<T>> {
    const response = await sendHttp(this.runtime, NAME, this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(this.settings.username, this.settings.password),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ version: '1.1', method, params, id: this.nextId++ }),
    });
    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
      throw new DownloadClientError(
        'auth',
        `NZBGet rejected the credentials (HTTP ${response.status}). Check ControlUsername / ControlPassword; restricted or add-only users cannot be used.`,
        { httpStatus: response.status },
      );
    }

    // NZBGet reports procedure errors in the JSON body, sometimes with a 5xx status.
    let envelope: NzbgetRpcEnvelope | undefined;
    if (text.trim().startsWith('{')) {
      try {
        envelope = parseJson(NAME, method, text, NzbgetRpcEnvelope);
      } catch (error) {
        if (response.ok) throw error;
      }
    }
    if (envelope?.error) throw rpcError(method, envelope.error.message, response.status);
    if (!response.ok) throw httpStatusError(NAME, response.status, method, text);
    if (envelope === undefined) {
      throw new DownloadClientError('bad-response', `NZBGet returned a non-JSON-RPC response for ${method}.`, {
        httpStatus: response.status,
      });
    }
    return validate(NAME, method, envelope.result, schema);
  }
}

function rpcError(method: string, message: string, status: number): DownloadClientError {
  const options = status >= 400 ? { httpStatus: status } : {};
  if (/invalid procedure|unknown method|not found/i.test(message)) {
    return new DownloadClientError('not-found', `NZBGet does not know the method ${method}: ${message}`, options);
  }
  if (/access denied|unauthori[sz]ed/i.test(message)) {
    return new DownloadClientError('auth', `NZBGet denied ${method}: ${message}`, options);
  }
  return new DownloadClientError('rejected', `NZBGet rejected ${method}: ${message}`, options);
}
