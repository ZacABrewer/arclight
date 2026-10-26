import { IndexerError, type ClientOptions } from '../types.js';
import { parseResponse, type XmlNode } from './xml.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Replace the apikey query value so URLs are safe to put in errors and logs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]apikey=)[^&]*/gi, '$1REDACTED');
}

/**
 * GET a Newznab-family API URL and return the parsed XML document.
 * The API key travels only in the query string; no auth headers are sent.
 */
export async function getXml(url: string, options: ClientOptions): Promise<XmlNode> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const safeUrl = redactUrl(url);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  if (options.beforeRequest) await options.beforeRequest();

  let response: Response;
  let body: string;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
      redirect: 'follow',
      signal,
    });
    body = await response.text();
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    const timedOut = timeout.aborted;
    throw new IndexerError(
      'unreachable',
      timedOut ? `Indexer timed out (${safeUrl})` : `Could not reach indexer (${safeUrl})`,
      { cause },
    );
  }

  return parseResponse({
    status: response.status,
    body,
    safeUrl,
    hadApiKey: /[?&]apikey=[^&]/i.test(url),
  });
}
