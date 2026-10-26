export type MigrateErrorCode =
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_UNREADABLE'
  | 'WRONG_APP'
  | 'BUSY'
  | 'VALIDATION'
  /** API mode: the app did not answer. */
  | 'UNREACHABLE'
  /** API mode: the app rejected the API key or credentials. */
  | 'AUTH'
  | 'NOT_FOUND'
  | 'NOT_SUPPORTED';

export class MigrateError extends Error {
  constructor(
    readonly code: MigrateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MigrateError';
  }
}

export function migrateHttpStatus(code: MigrateErrorCode): number {
  switch (code) {
    case 'SOURCE_NOT_FOUND':
    case 'NOT_FOUND':
      return 404;
    case 'BUSY':
      return 409;
    // Never 401/403: those mean "your Arclight session" to the web client. A source app that
    // refuses us is an upstream problem.
    case 'UNREACHABLE':
    case 'AUTH':
      return 502;
    default:
      return 400;
  }
}
