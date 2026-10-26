export type ProxyErrorCode = 'connect' | 'auth' | 'protocol' | 'flaresolverr' | 'timeout';

/**
 * Failure while talking to a proxy or solver. `connect` = TCP/target unreachable or refused,
 * `auth` = proxy credentials rejected, `protocol` = malformed proxy/HTTP exchange,
 * `flaresolverr` = solver failure, `timeout` = deadline passed.
 */
export class ProxyError extends Error {
  readonly code: ProxyErrorCode;

  constructor(code: ProxyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProxyError';
    this.code = code;
  }
}
