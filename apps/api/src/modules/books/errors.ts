// Typed errors of the books module; routes map `code` to HTTP in one place (routes.ts).

export type BooksErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'UNAVAILABLE';

export class BooksError extends Error {
  constructor(
    readonly code: BooksErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BooksError';
  }

  static notFound(what: string, id: number | string): BooksError {
    return new BooksError('NOT_FOUND', `${what} ${id} not found`);
  }
}

export const BOOKS_ERROR_STATUS: Record<BooksErrorCode, number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAVAILABLE: 503,
};
