// Typed errors for the VPN integrations. Routes map them to HTTP in one place (routes.ts).

export type VpnErrorCode =
  /** Credentials / API key rejected (401/403). */
  | 'unauthorized'
  /** Network failure, DNS, refused connection. */
  | 'unreachable'
  | 'timeout'
  /** Unexpected status or body. */
  | 'bad-response'
  | 'not-found'
  /** wireguard.exe / wg.exe not found. */
  | 'not-installed'
  /** The tunnel service / adapter does not exist. */
  | 'tunnel-not-found'
  /** A spawned command exited non-zero. */
  | 'command-failed'
  /** Settings are incomplete or invalid for the selected provider. */
  | 'config'
  /** The action does not apply to the selected provider or platform. */
  | 'unsupported';

export class VpnError extends Error {
  override readonly name = 'VpnError';
  readonly httpStatus: number | undefined;

  constructor(
    readonly code: VpnErrorCode,
    message: string,
    options: { cause?: unknown; httpStatus?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.httpStatus = options.httpStatus;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
