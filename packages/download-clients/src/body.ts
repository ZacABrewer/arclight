/**
 * Capped body reads for the RPC clients. A client (or something answering on its address)
 * cannot stream an endless body into memory: the read stops at the cap and the request's
 * timeout signal stays attached until the body is consumed.
 */
import { readLimited, SafeFetchError } from '@arclight/net';
import { DownloadClientError } from './types.js';

/** Largest RPC response read. Big qBittorrent / Transmission lists stay far below this. */
export const MAX_RPC_BYTES = 32 * 1024 * 1024;

export async function readBodyBytes(clientName: string, response: Response, max = MAX_RPC_BYTES): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readLimited(response, max));
  } catch (error) {
    if (error instanceof SafeFetchError && error.code === 'tooLarge') {
      throw new DownloadClientError('bad-response', `${clientName} sent a response larger than ${Math.round(max / 1024 / 1024)} MB.`, { cause: error });
    }
    throw new DownloadClientError('unreachable', `Connection to ${clientName} failed while reading the response.`, { cause: error });
  }
}

export async function readBodyText(clientName: string, response: Response, max = MAX_RPC_BYTES): Promise<string> {
  return new TextDecoder('utf-8').decode(await readBodyBytes(clientName, response, max));
}
