export type MigrateErrorCode = 'SOURCE_NOT_FOUND' | 'SOURCE_UNREADABLE' | 'WRONG_APP' | 'BUSY' | 'VALIDATION';

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
      return 404;
    case 'BUSY':
      return 409;
    default:
      return 400;
  }
}
