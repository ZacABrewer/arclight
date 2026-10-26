export type SolverErrorCode =
  /** No Chromium-family browser was found (or the configured path does not exist). */
  | 'no-browser'
  /** The browser could not be started or never reported its DevTools endpoint. */
  | 'launch'
  /** The DevTools connection failed or a CDP method returned an error. */
  | 'protocol'
  /** The connection to the browser closed while a request was in flight. */
  | 'closed'
  /** The page still showed a challenge when the timeout expired. */
  | 'timeout'
  /** The site refused the request outright (e.g. Cloudflare error 1020). */
  | 'blocked'
  /** Navigation failed (DNS, TLS, connection refused...). */
  | 'navigation'
  /** The command was malformed. */
  | 'bad-request';

export class SolverError extends Error {
  constructor(
    readonly code: SolverErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SolverError';
  }
}
