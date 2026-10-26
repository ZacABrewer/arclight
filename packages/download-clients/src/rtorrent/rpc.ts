import type { z } from 'zod';
import { basicAuth, httpStatusError, sendHttp, validate } from '../http.js';
import { DownloadClientError, type ClientRuntime } from '../types.js';
import {
  decodeMethodResponse,
  encodeMethodCall,
  XmlRpcFault,
  XmlRpcParseError,
  type XmlRpcDecoded,
  type XmlRpcValue,
} from './xmlrpc.js';

export const CLIENT_NAME = 'rTorrent';

/** rTorrent's fault for an unknown info-hash ("Could not find info-hash."). */
export const FAULT_UNKNOWN_HASH = -501;
/** xmlrpc-c's fault for an unknown method ("Method 'x' not defined"). */
export const FAULT_NO_SUCH_METHOD = -506;

export interface RpcSettings {
  /** Full endpoint URL, e.g. `http://nas:8080/RPC2`. */
  url: string;
  username: string;
  password: string;
}

/** Maps an XML-RPC fault to a typed error. */
export function faultError(fault: XmlRpcFault, method: string): DownloadClientError {
  const detail = `${CLIENT_NAME} fault ${fault.faultCode} for ${method}: ${fault.faultString}`;
  if (fault.faultCode === FAULT_UNKNOWN_HASH || /could not find info-hash/i.test(fault.faultString)) {
    return new DownloadClientError('not-found', detail, { cause: fault });
  }
  if (fault.faultCode === FAULT_NO_SUCH_METHOD || /method .* not defined/i.test(fault.faultString)) {
    return new DownloadClientError('bad-response', `${detail}. rTorrent 0.9.6 or newer is required.`, { cause: fault });
  }
  return new DownloadClientError('rejected', detail, { cause: fault });
}

/**
 * XML-RPC over HTTP. rTorrent itself speaks SCGI; a web server (nginx, lighttpd, the
 * ruTorrent rpc plugin, ...) bridges it to an HTTP endpoint that we POST text/xml to.
 * Authentication, when present, is HTTP Basic at the web server.
 */
export class RTorrentRpc {
  constructor(
    private readonly settings: RpcSettings,
    private readonly runtime: ClientRuntime,
  ) {}

  async call(method: string, params: readonly XmlRpcValue[] = []): Promise<XmlRpcDecoded> {
    const headers: Record<string, string> = { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml' };
    if (this.settings.username !== '' || this.settings.password !== '') {
      headers['Authorization'] = basicAuth(this.settings.username, this.settings.password);
    }
    const response = await sendHttp(this.runtime, CLIENT_NAME, this.settings.url, {
      method: 'POST',
      headers,
      body: encodeMethodCall(method, params),
    });
    const text = await response.text();
    if (!response.ok) throw httpStatusError(CLIENT_NAME, response.status, method, text);
    try {
      return decodeMethodResponse(text);
    } catch (error) {
      if (error instanceof XmlRpcFault) throw faultError(error, method);
      if (error instanceof XmlRpcParseError) {
        throw new DownloadClientError(
          'bad-response',
          `${CLIENT_NAME} returned an invalid XML-RPC response for ${method} (is the URL base pointing at the XML-RPC endpoint?): ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** Calls and validates the result against a Zod schema. */
  async callAs<T extends z.ZodType>(method: string, params: readonly XmlRpcValue[], schema: T): Promise<z.infer<T>> {
    return validate(CLIENT_NAME, method, await this.call(method, params), schema);
  }
}
